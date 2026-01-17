#!/bin/bash

# Usage:
#   block <port> <proto>
#   unblock <port> <proto>
#   flush

COMMAND=$1
PORT=$2
PROTO=$3 # tcp, udp, both

# Normalize protocol
PROTO=$(echo "$PROTO" | tr '[:upper:]' '[:lower:]')

if [ "$COMMAND" == "block" ]; then
    echo "Blocking Port $PORT ($PROTO)"
    if [ "$PROTO" == "both" ] || [ "$PROTO" == "tcp" ]; then
        iptables -I FORWARD 1 -p tcp --dport $PORT -j DROP
    fi
    if [ "$PROTO" == "both" ] || [ "$PROTO" == "udp" ]; then
        iptables -I FORWARD 1 -p udp --dport $PORT -j DROP
    fi
    exit 0
fi

if [ "$COMMAND" == "unblock" ]; then
    echo "Unblocking Port $PORT ($PROTO)"
    # Use || true to suppress errors if rule doesn't exist
    if [ "$PROTO" == "both" ] || [ "$PROTO" == "tcp" ]; then
        iptables -D FORWARD -p tcp --dport $PORT -j DROP || true
    fi
    if [ "$PROTO" == "both" ] || [ "$PROTO" == "udp" ]; then
        iptables -D FORWARD -p udp --dport $PORT -j DROP || true
    fi
    exit 0
fi

if [ "$COMMAND" == "flush" ]; then
    # This might be dangerous if we have other DROP rules, but for this specific feature:
    # We can't easily identify just "our" rules unless we mark them or use a separate chain.
    # For now, we rely on the service to track state.
    # Ideally, we should use a custom chain "ADBLOCK_DROPS"
    
    iptables -N ADBLOCK_DROPS 2>/dev/null || true
    iptables -F ADBLOCK_DROPS
    
    # Ensure jump exists
    iptables -C FORWARD -j ADBLOCK_DROPS 2>/dev/null || iptables -I FORWARD 1 -j ADBLOCK_DROPS
    
    echo "AdBlock chain flushed"
    exit 0
fi

# Optimized Block using Chain
if [ "$COMMAND" == "block_chain" ]; then
    # Ensure chain exists
    iptables -N ADBLOCK_DROPS 2>/dev/null || true
    iptables -C FORWARD -j ADBLOCK_DROPS 2>/dev/null || iptables -I FORWARD 1 -j ADBLOCK_DROPS
    
    if [ "$PROTO" == "both" ] || [ "$PROTO" == "tcp" ]; then
        iptables -A ADBLOCK_DROPS -p tcp --dport $PORT -j DROP
    fi
    if [ "$PROTO" == "both" ] || [ "$PROTO" == "udp" ]; then
        iptables -A ADBLOCK_DROPS -p udp --dport $PORT -j DROP
    fi
    exit 0
fi

if [ "$COMMAND" == "unblock_chain" ]; then
    if [ "$PROTO" == "both" ] || [ "$PROTO" == "tcp" ]; then
        iptables -D ADBLOCK_DROPS -p tcp --dport $PORT -j DROP || true
    fi
    if [ "$PROTO" == "both" ] || [ "$PROTO" == "udp" ]; then
        iptables -D ADBLOCK_DROPS -p udp --dport $PORT -j DROP || true
    fi
    exit 0
fi
