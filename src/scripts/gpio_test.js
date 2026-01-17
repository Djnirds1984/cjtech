const { Gpio } = require('onoff');
const boardDetectionService = require('../services/boardDetectionService');
const configService = require('../services/configService');

// Get board-specific GPIO pins
const boardModel = boardDetectionService.getBoardModel();
const gpioMapping = boardDetectionService.getGpioMapping();

let COIN_PIN = 12;  // Default PA12
let RELAY_PIN = 11; // Default PA11  
let BILL_PIN = 19;  // Default PA19

// Use board-specific pins if available
if (gpioMapping) {
    COIN_PIN = gpioMapping.coin_pin || COIN_PIN;
    RELAY_PIN = gpioMapping.relay_pin || RELAY_PIN;
    BILL_PIN = gpioMapping.bill_pin || BILL_PIN;
}

// Override with config values if they exist
COIN_PIN = parseInt(configService.get('coin_pin', COIN_PIN));
RELAY_PIN = parseInt(configService.get('relay_pin', RELAY_PIN));
BILL_PIN = parseInt(configService.get('bill_pin', BILL_PIN));

console.log('--- GPIO Diagnostic Tool ---');
console.log(`Board: ${boardModel || 'Unknown'}`);
console.log(`Coin Pin: GPIO${COIN_PIN}`);
console.log(`Relay Pin: GPIO${RELAY_PIN}`);
console.log(`Bill Pin: GPIO${BILL_PIN}`);
console.log('Press Ctrl+C to exit');

// Raspberry Pi 3 Safety Check
function checkRPi3Safety() {
    if (boardModel && boardModel.includes('Raspberry Pi 3')) {
        const safeRPi3Pins = [2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 17, 18, 22, 23, 24, 25, 27];
        const systemRPi3Pins = [0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26];
        
        let hasIssues = false;
        
        if (systemRPi3Pins.includes(COIN_PIN)) {
            console.warn(`⚠️  WARNING: GPIO${COIN_PIN} is a system pin on Raspberry Pi 3!`);
            console.warn('   This may cause system instability or reboots.');
            hasIssues = true;
        }
        if (systemRPi3Pins.includes(RELAY_PIN)) {
            console.warn(`⚠️  WARNING: GPIO${RELAY_PIN} is a system pin on Raspberry Pi 3!`);
            console.warn('   This may cause system instability or reboots.');
            hasIssues = true;
        }
        if (systemRPi3Pins.includes(BILL_PIN)) {
            console.warn(`⚠️  WARNING: GPIO${BILL_PIN} is a system pin on Raspberry Pi 3!`);
            console.warn('   This may cause system instability or reboots.');
            hasIssues = true;
        }
        
        if (hasIssues) {
            console.warn('\n🚨 CRITICAL: System pins detected! The service may reboot your Pi.');
            console.warn('   Recommended safe pins for RPi3:');
            console.warn('   - Coin: GPIO2 (Physical pin 3)');
            console.warn('   - Relay: GPIO27 (Physical pin 13)');
            console.warn('   - Bill: GPIO17 (Physical pin 11)');
            console.warn('\n   Run: node src/scripts/update_gpio_config.js to auto-fix');
            return false;
        }
        
        console.log('✅ GPIO pins are safe for Raspberry Pi 3');
    }
    return true;
}

// 1. Cleanup Function
function cleanup(pin) {
    try {
        // Try to access sysfs directly to unexport if needed, 
        // but onoff usually handles this if we can instantiate.
        // If we can't instantiate, we might need manual cleanup (which fix_gpio.sh does).
    } catch (e) {}
}

