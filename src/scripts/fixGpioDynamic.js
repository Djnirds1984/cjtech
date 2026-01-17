#!/usr/bin/env node
/**
 * fixGpioDynamic.js - Dynamic GPIO cleanup using board detection
 * This script gets GPIO pins from the board detection service and cleans them up
 */

const fs = require('fs');
const { execSync } = require('child_process');
const boardDetection = require('../services/boardDetectionService');

console.log('Getting GPIO pins from board detection service...');

// Get the GPIO pins from the board detection service
const pins = boardDetection.getGpioPins();
console.log(`Cleaning up GPIO pins: ${pins.join(', ')}`);

// Helper function to unexport GPIO pins
function unexportPin(pin) {
    const gpioPath = `/sys/class/gpio/gpio${pin}`;
    
    if (fs.existsSync(gpioPath)) {
        try {
            fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
            console.log(`Successfully unexported GPIO ${pin}`);
            return true;
        } catch (error) {
            console.log(`Failed to unexport GPIO ${pin}: ${error.message}`);
            return false;
        }
    } else {
        console.log(`GPIO ${pin} not currently exported`);
        return true;
    }
}

// Unexport each pin
let successCount = 0;
for (const pin of pins) {
    if (unexportPin(pin)) {
        successCount++;
    }
}

console.log(`GPIO cleanup completed. Processed ${pins.length} pins, ${successCount} successful.`);

// Also clean up any other GPIO pins that might be in use
// This is a safety measure to prevent EBUSY errors
console.log('Performing additional GPIO cleanup...');
try {
    // Try to unexport any pins that might be in the GPIO directory
    const gpioDir = '/sys/class/gpio';
    if (fs.existsSync(gpioDir)) {
        const entries = fs.readdirSync(gpioDir);
        const gpioEntries = entries.filter(entry => entry.startsWith('gpio') && !isNaN(entry.slice(4)));
        
        for (const entry of gpioEntries) {
            const pinNum = parseInt(entry.slice(4));
            if (!pins.includes(pinNum)) {
                console.log(`Found unexpected GPIO ${pinNum}, attempting cleanup...`);
                try {
                    fs.writeFileSync('/sys/class/gpio/unexport', pinNum.toString());
                    console.log(`Cleaned up unexpected GPIO ${pinNum}`);
                } catch (error) {
                    console.log(`Could not clean up GPIO ${pinNum}: ${error.message}`);
                }
            }
        }
    }
} catch (error) {
    console.log('Error during additional cleanup:', error.message);
}

process.exit(0);