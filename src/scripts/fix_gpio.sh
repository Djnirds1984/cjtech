#!/bin/bash
# fix_gpio.sh - Force unexport GPIO pins to prevent EBUSY errors
# Dynamic version that uses board detection service when available

echo "Cleaning up GPIO pins..."

# Try to get pins from board detection service first
if command -v node >/dev/null 2>&1; then
    echo "Attempting to get GPIO pins from board detection service..."
    PINS=$(node -e "
    try {
        const boardDetection = require('./src/services/boardDetectionService');
        const pins = boardDetection.getGpioPins();
        console.log(pins.join(' '));
    } catch (error) {
        console.log('12 11 19'); // Fallback to default pins
    }
    " 2>/dev/null || echo "12 11 19")
else
    echo "Node.js not available, using default GPIO pins"
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

# Add any other pins here if needed
exit 0