async function runTest() {
    try {
        console.log('\n=== GPIO Safety Check ===');
        const isSafe = checkRPi3Safety();
        
        if (!isSafe) {
            console.log('\n❌ Safety check failed. Aborting test.');
            console.log('Please fix the GPIO pin configuration first.');
            return;
        }
        
        console.log('\n=== Initializing Pins ===');
        
        // --- RELAY TEST ---
        console.log(`[RELAY] Initializing GPIO ${RELAY_PIN} (Output)...`);
        let relay;
        try {
            relay = new Gpio(RELAY_PIN, 'out');
        } catch (err) {
            if (err.code === 'EBUSY') {
                console.error(`[RELAY] GPIO ${RELAY_PIN} is BUSY. Attempting cleanup...`);
                cleanup(RELAY_PIN);
                await sleep(1000);
                relay = new Gpio(RELAY_PIN, 'out');
            } else {
                throw err;
            }
        }
        
        console.log('[RELAY] Testing: ON...');
        relay.writeSync(0); // Assuming Active LOW (0 = ON) based on common modules
        await sleep(1000);
        console.log('[RELAY] Testing: OFF...');
        relay.writeSync(1);
        await sleep(1000);
        console.log('[RELAY] Blinking 3 times...');
        for(let i=0; i<3; i++) {
            relay.writeSync(0); await sleep(200);
            relay.writeSync(1); await sleep(200);
        }
        console.log('[RELAY] Test Complete. Leaving OFF (1).');
        relay.writeSync(1);

        // --- INPUT TEST ---
        console.log(`\n[INPUTS] Initializing Coin (GPIO ${COIN_PIN}) and Bill (GPIO ${BILL_PIN})...`);
        
        let coin, bill;
        try {
            coin = new Gpio(COIN_PIN, 'in', 'falling', { debounceTimeout: 10 });
        } catch (err) {
            if (err.code === 'EBUSY') {
                console.error(`[COIN] GPIO ${COIN_PIN} is BUSY. Attempting cleanup...`);
                cleanup(COIN_PIN);
                await sleep(1000);
                coin = new Gpio(COIN_PIN, 'in', 'falling', { debounceTimeout: 10 });
            } else {
                throw err;
            }
        }
        
        try {
            bill = new Gpio(BILL_PIN, 'in', 'falling', { debounceTimeout: 10 });
        } catch (err) {
            if (err.code === 'EBUSY') {
                console.error(`[BILL] GPIO ${BILL_PIN} is BUSY. Attempting cleanup...`);
                cleanup(BILL_PIN);
                await sleep(1000);
                bill = new Gpio(BILL_PIN, 'in', 'falling', { debounceTimeout: 10 });
            } else {
                throw err;
            }
        }

        console.log('>>> READY: Waiting for signals... (Insert a coin or bill now)');
        console.log('>>> Watch the console for "PULSE DETECTED" messages.');

        coin.watch((err, value) => {
            if (err) return console.error('[COIN] Error:', err);
            console.log(`[COIN] PULSE DETECTED! (GPIO ${COIN_PIN}) Value: ${value}`);
        });

        bill.watch((err, value) => {
            if (err) return console.error('[BILL] Error:', err);
            console.log(`[BILL] PULSE DETECTED! (GPIO ${BILL_PIN}) Value: ${value}`);
        });

        // Keep alive
        process.on('SIGINT', () => {
            console.log('\nExiting...');
            relay.unexport();
            coin.unexport();
            bill.unexport();
            process.exit(0);
        });

    } catch (err) {
        console.error('\n!!! FATAL ERROR !!!');
        console.error(err.message);
        if (err.code === 'EINVAL') {
            console.error('\nSUGGESTION: Invalid argument - GPIO pin may not be available on this board.');
            console.error('This often happens with system pins or invalid pin numbers.');
            console.error('For Raspberry Pi 3, avoid pins: 0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26');
            console.error('Run: node src/scripts/update_gpio_config.js to find working pins');
        } else if (err.code === 'EBUSY') {
            console.error('\nSUGGESTION: The pins are busy. Please stop the main app first:');
            console.error('  pm2 stop piso-wifi');
            console.error('Then run this script again.');
        } else if (err.code === 'EACCES') {
            console.error('\nSUGGESTION: Permission denied. Try running as root:');
            console.error('  sudo node src/scripts/gpio_test.js');
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

runTest();