const { Gpio } = require('onoff');
const fs = require('fs');
const { execSync } = require('child_process');

console.log('=== Raspberry Pi 3 GPIO Diagnostic Tool ===');
console.log('This tool will help diagnose GPIO issues on your Raspberry Pi 3\n');

// Raspberry Pi 3 GPIO Information
const GPIO_INFO = {
    // Safe GPIO pins for general use
    safePins: [2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 17, 18, 22, 23, 24, 25, 27],
    
    // System pins that should not be used
    systemPins: [0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26],
    
    // Physical pin to GPIO mapping
    physicalToGpio: {
        3: 2, 5: 3, 7: 4, 8: 14, 10: 15, 11: 17, 12: 18, 13: 27,
        15: 22, 16: 23, 18: 24, 19: 10, 21: 9, 22: 25, 23: 11, 24: 8,
        26: 7, 27: 0, 28: 1, 29: 5, 31: 6, 32: 12, 33: 13, 35: 19,
        36: 16, 37: 26, 38: 20, 40: 21
    },
    
    // GPIO to physical pin mapping
    gpioToPhysical: {
        2: 3, 3: 5, 4: 7, 14: 8, 15: 10, 17: 11, 18: 12, 27: 13,
        22: 15, 23: 16, 24: 18, 10: 19, 9: 21, 25: 22, 11: 23, 8: 24,
        7: 26, 0: 27, 1: 28, 5: 29, 6: 31, 12: 32, 13: 33, 19: 35,
        16: 36, 26: 37, 20: 38, 21: 40
    }
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function checkSystemInfo() {
    console.log('--- System Information ---');
    
    try {
        // Check if running as root
        if (process.getuid && process.getuid() === 0) {
            console.log('✅ Running as root (recommended for GPIO access)');
        } else {
            console.log('⚠️  Not running as root - GPIO operations may fail');
        }
        
        // Check device tree model
        if (fs.existsSync('/proc/device-tree/model')) {
            const model = fs.readFileSync('/proc/device-tree/model', 'utf8').trim().replace(/\0/g, '');
            console.log(`Device Model: ${model}`);
        }
        
        // Check hardware from cpuinfo
        if (fs.existsSync('/proc/cpuinfo')) {
            const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
            const hardwareMatch = cpuinfo.match(/^Hardware\s*:\s*(.+)$/m);
            const revisionMatch = cpuinfo.match(/^Revision\s*:\s*(.+)$/m);
            
            if (hardwareMatch) {
                console.log(`Hardware: ${hardwareMatch[1].trim()}`);
            }
            if (revisionMatch) {
                console.log(`Revision: ${revisionMatch[1].trim()}`);
            }
        }
        
        // Check memory
        if (fs.existsSync('/proc/meminfo')) {
            const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
            const memTotal = meminfo.match(/MemTotal:\s+(\d+)/);
            if (memTotal) {
                const memMB = parseInt(memTotal[1]) / 1024;
                console.log(`Memory: ${memMB.toFixed(0)} MB`);
            }
        }
        
        // Check for gpio group
        try {
            execSync('getent group gpio', { stdio: 'ignore' });
            console.log('✅ GPIO group exists');
        } catch (e) {
            console.log('⚠️  GPIO group not found');
        }
        
    } catch (error) {
        console.log('❌ Error checking system info:', error.message);
    }
    
    console.log('');
}

function checkGpioSysfs() {
    console.log('--- GPIO Sysfs Status ---');
    
    try {
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
                        console.log(`  GPIO ${gpioNum}: (cannot read direction)`);
                    }
                });
            } else {
                console.log('✅ No GPIOs currently exported');
            }
        } else {
            console.log('❌ GPIO sysfs interface not found');
        }
    } catch (error) {
        console.log('❌ Error checking GPIO sysfs:', error.message);
    }
    
    console.log('');
}

function checkGpioDeviceFiles() {
    console.log('--- GPIO Device Files ---');
    
    try {
        // Check for gpiochip devices
        const gpiochipFiles = fs.readdirSync('/dev').filter(f => f.startsWith('gpiochip'));
        if (gpiochipFiles.length > 0) {
            console.log('📋 GPIO chip devices found:');
            gpiochipFiles.forEach(file => {
                try {
                    const stats = fs.statSync(`/dev/${file}`);
                    console.log(`  /dev/${file}`);
                } catch (e) {
                    console.log(`  /dev/${file} (cannot access)`);
                }
            });
        } else {
            console.log('⚠️  No gpiochip devices found');
        }
        
        // Check for gpiomem
        if (fs.existsSync('/dev/gpiomem')) {
            console.log('✅ /dev/gpiomem exists');
            try {
                const stats = fs.statSync('/dev/gpiomem');
                console.log(`   Permissions: ${stats.mode.toString(8)}`);
                console.log(`   Owner: ${stats.uid}:${stats.gid}`);
            } catch (e) {
                console.log('   (cannot read permissions)');
            }
        } else {
            console.log('⚠️  /dev/gpiomem not found');
        }
        
    } catch (error) {
        console.log('❌ Error checking GPIO device files:', error.message);
    }
    
    console.log('');
}

