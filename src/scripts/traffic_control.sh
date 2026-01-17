#!/bin/bash
# Traffic Control Script for Piso Wifi
# Usage:
#   init <wan_iface> <lan_iface>
#   limit <lan_iface> <ip> <down_kbps> <up_kbps>
#   unlimit <lan_iface> <ip>
#   status <iface>

LOG_FILE="/var/log/pisowifi/traffic_control.log"
mkdir -p /var/log/pisowifi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $@" >> $LOG_FILE
}

COMMAND=$1

# Helper to run tc and log errors
run_tc() {
    log "Exec: tc $@"
    OUTPUT=$(tc "$@" 2>&1)
    RET=$?
    if [ $RET -ne 0 ]; then
        log "Error ($RET): $OUTPUT"
    fi
    return $RET
}

# Check if tc exists
if ! command -v tc &> /dev/null; then
    log "CRITICAL: 'tc' command not found. Traffic control will not work."
    echo "tc command not found"
    exit 1
fi

if [ "$COMMAND" == "init" ]; then
    WAN_IFACE=$2
    LAN_IFACE=$3
    
    log "Initializing QoS on WAN:$WAN_IFACE LAN:$LAN_IFACE"
    echo "Initializing QoS..."
    
    # 1. WAN Interface (Upload QoS & Bufferbloat Mitigation)
    # Clear existing
    run_tc qdisc del dev $WAN_IFACE root
    # Apply CAKE for fair queuing and bufferbloat mitigation on Internet link
    # 'nat' keyword helps CAKE see behind NAT
    run_tc qdisc add dev $WAN_IFACE root cake bandwidth 100mbit nat

    # 2. LAN Interface (Download Limiting to Clients)
    # Clear existing
    run_tc qdisc del dev $LAN_IFACE root
    run_tc qdisc del dev $LAN_IFACE ingress

    # Add HTB root for download shaping
    # r2q=10 helps with quantum calculation for low rates
    run_tc qdisc add dev $LAN_IFACE root handle 1: htb default 10 r2q 10
    # Default class (unlimited/system traffic)
    run_tc class add dev $LAN_IFACE parent 1: classid 1:10 htb rate 1000mbit ceil 1000mbit
    
    # Add Ingress qdisc for upload limiting (policing)
    run_tc qdisc add dev $LAN_IFACE handle ffff: ingress

    echo "QoS Initialized."
    exit 0
fi

