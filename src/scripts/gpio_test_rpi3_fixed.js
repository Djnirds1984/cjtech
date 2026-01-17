const { Gpio } = require('onoff');
const fs = require('fs');
const { execSync } = require('child_process');

console.log('=== Raspberry Pi 3 GPIO Safety Test (Fixed) ===');
console.log('This test will safely check GPIO functionality with enhanced error handling');

// Raspberry Pi 3 Safe GPIO Pins
const SAFE_GPIO_PINS = [2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 17, 18, 22, 23, 24, 25, 27];
const SYSTEM_GPIO_PINS = [0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26];

// Alternative pins if primary ones fail
const ALTERNATIVE_PINS = {
    coin: [2, 3, 4, 22, 23, 24, 25, 27],    // Input pins
    relay: [17, 18, 22, 23, 24, 25, 27],   // Output pins  
    bill: [2, 3, 4, 22, 23, 24, 25, 27]     // Input pins
};

// Physical pin to GPIO mapping
const PHYSICAL_TO_GPIO = {
    3: 2, 5: 3, 7: 4, 8: 14, 10: 15, 11: 17, 12: 18, 13: 27,
    15: 22, 16: 23, 18: 24, 19: 10, 21: 9, 22: 25, 23: 11, 24: 8,
    26: 7, 27: 0, 28: 1, 29: 5, 31: 6, 32: 12, 33: 13, 35: 19,
    36: 16, 37: 26, 38: 20, 40: 21
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isSafePin(pin) {
    return SAFE_GPIO_PINS.includes(pin) && !SYSTEM_GPIO_PINS.includes(pin);
}

function isSystemPin(pin) {
    return SYSTEM_GPIO_PINS.includes(pin);
}

function getPhysicalPin(gpioPin) {
    for (const [physical, gpio] of Object.entries(PHYSICAL_TO_GPIO)) {
        if (gpio === gpioPin) return physical;
    }
    return null;
}

async function cleanupPin(pin) {
    try {
        if (fs.existsSync(`/sys/class/gpio/gpio${pin}`)) {
            console.log(`  Cleaning up GPIO ${pin}...`);
            fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
            await delay(500);
            console.log(`  ✅ GPIO ${pin} cleaned up`);
            return true;
        }
        return true;
    } catch (error) {
        console.warn(`  ⚠️  Failed to cleanup GPIO ${pin}: ${error.message}`);
        return false;
    }
}

async function testPinWithRetry(pin, direction, label, maxRetries = 3) {
    console.log(`\n--- Testing ${label} GPIO ${pin} (${direction}) ---`);
    
    const physicalPin = getPhysicalPin(pin);
    if (physicalPin) {
        console.log(`  Physical pin: ${physicalPin}`);
    }
    
    if (isSystemPin(pin)) {
        console.error(`  ❌ GPIO ${pin} is a SYSTEM PIN - CANNOT USE!`);
        return false;
    }
    
    if (!isSafePin(pin)) {
        console.warn(`  ⚠️  GPIO ${pin} may not be safe for Raspberry Pi 3`);
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`  Attempt ${attempt}/${maxRetries}`);
        
        try {
            // Cleanup first
            await cleanupPin(pin);
            
            console.log(`  Initializing GPIO ${pin} as ${direction}...`);
            
            if (direction === 'output') {
                const gpio = new Gpio(pin, 'out');
                console.log(`  ✅ GPIO ${pin} initialized as OUTPUT`);
                
                console.log('  Testing LOW...');
                gpio.writeSync(0);
                await delay(500);
                
                console.log('  Testing HIGH...');
                gpio.writeSync(1);
                await delay(500);
                
                console.log('  Testing blinking...');
                for (let i = 0; i < 3; i++) {
                    gpio.writeSync(0);
                    await delay(200);
                    gpio.writeSync(1);
                    await delay(200);
                }
                
                gpio.writeSync(0);
                console.log(`  ✅ GPIO ${pin} OUTPUT test completed`);
                gpio.unexport();
                
            } else if (direction === 'input') {
                const gpio = new Gpio(pin, 'in', 'falling', { debounceTimeout: 10 });
                console.log(`  ✅ GPIO ${pin} initialized as INPUT`);
                
                console.log('  Testing input read...');
                const value = gpio.readSync();
                console.log(`  Current value: ${value}`);
                
                console.log('  GPIO is ready for input (no pulse detection in this test)');
                await delay(2000);
                
                console.log(`  ✅ GPIO ${pin} INPUT test completed`);
                gpio.unexport();
            }
            
            return true;
            
        } catch (error) {
            console.log(`  ❌ GPIO ${pin} test failed: ${error.message}`);
            
            if (error.code === 'EBUSY') {
                console.log('     Error: Device or resource busy');
                console.log('     Trying cleanup and retry...');
                await cleanupPin(pin);
                await delay(1000);
            } else if (error.code === 'EINVAL') {
                console.log('     Error: Invalid argument - GPIO may not be available');
                console.log('     This could mean:');
                console.log('     - GPIO pin is not available on this board');
                console.log('     - Pin is reserved for system use');
                console.log('     - Kernel module issue');
                break; // Don't retry EINVAL errors
            } else if (error.code === 'EACCES') {
                console.log('     Error: Permission denied');
                console.log('     Try running as root: sudo node gpio_test_rpi3_fixed.js');
                break; // Don't retry permission errors
            } else {
                console.log(`     Error code: ${error.code || 'unknown'}`);
                await delay(500);
            }
            
            if (attempt < maxRetries) {
                console.log(`     Retrying in 1 second...`);
                await delay(1000);
            }
        }
    }
    
    return false;
}

