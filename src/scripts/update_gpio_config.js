#!/usr/bin/env node

/**
 * GPIO Configuration Updater for Raspberry Pi 3
 * This script helps update the GPIO configuration based on working pins
 */

const fs = require('fs');
const { execSync } = require('child_process');

// Safe GPIO pins for Raspberry Pi 3
const SAFE_GPIO_PINS = [2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 17, 18, 22, 23, 24, 25, 27];
const SYSTEM_GPIO_PINS = [0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26];

// Physical pin to GPIO mapping
const PHYSICAL_TO_GPIO = {
    3: 2, 5: 3, 7: 4, 8: 14, 10: 15, 11: 17, 12: 18, 13: 27,
    15: 22, 16: 23, 18: 24, 19: 10, 21: 9, 22: 25, 23: 11, 24: 8,
    26: 7, 27: 0, 28: 1, 29: 5, 31: 6, 32: 12, 33: 13, 35: 19,
    36: 16, 37: 26, 38: 20, 40: 21
};

function getPhysicalPin(gpioPin) {
    for (const [physical, gpio] of Object.entries(PHYSICAL_TO_GPIO)) {
        if (gpio === gpioPin) return physical;
    }
    return null;
}

function isSafePin(pin) {
    return SAFE_GPIO_PINS.includes(pin) && !SYSTEM_GPIO_PINS.includes(pin);
}

function isSystemPin(pin) {
    return SYSTEM_GPIO_PINS.includes(pin);
}

function testPinSync(pin, direction) {
    try {
        const { Gpio } = require('onoff');
        const gpio = new Gpio(pin, direction);
        gpio.unexport();
        return true;
    } catch (error) {
        console.log(`GPIO ${pin} (${direction}): ${error.message}`);
        return false;
    }
}

function findWorkingPins(pinType, direction) {
    console.log(`Finding working ${pinType} pins (${direction})...`);
    
    const candidates = SAFE_GPIO_PINS.filter(pin => 
        !isSystemPin(pin) && 
        (direction === 'in' || (direction === 'out' && pin >= 2)) // Output pins should be >= 2
    );
    
    const workingPins = [];
    
    for (const pin of candidates) {
        if (testPinSync(pin, direction)) {
            workingPins.push(pin);
            console.log(`  ✅ GPIO ${pin} works! (Physical pin ${getPhysicalPin(pin)})`);
            
            // Stop after finding 3 working pins
            if (workingPins.length >= 3) break;
        }
    }
    
    return workingPins;
}

function updateConfigFile(coinPin, relayPin, billPin) {
    try {
        // Check if database exists
        if (!fs.existsSync('database.sqlite')) {
            console.log('Creating new database with GPIO configuration...');
            
            // Create database and config table
            execSync(`sqlite3 database.sqlite "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);"`);
        }
        
        // Update configuration
        const updates = [
            `INSERT OR REPLACE INTO config (key, value) VALUES ('coin_pin', '${coinPin}');`,
            `INSERT OR REPLACE INTO config (key, value) VALUES ('relay_pin', '${relayPin}');`,
            `INSERT OR REPLACE INTO config (key, value) VALUES ('bill_pin', '${billPin}');`,
            `INSERT OR REPLACE INTO config (key, value) VALUES ('coin_pin_edge', 'falling');`,
            `INSERT OR REPLACE INTO config (key, value) VALUES ('bill_pin_edge', 'falling');`,
            `INSERT OR REPLACE INTO config (key, value) VALUES ('bill_multiplier', '1');`,
            `INSERT OR REPLACE INTO config (key, value) VALUES ('ban_limit_counter', '10');`,
            `INSERT OR REPLACE INTO config (key, value) VALUES ('ban_duration', '1');`
        ];
        
        for (const update of updates) {
            execSync(`sqlite3 database.sqlite "${update}"`);
        }
        
        // Verify the updates
        const result = execSync('sqlite3 database.sqlite "SELECT * FROM config WHERE key LIKE \'%pin%\';"', { encoding: 'utf8' });
        console.log('\nUpdated configuration:');
        console.log(result);
        
        return true;
        
    } catch (error) {
        console.error('Error updating configuration:', error.message);
        return false;
    }
}

function main() {
    console.log('=== Raspberry Pi 3 GPIO Configuration Updater ===\n');
    
    // Check if running as root
    if (process.getuid && process.getuid() !== 0) {
        console.warn('⚠️  Not running as root - GPIO tests may fail');
        console.warn('Consider running: sudo node update_gpio_config.js\n');
    }
    
    console.log('Testing GPIO pins to find working configuration...\n');
    
    // Find working pins
    const coinPins = findWorkingPins('coin', 'in');
    const relayPins = findWorkingPins('relay', 'out');
    const billPins = findWorkingPins('bill', 'in');
    
    console.log('\n=== Test Results ===');
    console.log(`Coin input pins: ${coinPins.length > 0 ? coinPins.join(', ') : 'None found'}`);
    console.log(`Relay output pins: ${relayPins.length > 0 ? relayPins.join(', ') : 'None found'}`);
    console.log(`Bill input pins: ${billPins.length > 0 ? billPins.join(', ') : 'None found'}`);
    
    if (coinPins.length === 0 || relayPins.length === 0 || billPins.length === 0) {
        console.error('\n❌ Not enough working GPIO pins found!');
        console.log('The system may not work properly.');
        
        if (coinPins.length === 0) {
            console.log('No working coin input pins found.');
        }
        if (relayPins.length === 0) {
            console.log('No working relay output pins found.');
        }
        if (billPins.length === 0) {
            console.log('No working bill input pins found.');
        }
        
        console.log('\nPossible causes:');
        console.log('1. GPIO pins are already in use by other processes');
        console.log('2. Insufficient permissions (try running as root)');
        console.log('3. GPIO kernel modules not loaded');
        console.log('4. Hardware issues with the Raspberry Pi');
        
        process.exit(1);
    }
    
    // Select best pins (prefer lower numbers)
    const selectedCoinPin = coinPins[0];
    const selectedRelayPin = relayPins[0];
    const selectedBillPin = billPins[0];
    
    console.log('\n=== Selected Configuration ===');
    console.log(`Coin Pin: GPIO ${selectedCoinPin} (Physical pin ${getPhysicalPin(selectedCoinPin)})`);
    console.log(`Relay Pin: GPIO ${selectedRelayPin} (Physical pin ${getPhysicalPin(selectedRelayPin)})`);
    console.log(`Bill Pin: GPIO ${selectedBillPin} (Physical pin ${getPhysicalPin(selectedBillPin)})`);
    
    // Update configuration
    console.log('\n=== Updating Configuration ===');
    if (updateConfigFile(selectedCoinPin, selectedRelayPin, selectedBillPin)) {
        console.log('✅ Configuration updated successfully!');
        
        console.log('\n=== Next Steps ===');
        console.log('1. Restart the service: pm2 restart piso-wifi');
        console.log('2. Test the new configuration: node src/scripts/gpio_test_rpi3_fixed.js');
        console.log('3. Monitor logs: pm2 logs piso-wifi');
        
        console.log('\n=== Safety Reminders ===');
        console.log('• Maximum current per GPIO pin: 16mA');
        console.log('• Total current for all pins: 50mA');
        console.log('• Use current limiting resistors (1kΩ recommended)');
        console.log('• Double-check wiring before connecting devices');
        
    } else {
        console.error('❌ Failed to update configuration');
        process.exit(1);
    }
}

// Run the main function
if (require.main === module) {
    main();
}

module.exports = { findWorkingPins, updateConfigFile };