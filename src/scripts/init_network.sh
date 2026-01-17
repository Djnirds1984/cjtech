#!/bin/bash

# Configuration
WAN_IF="${1:-eth0}"
PORTAL_IP="${2:-10.0.0.1}"
BRIDGE_IF="br0"

echo "Initializing Network Bridge..."

# 0. Preparation: Unblock WiFi and kill conflicting supplicants
rfkill unblock wifi 2>/dev/null || true
# Kill wpa_supplicant if it's running (it interferes with AP mode)
# Only do this if we are sure we don't need it for WAN (e.g. wlan0 is WAN?)
# Assuming wlan0 is LAN/AP for PisoWifi.
killall wpa_supplicant 2>/dev/null || true

# Disable NetworkManager for WiFi and USB Ethernet interfaces if present
if command -v nmcli >/dev/null 2>&1; then
    # WiFi
    WIFI_IFS=$(ls /sys/class/net/wl* 2>/dev/null)
    for IF in $WIFI_IFS; do
        echo "Setting $IF as unmanaged by NetworkManager..."
        nmcli dev set $IF managed no 2>/dev/null || true
    done
    
    # USB Ethernet (enx*)
    USB_ETH_IFS=$(ls /sys/class/net/enx* 2>/dev/null)
    for IF in $USB_ETH_IFS; do
        echo "Setting $IF as unmanaged by NetworkManager..."
        nmcli dev set $IF managed no 2>/dev/null || true
    done
fi

# 1. Wait for WLAN interface (Optional - skip if not present)
echo "Checking for wireless interface..."
WIFI_IF=""
# Wait max 10s for USB WiFi to initialize (reduced from 45s)
for i in {1..10}; do
    # Check for wlan* OR wlx* (USB WiFi)
    if ls /sys/class/net/wlan* 1> /dev/null 2>&1; then
        WIFI_IF=$(ls /sys/class/net/wlan* | head -n 1)
        echo "Wireless interface found: $WIFI_IF"
        break
    elif ls /sys/class/net/wlx* 1> /dev/null 2>&1; then
        WIFI_IF=$(ls /sys/class/net/wlx* | head -n 1)
        echo "Wireless interface found: $WIFI_IF"
        break
    fi
    echo "Waiting for WiFi device... ($i/10)"
    sleep 1
done

if [ -z "$WIFI_IF" ]; then
    echo "⚠️ No wireless interface found. Skipping WiFi-specific setup."
    echo "Assuming Ethernet-only mode or external AP."
fi

# 1. Create Bridge if not exists
if ! ip link show "$BRIDGE_IF" > /dev/null 2>&1; then
    ip link add name "$BRIDGE_IF" type bridge || brctl addbr "$BRIDGE_IF"
    echo "Created bridge $BRIDGE_IF"
fi
ip link set "$BRIDGE_IF" type bridge stp_state 1
ip link set "$BRIDGE_IF" type bridge forward_delay 4

# 2. Detect LAN Interfaces (Exclude WAN, lo, and the bridge itself)
# Get all interfaces
ALL_IFS=$(ls /sys/class/net/)

for IF in $ALL_IFS; do
    # Skip Loopback, WAN, Bridge
    if [ "$IF" == "lo" ] || [ "$IF" == "$WAN_IF" ] || [ "$IF" == "$BRIDGE_IF" ]; then
        continue
    fi

    # Skip VLAN interfaces here; they are managed as separate L3 interfaces
    # and may have their own DHCP scopes via Netplan/dnsmasq.d
    case "$IF" in
        *.*)
            echo "Skipping VLAN interface: $IF"
            continue
            ;;
    esac

    # Filter for Physical Interfaces only to avoid bridging Docker/Virtual adapters
    # Allow: wlan* (Wi-Fi), eth* (Ethernet), enx* (USB Ethernet), wlx* (USB Wi-Fi)
    if [[ "$IF" != wlan* ]] && [[ "$IF" != eth* ]] && [[ "$IF" != enx* ]] && [[ "$IF" != wlx* ]]; then
        echo "Skipping likely virtual interface: $IF"
        continue
    fi

    echo "Adding $IF to bridge..."
    
    # Robust Interface Addition (Down -> Master -> Up)
    # Ensure interface is clean before adding
    ip link set $IF down
    ip addr flush dev $IF
    
    # Add to bridge (try ip link, fallback to brctl)
    if ! ip link set $IF master $BRIDGE_IF 2>/dev/null; then
        brctl addif $BRIDGE_IF $IF 2>/dev/null
    fi
    
    # Bring up
    ip link set $IF up promisc on
done

# Wait for interfaces to settle
sleep 2

# 3. Configure Bridge IP
ip addr flush dev $BRIDGE_IF
ip addr add $PORTAL_IP/24 dev $BRIDGE_IF
ip link set $BRIDGE_IF up
sleep 2

# 4. Enable IP Forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

echo "Network Bridge $BRIDGE_IF configured with IP $PORTAL_IP"

# 5. Ensure Hostapd is running (if installed)
# Restarting hostapd ensures it binds correctly to the bridge/interface
if systemctl list-unit-files | grep -q hostapd; then
    echo "Restarting Hostapd..."
    systemctl restart hostapd || true
    sleep 5
    if ! systemctl is-active --quiet hostapd; then
        echo "Hostapd failed to start. Retrying..."
        systemctl restart hostapd || true
    fi
fi