async function findWorkingPins(pinType, direction) {
    console.log(`\n🔍 Finding working ${pinType} pins (${direction})...`);
    
    const candidates = ALTERNATIVE_PINS[pinType];
    const workingPins = [];
    
    for (const pin of candidates) {
        console.log(`  Testing GPIO ${pin}...`);
        const success = await testPinWithRetry(pin, direction, `Alternative ${pinType}`, 1);
        if (success) {
            workingPins.push(pin);
            console.log(`  ✅ GPIO ${pin} works!`);
        } else {
            console.log(`  ❌ GPIO ${pin} failed`);
        }
        await delay(500);
    }
    
    return workingPins;
}

async function checkSystemStatus() {
    console.log('\n=== System Status Check ===');
    
    try {
        // Check if running as root
        if (process.getuid && process.getuid() === 0) {
            console.log('✅ Running as root (recommended for GPIO access)');
        } else {
            console.warn('⚠️  Not running as root - GPIO operations may fail');
            console.warn('   Try: sudo node gpio_test_rpi3_fixed.js');
        }
        
        // Check device tree model
        if (fs.existsSync('/proc/device-tree/model')) {
            const model = fs.readFileSync('/proc/device-tree/model', 'utf8').trim().replace(/\0/g, '');
            console.log(`Device Model: ${model}`);
            
            if (model.includes('Raspberry Pi 3')) {
                console.log('✅ Confirmed Raspberry Pi 3');
            } else {
                console.warn('⚠️  This does not appear to be a Raspberry Pi 3');
            }
        }
        
        // Check hardware from cpuinfo
        if (fs.existsSync('/proc/cpuinfo')) {
            const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
            const hardwareMatch = cpuinfo.match(/^Hardware\s*:\s*(.+)$/m);
            if (hardwareMatch) {
                console.log(`Hardware: ${hardwareMatch[1].trim()}`);
            }
        }
        
        // Check memory
        if (fs.existsSync('/proc/meminfo')) {
            const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
            const memTotal = meminfo.match(/MemTotal:\s+(\d+)/);
            if (memTotal) {
                const memMB = parseInt(memTotal[1]) / 1024;
                console.log(`Memory: ${memMB.toFixed(0)} MB`);
                if (memMB < 500) {
                    console.warn('⚠️  Low memory detected');
                }
            }
        }
        
        // Check for gpio group
        try {
            execSync('getent group gpio', { stdio: 'ignore' });
            console.log('✅ GPIO group found');
        } catch (e) {
            console.warn('⚠️  GPIO group not found');
        }
        
    } catch (error) {
        console.error('❌ System check failed:', error.message);
    }
}

async function checkGpioSubsystem() {
    console.log('\n=== GPIO Subsystem Check ===');
    
    try {
        // Check if GPIO sysfs exists
        if (fs.existsSync('/sys/class/gpio')) {
            console.log('✅ GPIO sysfs interface exists');
            
            // List exported GPIOs
            const gpioFiles = fs.readdirSync('/sys/class/gpio');
            const exportedGpios = gpioFiles.filter(f => f.startsWith('gpio') && f !== 'export' && f !== 'unexport');
            
            if (exportedGpios.length > 0) {
                console.log('📋 Currently exported GPIOs:');
                exportedGpios.forEach(gpio => {
                    const gpioNum = gpio.replace('gpio', '');
                    try {
                        const direction = fs.readFileSync(`/sys/class/gpio/${gpio}/direction`, 'utf8').trim();
                        console.log(`  GPIO ${gpioNum}: ${direction}`);
                    } catch (e) {
                        console.log(`  GPIO ${gpioNum}: (cannot read)`);
                    }
                });
            } else {
                console.log('✅ No GPIOs currently exported');
            }
        } else {
            console.log('❌ GPIO sysfs interface not found');
        }
        
        // Check for gpiochip devices
        const gpiochipFiles = fs.readdirSync('/dev').filter(f => f.startsWith('gpiochip'));
        if (gpiochipFiles.length > 0) {
            console.log('📋 GPIO chip devices found:');
            gpiochipFiles.forEach(file => {
                console.log(`  /dev/${file}`);
            });
        } else {
            console.log('⚠️  No gpiochip devices found');
        }
        
    } catch (error) {
        console.error('❌ GPIO subsystem check failed:', error.message);
    }
}

