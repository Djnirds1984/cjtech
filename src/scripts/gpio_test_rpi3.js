const { Gpio } = require('onoff');

// Raspberry Pi 3 Safe GPIO Pins
const SAFE_GPIO_PINS = [2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 17, 18, 22, 23, 24, 25, 27];
const SYSTEM_GPIO_PINS = [0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26];

// Recommended pins for Raspberry Pi 3
const RECOMMENDED_PINS = {
    coin: 2,    // GPIO2 (Physical pin 3) - SDA1
    relay: 27,  // GPIO27 (Physical pin 13)
    bill: 17    // GPIO17 (Physical pin 11)
};

console.log('=== Raspberry Pi 3 GPIO Safety Test ===');
console.log('This test will safely check GPIO functionality');
console.log('Recommended pins for RPi3:');
console.log(`  Coin: GPIO${RECOMMENDED_PINS.coin} (Physical pin 3)`);
console.log(`  Relay: GPIO${RECOMMENDED_PINS.relay} (Physical pin 13)`);
console.log(`  Bill: GPIO${RECOMMENDED_PINS.bill} (Physical pin 11)`);
console.log('');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isSafePin(pin) {
    return SAFE_GPIO_PINS.includes(pin) && !SYSTEM_GPIO_PINS.includes(pin);
}

function isSystemPin(pin) {
    return SYSTEM_GPIO_PINS.includes(pin);
}

async function cleanupPin(pin) {
    try {
        if (fs.existsSync(`/sys/class/gpio/gpio${pin}`)) {
            console.log(`Cleaning up GPIO ${pin}...`);
            fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
            await delay(500);
            console.log(`GPIO ${pin} cleaned up successfully`);
        }
    } catch (error) {
        console.warn(`Failed to cleanup GPIO ${pin}:`, error.message);
    }
}

async function testPin(pin, direction, label) {
    console.log(`\n--- Testing ${label} GPIO ${pin} ---`);
    
    if (isSystemPin(pin)) {
        console.error(`❌ GPIO ${pin} is a SYSTEM PIN - DO NOT USE!`);
        return false;
    }
    
    if (!isSafePin(pin)) {
        console.warn(`⚠️  GPIO ${pin} may not be safe for Raspberry Pi 3`);
    }
    
    try {
        // Cleanup first
        await cleanupPin(pin);
        
        console.log(`Testing GPIO ${pin} as ${direction}...`);
        
        if (direction === 'output') {
            // Test as output
            const gpio = new Gpio(pin, 'out');
            
            console.log(`GPIO ${pin} initialized as OUTPUT`);
            
            // Test LOW
            console.log(`Setting GPIO ${pin} to LOW...`);
            gpio.writeSync(0);
            await delay(1000);
            
            // Test HIGH
            console.log(`Setting GPIO ${pin} to HIGH...`);
            gpio.writeSync(1);
            await delay(1000);
            
            // Test blinking
            console.log(`Blinking GPIO ${pin} 3 times...`);
            for (let i = 0; i < 3; i++) {
                gpio.writeSync(0);
                await delay(200);
                gpio.writeSync(1);
                await delay(200);
            }
            
            // Reset to LOW
            gpio.writeSync(0);
            console.log(`✅ GPIO ${pin} OUTPUT test completed`);
            gpio.unexport();
            
        } else if (direction === 'input') {
            // Test as input
            const gpio = new Gpio(pin, 'in', 'falling', { debounceTimeout: 10 });
            
            console.log(`GPIO ${pin} initialized as INPUT`);
            console.log(`Waiting for input on GPIO ${pin}... (10 seconds)`);
            
            let pulseCount = 0;
            const startTime = Date.now();
            
            gpio.watch((err, value) => {
                if (err) {
                    console.error(`GPIO ${pin} watch error:`, err);
                    return;
                }
                pulseCount++;
                console.log(`✅ Pulse detected on GPIO ${pin} (count: ${pulseCount})`);
            });
            
            // Wait for 10 seconds
            await delay(10000);
            
            gpio.unwatchAll();
            console.log(`✅ GPIO ${pin} INPUT test completed (${pulseCount} pulses detected)`);
            gpio.unexport();
        }
        
        return true;
        
    } catch (error) {
        console.error(`❌ GPIO ${pin} test failed:`, error.message);
        
        if (error.code === 'EBUSY') {
            console.warn(`GPIO ${pin} is busy. Trying cleanup...`);
            await cleanupPin(pin);
        } else if (error.code === 'EINVAL') {
            console.error(`GPIO ${pin} is not available or invalid for this board`);
        }
        
        return false;
    }
}

async function checkSystemStatus() {
    console.log('\n=== System Status Check ===');
    
    try {
        // Check if running as root
        if (process.getuid && process.getuid() === 0) {
            console.log('✅ Running as root (recommended for GPIO access)');
        } else {
            console.warn('⚠️  Not running as root - GPIO operations may fail');
        }
        
        // Check memory
        const fs = require('fs');
        const memInfo = fs.readFileSync('/proc/meminfo', 'utf8');
        const memTotal = memInfo.match(/MemTotal:\s+(\d+)/);
        if (memTotal) {
            const memMB = parseInt(memTotal[1]) / 1024;
            console.log(`Memory: ${memMB.toFixed(0)} MB`);
            if (memMB < 500) {
                console.warn('⚠️  Low memory detected');
            }
        }
        
        // Check for gpio group
        try {
            require('child_process').execSync('getent group gpio', { stdio: 'ignore' });
            console.log('✅ GPIO group found');
        } catch (e) {
            console.warn('⚠️  GPIO group not found');
        }
        
    } catch (error) {
        console.warn('System check failed:', error.message);
    }
}

async function runFullTest() {
    console.log('Starting Raspberry Pi 3 GPIO Safety Test...\n');
    
    await checkSystemStatus();
    
    // Test recommended pins
    console.log('\n=== Testing Recommended Pins ===');
    
    const tests = [
        { pin: RECOMMENDED_PINS.coin, direction: 'input', label: 'Coin' },
        { pin: RECOMMENDED_PINS.relay, direction: 'output', label: 'Relay' },
        { pin: RECOMMENDED_PINS.bill, direction: 'input', label: 'Bill' }
    ];
    
    for (const test of tests) {
        const success = await testPin(test.pin, test.direction, test.label);
        if (!success) {
            console.warn(`Recommended pin GPIO${test.pin} failed - consider using alternative pins`);
        }
        await delay(1000); // Wait between tests
    }
    
    console.log('\n=== Test Summary ===');
    console.log('If all tests passed, your Raspberry Pi 3 GPIO is working correctly!');
    console.log('Recommended configuration:');
    console.log(`  Coin Pin: GPIO${RECOMMENDED_PINS.coin} (Physical pin 3)`);
    console.log(`  Relay Pin: GPIO${RECOMMENDED_PINS.relay} (Physical pin 13)`);
    console.log(`  Bill Pin: GPIO${RECOMMENDED_PINS.bill} (Physical pin 11)`);
    
    console.log('\n⚠️  IMPORTANT SAFETY NOTES:');
    console.log('1. Maximum current per GPIO pin: 16mA');
    console.log('2. Total current for all pins: 50mA');
    console.log('3. Never connect devices that draw more than 16mA');
    console.log('4. Always use proper current limiting resistors');
    console.log('5. Double-check your wiring before connecting devices');
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
    console.log('\n\nCleaning up and exiting...');
    
    // Cleanup all tested pins
    for (const pin of Object.values(RECOMMENDED_PINS)) {
        await cleanupPin(pin);
    }
    
    process.exit(0);
});

// Run the test
runFullTest().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});