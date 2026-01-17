#!/bin/bash

# Configuration
IPSET_ACCEPT="wg_accept"
IPSET_DROP="wg_drop"
DNSMASQ_DIR="/etc/dnsmasq.d"

command=$1
domain=$2
type=$3

init() {
    # Create IP sets if they don't exist
    ipset create $IPSET_ACCEPT hash:ip -exist
    ipset create $IPSET_DROP hash:ip -exist

    # Detect LAN interfaces dynamically (bridge + VLAN interfaces)
    LAN_IFS=""

    if ip link show br0 > /dev/null 2>&1; then
        LAN_IFS="br0"
    fi

    for dev in $(ip -o link show | awk -F': ' '{print $2}' | cut -d'@' -f1); do
        if [ "$dev" = "lo" ] || [ "$dev" = "br0" ]; then
            continue
        fi
        case "$dev" in
            *.*)
                LAN_IFS="$LAN_IFS $dev"
                ;;
        esac
    done

    # Add iptables rules for each interface
    for LAN_IF in $LAN_IFS; do
        # 1. DROP Rule (Blacklist) - Top of FORWARD
        iptables -C FORWARD -i $LAN_IF -m set --match-set $IPSET_DROP dst -j DROP 2>/dev/null
        if [ $? -ne 0 ]; then
            iptables -I FORWARD 1 -i $LAN_IF -m set --match-set $IPSET_DROP dst -j DROP
        fi

        # 2. ACCEPT Rule (Walled Garden) - Allow forwarding
        iptables -C FORWARD -i $LAN_IF -m set --match-set $IPSET_ACCEPT dst -j ACCEPT 2>/dev/null
        if [ $? -ne 0 ]; then
            iptables -I FORWARD 1 -i $LAN_IF -m set --match-set $IPSET_ACCEPT dst -j ACCEPT
        fi

        # 3. ACCEPT Rule (Walled Garden) - Bypass NAT Redirection (Captive Portal)
        iptables -t nat -C PREROUTING -i $LAN_IF -m set --match-set $IPSET_ACCEPT dst -j ACCEPT 2>/dev/null
        if [ $? -ne 0 ]; then
            iptables -t nat -I PREROUTING 1 -i $LAN_IF -m set --match-set $IPSET_ACCEPT dst -j ACCEPT
        fi
    done

    echo "Walled Garden initialized on $LAN_IFS"
}

add() {
    if [ -z "$domain" ] || [ -z "$type" ]; then
        echo "Usage: add <domain> <type>"
        exit 1
    fi

    local set_name=""
    if [ "$type" == "ACCEPT" ]; then
        set_name=$IPSET_ACCEPT
    elif [ "$type" == "DROP" ]; then
        set_name=$IPSET_DROP
    else
        echo "Invalid type. Use ACCEPT or DROP."
        exit 1
    fi

    # Create dnsmasq config for this domain
    # ipset=/domain.com/wg_accept
    echo "ipset=/$domain/$set_name" > "$DNSMASQ_DIR/wg_$domain.conf"

    # Reload dnsmasq to apply
    systemctl reload dnsmasq || /etc/init.d/dnsmasq reload
    
    # Resolve and add immediately for instant effect
    # We use 'dig' or 'nslookup' or 'getent' or 'ping' to find IPs
    echo "Resolving $domain..." >> /var/log/walled_garden.log
    
    # Try using getent ahosts first (usually standard)
    if command -v getent >/dev/null; then
        getent ahosts "$domain" | awk '{print $1}' | sort -u | while read -r ip; do
             # Filter IPv4 only (ipset hash:ip is IPv4 usually)
             if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                 echo "Adding $ip to $set_name (getent)" >> /var/log/walled_garden.log
                 ipset add $set_name $ip -exist
             fi
        done
    fi

    # Try nslookup (Standard & BusyBox support)
    if command -v nslookup >/dev/null; then
         # Matches "Address: 1.2.3.4" and "Address 1: 1.2.3.4"
         nslookup "$domain" | awk '/^Address/ { print $NF }' | while read -r ip; do
             if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                 echo "Adding $ip to $set_name (nslookup)" >> /var/log/walled_garden.log
                 ipset add $set_name $ip -exist
             fi
         done
    fi

    # Try dig (Best if available)
    if command -v dig >/dev/null; then
         dig +short "$domain" | while read -r ip; do
             if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                 echo "Adding $ip to $set_name (dig)" >> /var/log/walled_garden.log
                 ipset add $set_name $ip -exist
             fi
         done
    fi
    
    echo "Added $domain to $type list."
}

remove() {
    if [ -z "$domain" ]; then
        echo "Usage: remove <domain>"
        exit 1
    fi

    # Remove config file
    rm -f "$DNSMASQ_DIR/wg_$domain.conf"

    # Reload dnsmasq
    systemctl reload dnsmasq || /etc/init.d/dnsmasq reload

    echo "Removed $domain."
}

flush() {
    # Remove all wg config files
    rm -f $DNSMASQ_DIR/wg_*.conf
    
    # Flush ipsets
    ipset flush $IPSET_ACCEPT
    ipset flush $IPSET_DROP
    
    # Reload dnsmasq
    systemctl reload dnsmasq || /etc/init.d/dnsmasq reload
    
    echo "Flushed all entries."
}

case $command in
    init)
        init
        ;;
    add)
        add
        ;;
    remove)
        remove
        ;;
    flush)
        flush
        ;;
    *)
        echo "Usage: $0 {init|add|remove|flush}"
        exit 1
        ;;
esac