async function runFullTest() {
    console.log('Starting Raspberry Pi 3 GPIO Safety Test with Enhanced Error Handling...\n');
    
    await checkSystemStatus();
    await checkGpioSubsystem();
    
    console.log('\n=== Testing Primary Pins ===');
    
    // Test the primary recommended pins
    const primaryTests = [
        { pin: 2, direction: 'input', label: 'Coin (Primary)' },
        { pin: 27, direction: 'output', label: 'Relay (Primary)' },
        { pin: 17, direction: 'input', label: 'Bill (Primary)' }
    ];
    
    const primaryResults = [];
    
    for (const test of primaryTests) {
        const success = await testPinWithRetry(test.pin, test.direction, test.label);
        primaryResults.push({ ...test, success });
        await delay(1000);
    }
    
    console.log('\n=== Primary Test Results ===');
    primaryResults.forEach(result => {
        const status = result.success ? '✅' : '❌';
        console.log(`${status} ${result.label}: GPIO ${result.pin} (${result.direction})`);
    });
    
    // Find alternatives for failed pins
    const failedPins = primaryResults.filter(r => !r.success);
    
    if (failedPins.length > 0) {
        console.log('\n=== Finding Alternative Pins ===');
        
        for (const failed of failedPins) {
            console.log(`\nLooking for alternatives for ${failed.label}...`);
            const workingPins = await findWorkingPins(
                failed.label.toLowerCase().split(' ')[0], 
                failed.direction
            );
            
            if (workingPins.length > 0) {
                console.log(`✅ Found working ${failed.label.toLowerCase().split(' ')[0]} pins: ${workingPins.join(', ')}`);
                console.log(`   Recommended: GPIO ${workingPins[0]} (Physical pin ${getPhysicalPin(workingPins[0])})`);
            } else {
                console.log(`❌ No working ${failed.label.toLowerCase().split(' ')[0]} pins found`);
            }
        }
    }
    
    console.log('\n=== Configuration Recommendations ===');
    console.log('Update your configuration with these working pins:');
    console.log('');
    console.log('For coin input:');
    if (primaryResults.find(r => r.label.includes('Coin') && r.success)) {
        console.log('  coin_pin: 2');
    } else {
        console.log('  coin_pin: [alternative from above]');
    }
    console.log('');
    console.log('For relay output:');
    if (primaryResults.find(r => r.label.includes('Relay') && r.success)) {
        console.log('  relay_pin: 27');
    } else {
        console.log('  relay_pin: [alternative from above]');
    }
    console.log('');
    console.log('For bill input:');
    if (primaryResults.find(r => r.label.includes('Bill') && r.success)) {
        console.log('  bill_pin: 17');
    } else {
        console.log('  bill_pin: [alternative from above]');
    }
    
    console.log('\n⚠️  IMPORTANT SAFETY NOTES:');
    console.log('1. Maximum current per GPIO pin: 16mA');
    console.log('2. Total current for all pins: 50mA');
    console.log('3. Use current limiting resistors (1kΩ recommended)');
    console.log('4. Double-check wiring before connecting devices');
    console.log('5. Test with multimeter before connecting to external hardware');
}

// Handle Ctrl+C gracefully
process.on('SIGINT', async () => {
    console.log('\n\nCleaning up and exiting...');
    
    // Cleanup any exported pins
    try {
        const gpioFiles = fs.readdirSync('/sys/class/gpio');
        const exportedGpios = gpioFiles.filter(f => f.startsWith('gpio') && f !== 'export' && f !== 'unexport');
        
        for (const gpio of exportedGpios) {
            const gpioNum = gpio.replace('gpio', '');
            try {
                fs.writeFileSync('/sys/class/gpio/unexport', gpioNum);
                console.log(`Unexported GPIO ${gpioNum}`);
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    } catch (error) {
        // Ignore cleanup errors
    }
    
    process.exit(0);
});

// Run the test
runFullTest().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});