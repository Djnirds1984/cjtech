const { Gpio } = require('onoff');

const COIN_PIN = 12;  // PA12
const RELAY_PIN = 11; // PA11
const BILL_PIN = 19;  // PA19

console.log('--- GPIO Diagnostic Tool ---');
console.log('Press Ctrl+C to exit');

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
        console.log(`\nInitializing Pins...`);
        
        // --- RELAY TEST ---
        console.log(`[RELAY] Initializing GPIO ${RELAY_PIN} (Output)...`);
        const relay = new Gpio(RELAY_PIN, 'out');
        
        console.log('[RELAY] Testing: ON...');
        relay.writeSync(0); // Assuming Active LOW (0 = ON) based on common modules, or 1 depending on config. We'll just toggle.
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
        
        const coin = new Gpio(COIN_PIN, 'in', 'falling', { debounceTimeout: 10 });
        const bill = new Gpio(BILL_PIN, 'in', 'falling', { debounceTimeout: 10 });

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
        if (err.code === 'EBUSY') {
            console.error('\nSUGGESTION: The pins are busy. Please stop the main app first:');
            console.error('  pm2 stop piso-wifi');
            console.error('Then run this script again.');
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

runTest();
