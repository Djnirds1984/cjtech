#!/bin/bash
# fix_gpio_dynamic.sh - Dynamic GPIO pin cleanup using board detection
# This script gets GPIO pins from the board detection service and cleans them up

echo "Getting GPIO pins from board detection service..."

# Get the GPIO pins from the board detection service
# We'll use a Node.js one-liner to get the pins and output them
PINS=$(node -e "
const boardDetection = require('./src/services/boardDetectionService');
const pins = boardDetection.getGpioPins();
console.log(pins.join(' '));
" 2>/dev/null)

# If we couldn't get pins from the service, fall back to default pins
if [ -z "$PINS" ]; then
    echo "Could not get pins from board detection service, using defaults"
    PINS="12 11 19"
fi

echo "Cleaning up GPIO pins: $PINS"

# Helper function to unexport
unexport_pin() {
    if [ -d "/sys/class/gpio/gpio$1" ]; then
        echo "$1" > /sys/class/gpio/unexport 2>/dev/null
        if [ $? -eq 0 ]; then
            echo "Successfully unexported GPIO $1"
        else
            echo "Failed to unexport GPIO $1 (may not be exported)"
        fi
    else
        echo "GPIO $1 not currently exported"
    fi
}

# Unexport each pin
for pin in $PINS; do
    unexport_pin $pin
done

echo "GPIO cleanup completed"
exit 0