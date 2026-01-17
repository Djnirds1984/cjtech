#!/bin/bash

# PPPoE Server Control Script
# Usage: ./init_pppoe_server.sh [start|stop|restart] [interface] [local_ip] [remote_ip_start] [remote_count] [dns1] [dns2]

ACTION=${1:-start}
IFACE=${2:-br0}
LOCAL_IP=${3:-10.10.10.1}
REMOTE_START=${4:-10.10.10.2}
REMOTE_COUNT=${5:-50} # Number of IPs to hand out
DNS1=${6:-8.8.8.8}
DNS2=${7:-8.8.4.4}
WAN_IFACE=${8:-eth0}

OPTIONS_FILE="/etc/ppp/pppoe-server-options"
PID_FILE="/var/run/pppoe-server.pid"

start_server() {
    echo "Starting PPPoE Server on $IFACE with WAN $WAN_IFACE..."

    # Ensure Kernel Modules
    modprobe pppoe
    modprobe pppox
    modprobe ppp_generic

    # Create Options File
    cat > $OPTIONS_FILE <<EOF
# PPPoE Server Options
require-chap
login
lcp-echo-interval 10
lcp-echo-failure 2
ms-dns $DNS1
ms-dns $DNS2
netmask 255.255.255.0
default-asyncmap
EOF

    # Ensure IP forwarding
    echo 1 > /proc/sys/net/ipv4/ip_forward

    # Stop existing if any
    killall pppoe-server > /dev/null 2>&1

    # Start Server
    # -I : Interface
    # -L : Local IP
    # -R : Remote IP Start
    # -N : Number of IPs
    # -O : Options file
    pppoe-server -I $IFACE -L $LOCAL_IP -R $REMOTE_START -N $REMOTE_COUNT -O $OPTIONS_FILE

    if [ $? -eq 0 ]; then
        echo "PPPoE Server started successfully."
        # Add firewall rule to allow forwarding from ppp+ interfaces
        iptables -I FORWARD -i ppp+ -j ACCEPT
        iptables -I FORWARD -o ppp+ -j ACCEPT
        iptables -t nat -A POSTROUTING -s ${LOCAL_IP%.*}.0/24 -o $WAN_IFACE -j MASQUERADE
    else
        echo "Failed to start PPPoE Server."
        exit 1
    fi
}

stop_server() {
    echo "Stopping PPPoE Server..."
    killall pppoe-server > /dev/null 2>&1
    # Clean up firewall rules (simplistic, might need more specific cleanup)
    # iptables -D FORWARD -i ppp+ -j ACCEPT 2>/dev/null
    # iptables -D FORWARD -o ppp+ -j ACCEPT 2>/dev/null
}

case "$ACTION" in
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    restart)
        stop_server
        sleep 2
        start_server
        ;;
    *)
        echo "Usage: $0 {start|stop|restart} ..."
        exit 1
esac