async function testPinExport(pin) {
    console.log(`--- Testing GPIO ${pin} Export ---`);
    
    try {
        // Check if pin is already exported
        if (fs.existsSync(`/sys/class/gpio/gpio${pin}`)) {
            console.log(`GPIO ${pin} is already exported`);
            
            try {
                const direction = fs.readFileSync(`/sys/class/gpio/gpio${pin}/direction`, 'utf8').trim();
                console.log(`Current direction: ${direction}`);
                
                // Try to unexport
                console.log('Attempting to unexport...');
                fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
                await delay(500);
                console.log('✅ Successfully unexported');
            } catch (e) {
                console.log(`❌ Failed to unexport: ${e.message}`);
                return false;
            }
        } else {
            console.log(`GPIO ${pin} is not exported`);
        }
        
        // Try to export
        console.log('Attempting to export...');
        fs.writeFileSync('/sys/class/gpio/export', pin.toString());
        await delay(500);
        
        if (fs.existsSync(`/sys/class/gpio/gpio${pin}`)) {
            console.log('✅ Successfully exported');
            
            // Set direction to input
            console.log('Setting direction to input...');
            fs.writeFileSync(`/sys/class/gpio/gpio${pin}/direction`, 'in');
            
            // Check direction
            const direction = fs.readFileSync(`/sys/class/gpio/gpio${pin}/direction`, 'utf8').trim();
            console.log(`Direction is now: ${direction}`);
            
            // Cleanup
            console.log('Cleaning up...');
            fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
            await delay(500);
            console.log('✅ Cleanup completed');
            
            return true;
        } else {
            console.log('❌ Export failed - directory not created');
            return false;
        }
        
    } catch (error) {
        console.log(`❌ GPIO ${pin} export test failed: ${error.message}`);
        
        if (error.code === 'EBUSY') {
            console.log('   Error: Device or resource busy');
        } else if (error.code === 'EINVAL') {
            console.log('   Error: Invalid argument - GPIO may not be available');
        } else if (error.code === 'EACCES') {
            console.log('   Error: Permission denied');
        }
        
        return false;
    }
}

async function testPinWithOnoff(pin, direction) {
    console.log(`--- Testing GPIO ${pin} with onoff library (${direction}) ---`);
    
    try {
        const gpio = new Gpio(pin, direction);
        console.log(`✅ Successfully created Gpio object for GPIO ${pin}`);
        
        if (direction === 'out') {
            console.log('Testing output functionality...');
            gpio.writeSync(0);
            console.log('   Set to LOW');
            await delay(100);
            
            gpio.writeSync(1);
            console.log('   Set to HIGH');
            await delay(100);
            
            gpio.writeSync(0);
            console.log('   Set back to LOW');
        } else {
            console.log('Testing input functionality...');
            const value = gpio.readSync();
            console.log(`   Read value: ${value}`);
        }
        
        gpio.unexport();
        console.log('✅ Cleanup completed');
        return true;
        
    } catch (error) {
        console.log(`❌ onoff test failed for GPIO ${pin}: ${error.message}`);
        
        if (error.code === 'EBUSY') {
            console.log('   Error: Device or resource busy');
        } else if (error.code === 'EINVAL') {
            console.log('   Error: Invalid argument');
        } else if (error.code === 'EACCES') {
            console.log('   Error: Permission denied');
        }
        
        return false;
    }
}

function checkPinAvailability() {
    console.log('--- GPIO Pin Availability Check ---');
    
    const pinsToCheck = [2, 3, 4, 17, 18, 22, 23, 24, 25, 27]; // Safe pins
    
    pinsToCheck.forEach(pin => {
        const physicalPin = GPIO_INFO.gpioToPhysical[pin];
        const isSystem = GPIO_INFO.systemPins.includes(pin);
        const isSafe = GPIO_INFO.safePins.includes(pin);
        
        console.log(`GPIO ${pin} (Physical ${physicalPin || 'N/A'}): ${isSystem ? 'SYSTEM' : isSafe ? 'SAFE' : 'UNKNOWN'}`);
    });
    
    console.log('');
}

async function runFullDiagnostic() {
    console.log('Starting comprehensive GPIO diagnostic...\n');
    
    // System information
    checkSystemInfo();
    
    // Check GPIO sysfs
    checkGpioSysfs();
    
    // Check device files
    checkGpioDeviceFiles();
    
    // Check pin availability
    checkPinAvailability();
    
    // Test specific pins
    const testPins = [2, 17, 27]; // The pins we're having trouble with
    
    for (const pin of testPins) {
        console.log(`\n🔍 Detailed testing for GPIO ${pin}:`);
        
        // Test sysfs export
        const sysfsSuccess = await testPinExport(pin);
        
        if (sysfsSuccess) {
            // Test with onoff
            await testPinWithOnoff(pin, 'in');
            await testPinWithOnoff(pin, 'out');
        }
        
        await delay(1000); // Wait between tests
    }
    
    console.log('\n=== Diagnostic Summary ===');
    console.log('Based on the diagnostic results:');
    console.log('1. Check for permission issues (run as root)');
    console.log('2. Check for busy GPIOs (already exported)');
    console.log('3. Check for system pin conflicts');
    console.log('4. Verify GPIO kernel modules are loaded');
    console.log('5. Consider alternative GPIO pins if needed');
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

// Run the diagnostic
runFullDiagnostic().catch(error => {
    console.error('Diagnostic failed:', error);
    process.exit(1);
});