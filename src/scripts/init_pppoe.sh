#!/bin/bash

IFACE=$1
USER=$2
PASS=$3
ACTION=${4:-start} # start, stop, or configure
DNS1=$5
DNS2=$6

PEER_NAME="pisowifi-provider"

# Function to write configuration
write_config() {
    echo "Writing PPPoE configuration for $IFACE..."

    # Ensure /etc/ppp/peers exists
    mkdir -p /etc/ppp/peers

    # 1. Create Peer Config
    # Using standard linux pppd options with optimizations for stability
    cat > /etc/ppp/peers/$PEER_NAME <<EOF
plugin rp-pppoe.so $IFACE
user "$USER"
noipdefault
defaultroute
replacedefaultroute
persist
maxfail 0
lcp-echo-interval 30
lcp-echo-failure 4
mtu 1492
mru 1492
noauth
hide-password
debug
EOF

    # Handle DNS
    if [ -n "$DNS1" ]; then
        echo "Using Custom DNS: $DNS1 $DNS2"
        echo "nameserver $DNS1" > /etc/resolv.conf
        if [ -n "$DNS2" ]; then
            echo "nameserver $DNS2" >> /etc/resolv.conf
        fi
    else
        echo "usepeerdns" >> /etc/ppp/peers/$PEER_NAME
    fi

    # 2. Update Secrets
    # Remove existing entry for this user to avoid duplicates
    sed -i "/^\"$USER\"/d" /etc/ppp/chap-secrets
    sed -i "/^\"$USER\"/d" /etc/ppp/pap-secrets

    # Add new secrets
    echo "\"$USER\" * \"$PASS\" *" >> /etc/ppp/chap-secrets
    echo "\"$USER\" * \"$PASS\" *" >> /etc/ppp/pap-secrets
}

if [ "$ACTION" == "stop" ]; then
    echo "Stopping PPPoE..."
    # Try multiple ways to stop
    poff $PEER_NAME > /dev/null 2>&1 || true
    killall pppd > /dev/null 2>&1 || true
    rm -f /var/run/ppp0.pid
    exit 0
fi

if [ -z "$IFACE" ] || [ -z "$USER" ] || [ -z "$PASS" ]; then
    echo "Usage: $0 <interface> <user> <password> [start|stop|configure] [dns1] [dns2]"
    exit 1
fi

if [ "$ACTION" == "configure" ]; then
    write_config
    echo "PPPoE configuration written."
    exit 0
fi

# START ACTION
echo "Configuring and Starting PPPoE for $IFACE..."

# Ensure physical interface is UP and promiscuous
ip link set $IFACE up
ip link set $IFACE promisc on

# Write config (idempotent)
write_config

# 3. Start PPPoE
echo "Starting PPPoE connection..."

# Use 'updetach' to wait for connection to be established
# This allows us to catch immediate authentication errors
pppd call $PEER_NAME updetach

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "PPPoE connection established successfully."
    ip link show ppp0
else
    echo "PPPoE connection FAILED with exit code $EXIT_CODE."
    echo "Check system logs (journalctl -xe) or /var/log/syslog for details."
    exit $EXIT_CODE
fi
