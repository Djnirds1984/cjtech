#!/bin/bash

# Configuration
# Use first argument as WAN_IF, default to eth0 if not set
WAN_IF="${1:-eth0}"      
# Use second argument as PORTAL_IP, default to 10.0.0.1
PORTAL_IP="${2:-10.0.0.1}"

# Calculate Subnet (Assume /24) - e.g. 10.0.0.1 -> 10.0.0.0/24
SUBNET="${PORTAL_IP%.*}.0/24"

PORTAL_PORT="3000"

# Detect LAN interfaces dynamically (bridge + VLAN interfaces)
LAN_IFS=""

# Add bridge if present
if ip link show br0 > /dev/null 2>&1; then
    LAN_IFS="br0"
fi

# Add all VLAN interfaces (names containing a dot, like eth0.300), excluding WAN and loopback
for dev in $(ip -o link show | awk -F': ' '{print $2}' | cut -d'@' -f1); do
    if [ "$dev" = "lo" ] || [ "$dev" = "$WAN_IF" ] || [ "$dev" = "br0" ]; then
        continue
    fi
    case "$dev" in
        *.*)
            LAN_IFS="$LAN_IFS $dev"
            ;;
    esac
done

echo "Initializing Firewall with WAN: $WAN_IF and LAN Interfaces:$LAN_IFS"

# 1. Enable IP Forwarding
# Critical for routing traffic between LAN and WAN
sysctl -w net.ipv4.ip_forward=1 > /dev/null
echo 1 > /proc/sys/net/ipv4/ip_forward

# 2. Flush existing rules
iptables -F
iptables -t nat -F
iptables -t mangle -F
iptables -X

# Set Default Policies
iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
iptables -P FORWARD ACCEPT

# 3. Create a chain for authorized users
iptables -t mangle -N internet_users

# 3.1 Create a chain for traffic accounting
# We use the FILTER table's FORWARD chain for this, as it sees packets in both directions after routing decision
iptables -N traffic_acct
iptables -I FORWARD -j traffic_acct

# 4. Allow authorized users (MARK packets with 0x1)
# Users added to this chain will be marked as "Authorized"
# The default policy of this chain is to return (do nothing), effectively blocking unless matched.

# 5. NAT (Masquerade) - Share internet from WAN to LAN
# Loop through ALL LAN interfaces to apply NAT for their subnets
for IFACE in $LAN_IFS; do
    # Get IP/CIDR (e.g., 10.0.30.1/24)
    IF_IP_CIDR=$(ip -o -4 addr show $IFACE | awk '{print $4}' | head -n 1)
    
    if [ -n "$IF_IP_CIDR" ]; then
        echo "Enabling NAT for interface $IFACE (Subnet: $IF_IP_CIDR)"
        # Apply Masquerade for traffic originating from this subnet
        iptables -t nat -A POSTROUTING -s $IF_IP_CIDR ! -d $IF_IP_CIDR -j MASQUERADE
    fi
done

# Backup rule: Masquerade anything going out the WAN interface (for the router itself or unassigned subnets)
iptables -t nat -A POSTROUTING -o $WAN_IF -j MASQUERADE

# 5.1 Ensure Established connections are always allowed (Performance + Reliability)
iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# --- APPLY RULES FOR ALL LAN INTERFACES ---
for IFACE in $LAN_IFS; do
    echo "Applying rules for interface: $IFACE"
    
    # 3. Add to internet_users chain (Marking)
    iptables -t mangle -A PREROUTING -i $IFACE -j internet_users

    # 6. Captive Portal Redirection
    # Force DNS to local server
    iptables -t nat -A PREROUTING -i $IFACE -p udp --dport 53 -j DNAT --to-destination $PORTAL_IP:53
    iptables -t nat -A PREROUTING -i $IFACE -p tcp --dport 53 -j DNAT --to-destination $PORTAL_IP:53

    # Redirect HTTP requests (TCP 80) from UNMARKED packets to the local portal
    iptables -t nat -A PREROUTING -i $IFACE -p tcp --dport 80 -m mark ! --mark 99 -j REDIRECT --to-port $PORTAL_PORT

    # Redirect DIRECT requests to Portal IP
    iptables -t nat -A PREROUTING -i $IFACE -d $PORTAL_IP -p tcp --dport 80 -j REDIRECT --to-port $PORTAL_PORT

    # 7. DNS & Portal Input
    iptables -A INPUT -i $IFACE -p udp --dport 53 -j ACCEPT
    iptables -A INPUT -i $IFACE -p tcp --dport 53 -j ACCEPT
    iptables -A INPUT -i $IFACE -p tcp --dport $PORTAL_PORT -j ACCEPT

    # 8. Block everything else for unauthorized users
    iptables -A FORWARD -i $IFACE -m mark ! --mark 99 -j DROP
done
# ------------------------------------------

# Redirect HTTP (80) traffic destined for ANY local IP (WAN/VPN/LAN) to Portal Port (3000)
# This allows remote access via http://<ip>/admin without :3000
iptables -t nat -A PREROUTING -p tcp --dport 80 -m addrtype --dst-type LOCAL -j REDIRECT --to-port $PORTAL_PORT

echo "Firewall initialized. Walled Garden active on: $LAN_IFS"