if [ "$COMMAND" == "limit" ]; then
    IFACE=$2
    RAW_IP=$3
    DOWN_KBPS=$4
    UP_KBPS=$5
    
    # Sanitize IP: Remove ::ffff: prefix if present (Node.js often passes IPv4-mapped IPv6)
    IP=${RAW_IP#*::ffff:}
    
    # Generate a unique class ID based on IP last octet (simple approach for /24)
    # Assumes IPv4 like 10.0.0.X
    ID=$(echo $IP | awk -F. '{print $4}')
    CLASS_ID="1:$ID"
    HANDLE_ID="800::$ID"

    log "Limiting $IP -> Down: ${DOWN_KBPS}kbps, Up: ${UP_KBPS}kbps (Class: $CLASS_ID)"
    echo "Limiting $IP -> Down: ${DOWN_KBPS}kbps, Up: ${UP_KBPS}kbps"

    # --- DOWNLOAD (HTB Class on Egress) ---
    # Remove old class/filter if exists
    run_tc filter del dev $IFACE protocol ip parent 1: prio 1 handle $HANDLE_ID u32
    run_tc class del dev $IFACE parent 1: classid $CLASS_ID

    # Add class
    # burst 15k is reasonable for modern rates
    run_tc class add dev $IFACE parent 1: classid $CLASS_ID htb rate ${DOWN_KBPS}kbit ceil ${DOWN_KBPS}kbit burst 15k cburst 15k
    
    # Add leaf qdisc (fq_codel) for better latency/fairness within the user's slice
    run_tc qdisc add dev $IFACE parent $CLASS_ID handle $ID: fq_codel quantum 300 limit 1024 noecn

    # Add filter (Target IP)
    run_tc filter add dev $IFACE protocol ip parent 1: prio 1 handle $HANDLE_ID u32 match ip dst $IP flowid $CLASS_ID
    
    # --- UPLOAD (Ingress Policing) ---
    # Remove old filter (using handle/prio matching is tricky with hashing, so we try specific match removal if possible, 
    # but for simplicity in this script we often rely on recreating or specific handles if we tracked them better.
    # Here we try to delete by matching the src IP again which `tc` supports in some versions, or we just add.
    # NOTE: `tc filter del` by match is not always reliable. Best practice is to use handle.
    # We will generate a handle for upload filter too based on IP to make it deletable.
    
    # Handle for upload filter (ingress) - using same ID logic
    UP_HANDLE="800::$ID"
    
    # Try delete existing ingress filter for this IP
    run_tc filter del dev $IFACE parent ffff: protocol ip prio 50 handle $UP_HANDLE u32

    # Add filter (Source IP)
    # Police action drops packets exceeding rate
    # Increased burst to allow TCP window scaling to work better
    # We assign a handle so we can delete it later
    run_tc filter add dev $IFACE parent ffff: protocol ip prio 50 handle $UP_HANDLE u32 match ip src $IP police rate ${UP_KBPS}kbit burst 50k drop flowid :1

    exit 0
fi

if [ "$COMMAND" == "unlimit" ]; then
    IFACE=$2
    RAW_IP=$3
    
    # Sanitize IP
    IP=${RAW_IP#*::ffff:}
    
    ID=$(echo $IP | awk -F. '{print $4}')
    CLASS_ID="1:$ID"
    HANDLE_ID="800::$ID"
    UP_HANDLE="800::$ID"

    log "Removing limits for $IP"
    echo "Removing limits for $IP"

    # Remove Download rules
    run_tc filter del dev $IFACE protocol ip parent 1: prio 1 handle $HANDLE_ID u32
    run_tc class del dev $IFACE parent 1: classid $CLASS_ID

    # Remove Upload rules
    run_tc filter del dev $IFACE parent ffff: protocol ip prio 50 handle $UP_HANDLE u32

    exit 0
fi

if [ "$COMMAND" == "status" ]; then
    IFACE=$2
    echo "--- TC Class Status for $IFACE ---"
    tc -s class show dev $IFACE
    echo "--- TC Filter Status for $IFACE ---"
    tc -s filter show dev $IFACE
    exit 0
fi

if [ "$COMMAND" == "mode" ]; then
    WAN_IFACE=$2
    LAN_IFACE=$3
    MODE=$4
    
    log "Switching QoS Mode to: $MODE"
    echo "Switching QoS Mode to: $MODE"
    
    # Defaults
    CAKE_OPTS="bandwidth 100mbit nat"
    
    case $MODE in
        "gaming")
            # Diffserv4 (4 tins) prioritizes gaming traffic (DSCP EF/CS5/CS4)
            # ack-filter aggressively filters small ACKs to save upload
            # wash strips extra DSCP to ensure only trusted traffic is prioritized
            CAKE_OPTS="bandwidth 100mbit nat diffserv4 ack-filter wash"
            ;;
        "family")
            # Standard fair queuing, besteffort for most
            # No specific prioritization, fair sharing is key
            CAKE_OPTS="bandwidth 100mbit nat besteffort"
            ;;
        "enterprise")
            # Strict, maybe conservative bandwidth to ensure reliability
            # Wash strips extra DSCP to ensure fairness unless trusted
            # Reserved bandwidth for VoIP/Video (simulated via strict shaping)
            CAKE_OPTS="bandwidth 90mbit nat wash"
            ;;
        "green")
            # Conservative bandwidth to reduce bufferbloat and energy (simulated)
            # Limits peak power usage by capping throughput
            CAKE_OPTS="bandwidth 80mbit nat"
            ;;
    esac
    
    # Re-apply WAN Qdisc
    run_tc qdisc del dev $WAN_IFACE root
    run_tc qdisc add dev $WAN_IFACE root cake $CAKE_OPTS
    
    echo "QoS Mode Applied: $MODE ($CAKE_OPTS)"
    exit 0
fi

if [ "$COMMAND" == "rage" ]; then
    WAN_IFACE=$2
    DURATION=$3 # Seconds
    
    log "!!! RAGE MODE ACTIVATED !!! Duration: $DURATION s"
    echo "!!! RAGE MODE ACTIVATED !!!"
    
    # 1. Boost Priority for Gaming Traffic (DSCP EF/CS5)
    # We use 'diffserv4' which already prioritizes these, but we can relax bandwidth limits slightly
    # or ensure 'wash' is off to allow client DSCP tags
    
    # Re-apply CAKE with optimized settings for pure latency, ignoring fairness slightly
    # 'nonat' is not an option if we need NAT, but we can use 'ack-filter' aggressively
    # We remove 'wash' to trust client DSCP tags (assuming the game sets them)
    CAKE_OPTS="bandwidth 100mbit nat diffserv4 ack-filter"
    
    run_tc qdisc del dev $WAN_IFACE root
    run_tc qdisc add dev $WAN_IFACE root cake $CAKE_OPTS
    
    # 2. Wait for duration
    sleep $DURATION
    
    # 3. Revert to standard Gaming mode (safe default)
    log "Rage Mode Ended. Reverting to standard gaming mode."
    echo "Rage Mode Ended."
    
    CAKE_OPTS_DEFAULT="bandwidth 100mbit nat diffserv4 ack-filter wash"
    run_tc qdisc del dev $WAN_IFACE root
    run_tc qdisc add dev $WAN_IFACE root cake $CAKE_OPTS_DEFAULT
    
    exit 0
fi

echo "Usage: $0 {init|limit|unlimit|status|mode} ..."
exit 1
