#!/usr/bin/env node

/**
 * Raspberry Pi 3 GPIO Pin Fixer
 * Updates configuration to use safe GPIO pins for RPi3
 */

const configService = require('../services/configService');
const boardDetectionService = require('../services/boardDetectionService');

console.log('=== Raspberry Pi 3 GPIO Pin Fixer ===\n');

// Initialize board detection
boardDetectionService.init();
const boardModel = boardDetectionService.getBoardModel();

if (!boardModel || !boardModel.includes('Raspberry Pi 3')) {
    console.log('This script is specifically for Raspberry Pi 3.');
    console.log(`Detected board: ${boardModel || 'Unknown'}`);
    console.log('Exiting...');
    process.exit(0);
}

console.log(`Detected: ${boardModel}`);
console.log('\nUpdating GPIO configuration to use safe pins for RPi3...\n');

// Safe GPIO pins for Raspberry Pi 3
const SAFE_GPIO_PINS = {
    coin: 2,    // GPIO2 (Physical pin 3) - SDA1
    relay: 27,  // GPIO27 (Physical pin 13)
    bill: 17    // GPIO17 (Physical pin 11)
};

// Update configuration
try {
    configService.set('coin_pin', SAFE_GPIO_PINS.coin);
    configService.set('relay_pin', SAFE_GPIO_PINS.relay);
    configService.set('bill_pin', SAFE_GPIO_PINS.bill);
    
    console.log('✅ Configuration updated successfully!');
    console.log('\nNew GPIO pin assignments:');
    console.log(`  Coin: GPIO${SAFE_GPIO_PINS.coin} (Physical pin 3)`);
    console.log(`  Relay: GPIO${SAFE_GPIO_PINS.relay} (Physical pin 13)`);
    console.log(`  Bill: GPIO${SAFE_GPIO_PINS.bill} (Physical pin 11)`);
    
    console.log('\n=== Next Steps ===');
    console.log('1. Stop the service: pm2 stop piso-wifi');
    console.log('2. Test the new pins: node src/scripts/gpio_test.js');
    console.log('3. Start the service: pm2 start src/app.js --name piso-wifi');
    console.log('4. Monitor logs: pm2 logs piso-wifi');
    
    console.log('\n⚠️  IMPORTANT: Use current limiting resistors (1kΩ) on input pins!');
    console.log('Maximum current per GPIO pin: 16mA, Total: 50mA');
    
} catch (error) {
    console.error('❌ Failed to update configuration:', error.message);
    process.exit(1);
}