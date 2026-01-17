#!/bin/bash

# Configuration
LAN_IF="br0"  # Listen on the Bridge
PORTAL_IP="${1:-10.0.0.1}"

# Calculate DHCP Range based on IP (Assumes /24)
PREFIX=$(echo $PORTAL_IP | cut -d'.' -f1-3)
DHCP_RANGE="${PREFIX}.10,${PREFIX}.250,12h"

# 1. Ensure Bridge IP is set (Redundant safety check)
ip addr show $LAN_IF | grep $PORTAL_IP || ip addr add $PORTAL_IP/24 dev $LAN_IF
ip link set $LAN_IF up

# 2. Stop conflicting services (systemd-resolved)
systemctl stop systemd-resolved
systemctl disable systemd-resolved
# Unlink resolv.conf if it points to systemd-resolved
if [ -L /etc/resolv.conf ]; then
    rm /etc/resolv.conf
    echo "nameserver 8.8.8.8" > /etc/resolv.conf
fi

# 3. Create Dnsmasq Config
cat > /etc/dnsmasq.conf <<EOF
# Run as root to allow ipset updates
user=root
# Listen on all interfaces to support VLANs
# interface=$LAN_IF
# bind-interfaces
dhcp-range=$DHCP_RANGE
dhcp-authoritative
domain-needed
bogus-priv
# Do NOT resolve everything to portal. Allow real DNS resolution.
# address=/#/$PORTAL_IP
# Only resolve local portal domain to local IP
address=/pisowifi.local/$PORTAL_IP
address=/portal/$PORTAL_IP
server=8.8.8.8
server=8.8.4.4
domain=pisowifi.local
dhcp-option=3,$PORTAL_IP
dhcp-option=6,$PORTAL_IP
# RFC 8908 Captive Portal API
dhcp-option=114,http://$PORTAL_IP/portal
conf-dir=/etc/dnsmasq.d
log-queries
log-dhcp
EOF

# Ensure config directory exists
mkdir -p /etc/dnsmasq.d

# 4. Restart Dnsmasq
killall dnsmasq 2>/dev/null || true
systemctl restart dnsmasq || /etc/init.d/dnsmasq restart

echo "DNSmasq initialized on $LAN_IF. All DNS queries redirected to $PORTAL_IP"
