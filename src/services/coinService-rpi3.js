const EventEmitter = require('events');
const configService = require('./configService');
const boardDetectionService = require('./boardDetectionService-rpi3');
const fs = require('fs');

const { execSync } = require('child_process');
const path = require('path');

// Use dynamic import for onoff to avoid build errors on Windows dev
let Gpio;
try {
    if (process.platform !== 'win32') {
        Gpio = require('onoff').Gpio;
    }
} catch (e) {
    console.log('GPIO not available (Simulation Mode)');
}

class CoinServiceRPI3 extends EventEmitter {
    constructor() {
        super();
        this.gpioPin = null;
        this.coinInsert = null;
        
        this.billPin = null;
        this.billValidator = null;
        
        this.pulseCount = 0;
        this.lastPulseTime = 0;
        this.debounceTimer = null;
        this.timer = null;
        this.debounceTime = 50; // Ignore signal noise < 50ms
        this.commitTime = 300;  // Wait 300ms for more pulses before committing
        
        this.isBanned = false;
        this.banTimer = null;
        this.activityStart = 0; // Track start of pulse activity
        
        // Raspberry Pi 3 specific safety settings
        this.isRaspberryPi3 = false;
        this.safeMode = false;
        this.maxRetries = 3;
        this.retryDelay = 1000; // 1 second between retries
        
        // Run cleanup script before initialization (Linux only)
        if (process.platform !== 'win32') {
            try {
                const scriptPath = path.join(__dirname, '../scripts/fix_gpio.sh');
                console.log('CoinService: Running GPIO cleanup script...');
                execSync(`chmod +x "${scriptPath}"`);
                execSync(`"${scriptPath}"`);
                console.log('CoinService: GPIO cleanup complete.');
            } catch (err) {
                console.error('CoinService: GPIO cleanup failed:', err.message);
            }
        }
    }

    async init() {
        try {
            // Initialize board detection first
            if (boardDetectionService && typeof boardDetectionService.init === 'function') {
                boardDetectionService.init();
                this.isRaspberryPi3 = boardDetectionService.isRaspberryPi3Board();
                this.safeMode = this.isRaspberryPi3;
                
                if (this.isRaspberryPi3) {
                    console.log('CoinService: Raspberry Pi 3 detected - Enabling safe mode');
                    const warnings = boardDetectionService.getBoardWarnings();
                    warnings.forEach(warning => {
                        console.warn(`CoinService: ${warning.message}`);
                    });
                }
            }

            // Initialize GPIO with safety checks
            await this.initGpioSafe().catch(err => console.error('CoinService: Fatal Init Error', err));
        } catch (error) {
            console.error('CoinService: Initialization failed:', error.message);
            // Try to initialize in simulation mode
            console.log('CoinService: Falling back to simulation mode');
        }
    }
    
    // Enhanced force cleanup with Raspberry Pi 3 safety
    async forceCleanup(pin) {
        if (!pin || process.platform === 'win32') return false;
        
        try {
            console.log(`CoinService: Forcing cleanup of GPIO ${pin}...`);
            
            // For Raspberry Pi 3, add extra safety checks
            if (this.isRaspberryPi3) {
                // Check if pin is currently in use by system
                if (this.isSystemPin(pin)) {
                    console.warn(`CoinService: GPIO ${pin} is a system pin, skipping cleanup`);
                    return false;
                }
            }
            
            // Check if exported first to avoid error
            if (fs.existsSync(`/sys/class/gpio/gpio${pin}`)) {
                // Try graceful unexport first
                try {
                    fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
                    console.log(`CoinService: Successfully unexported GPIO ${pin}`);
                    
                    // Wait a bit for system to release the pin
                    await this.delay(500);
                    return true;
                } catch (e) {
                    console.warn(`CoinService: Failed to unexport GPIO ${pin}: ${e.message}`);
                    
                    // For Raspberry Pi 3, try alternative cleanup methods
                    if (this.isRaspberryPi3) {
                        return await this.cleanupRaspberryPi3(pin);
                    }
                    
                    return false;
                }
            }
            
            return true;
        } catch (e) {
            console.warn(`CoinService: Failed to force cleanup GPIO ${pin}: ${e.message}`);
            return false;
        }
    }
    
    // Raspberry Pi 3 specific cleanup
    async cleanupRaspberryPi3(pin) {
        try {
            console.log(`CoinService: Trying Raspberry Pi 3 specific cleanup for GPIO ${pin}`);
            
            // Try to release any active processes using the pin
            try {
                execSync(`lsof /sys/class/gpio/gpio${pin} 2>/dev/null | grep -v COMMAND | awk '{print $2}' | xargs -r kill -9 2>/dev/null || true`);
                await this.delay(1000);
            } catch (e) {
                // Ignore errors from lsof/kill
            }
            
            // Try to unexport again
            try {
                fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
                console.log(`CoinService: Successfully unexported GPIO ${pin} after process cleanup`);
                await this.delay(500);
                return true;
            } catch (e2) {
                console.error(`CoinService: Failed to unexport GPIO ${pin} even after cleanup`);
                return false;
            }
        } catch (error) {
            console.error(`CoinService: Raspberry Pi 3 cleanup failed for GPIO ${pin}:`, error.message);
            return false;
        }
    }
    
    // Check if pin is used by system
    isSystemPin(pin) {
        // Raspberry Pi 3 system pins that should not be used
        const systemPins = [0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26];
        return systemPins.includes(parseInt(pin));
    }
    
    // Safe delay function
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async initGpioSafe() {
        // --- Coin Settings ---
        const pin = parseInt(configService.get('coin_pin', 2)); // Default to GPIO2 for RPi3
        let pinEdge = configService.get('coin_pin_edge', 'falling');
        if (typeof pinEdge === 'string') pinEdge = pinEdge.toLowerCase();
        
        // --- Bill Settings ---
        const billPin = parseInt(configService.get('bill_pin', 17)); // Default to GPIO17 for RPi3
        let billPinEdge = configService.get('bill_pin_edge', 'falling');
        if (typeof billPinEdge === 'string') billPinEdge = billPinEdge.toLowerCase();
        this.billMultiplier = parseInt(configService.get('bill_multiplier', 1));
        
        // --- Ban Settings ---
        this.banLimit = parseInt(configService.get('ban_limit_counter', 10)); 
        this.banDuration = parseInt(configService.get('ban_duration', 1)); // minutes

        console.log(`CoinService: Init Coin(GPIO${pin}, ${pinEdge}) | Bill(GPIO${billPin}, ${billPinEdge}, x${this.billMultiplier}) | Ban(Limit: ${this.banLimit}s, Duration: ${this.banDuration}m)`);
        
        // Additional safety check for Raspberry Pi 3
        if (this.isRaspberryPi3) {
            console.log('CoinService: Performing Raspberry Pi 3 safety checks...');
            
            // Validate pins are safe for Raspberry Pi 3
            if (!this.validateRaspberryPi3Pins([pin, billPin])) {
                console.error('CoinService: GPIO pins validation failed for Raspberry Pi 3');
                return;
            }
            
            // Check system resources
            await this.checkSystemResources();
        }

        // Cleanup existing objects
        if (this.coinInsert) {
             try { this.coinInsert.unexport(); } catch(e){}
             this.coinInsert = null;
        }
        
        if (this.billValidator) {
             try { this.billValidator.unexport(); } catch(e){}
             this.billValidator = null;
        }

        this.gpioPin = pin;
        this.billPin = billPin;

        if (Gpio) {
            const initPinSafe = async (pinNum, edge, label, retries = 0) => {
                try {
                    // Additional safety check for Raspberry Pi 3
                    if (this.isRaspberryPi3 && this.isSystemPin(pinNum)) {
                        console.error(`CoinService: Cannot use system pin GPIO ${pinNum} for ${label}`);
                        return null;
                    }
                    
                    console.log(`CoinService: Initializing ${label} GPIO ${pinNum} (attempt ${retries + 1}/${this.maxRetries})`);
                    
                    // Try to initialize with safety parameters
                    const gpio = new Gpio(pinNum, 'in', edge, { 
                        debounceTimeout: 50,
                        activeLow: false // Ensure active low is false for safety
                    });
                    
                    console.log(`CoinService: Successfully initialized ${label} GPIO ${pinNum}`);
                    return gpio;
                    
                } catch (err) {
                    console.error(`CoinService: Error initializing ${label} GPIO ${pinNum}:`, err.message);
                    
                    if (err.code === 'EBUSY' && retries < this.maxRetries) {
                        console.warn(`CoinService: GPIO ${pinNum} is BUSY. Attempting cleanup (attempt ${retries + 1})`);
                        
                        // Try cleanup
                        const cleanupSuccess = await this.forceCleanup(pinNum);
                        
                        if (cleanupSuccess) {
                            // Wait and retry
                            await this.delay(this.retryDelay * (retries + 1));
                            return await initPinSafe(pinNum, edge, label, retries + 1);
                        } else {
                            console.error(`CoinService: Cleanup failed for GPIO ${pinNum}`);
                            return null;
                        }
                    } else if (err.code === 'EINVAL' && this.isRaspberryPi3) {
                        console.error(`CoinService: Invalid argument for GPIO ${pinNum} - This pin may not be available on Raspberry Pi 3`);
                        return null;
                    } else {
                        console.error(`CoinService: Failed to initialize ${label} GPIO ${pinNum}:`, err.message);
                        return null;
                    }
                }
            };

            // Initialize Coin
            this.coinInsert = await initPinSafe(this.gpioPin, pinEdge, 'Coin');
            if (this.coinInsert) {
                this.coinInsert.watch(this.handleCoinPulse.bind(this));
                console.log('CoinService: Coin GPIO initialized and watching');
            }
            
            // Initialize Bill
            this.billValidator = await initPinSafe(this.billPin, billPinEdge, 'Bill');
            if (this.billValidator) {
                this.billValidator.watch(this.handleBillPulse.bind(this));
                console.log('CoinService: Bill GPIO initialized and watching');
            }

            // Check if at least one pin was successfully initialized
            if (!this.coinInsert && !this.billValidator) {
                console.error('CoinService: Failed to initialize any GPIO pins');
                if (this.isRaspberryPi3) {
                    console.error('CoinService: Raspberry Pi 3 GPIO initialization failed completely');
                    console.error('CoinService: Please check:');
                    console.error('  1. GPIO pins are not being used by other processes');
                    console.error('  2. You have proper permissions (try running as root)');
                    console.error('  3. GPIO pins are not system pins (0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26)');
                    console.error('  4. WiringPi is installed: sudo apt install wiringpi');
                }
            } else {
                console.log('CoinService: GPIO initialization completed successfully');
            }

        } else {
            console.log('CoinService: Running in simulation mode (Windows/No GPIO)');
        }
    }
    
    // Validate GPIO pins for Raspberry Pi 3
    validateRaspberryPi3Pins(pins) {
        const safePins = [2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 17, 18, 22, 23, 24, 25, 27];
        const systemPins = [0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26];
        
        for (const pin of pins) {
            if (systemPins.includes(pin)) {
                console.error(`CoinService: GPIO ${pin} is a system pin and cannot be used`);
                return false;
            }
            if (!safePins.includes(pin)) {
                console.warn(`CoinService: GPIO ${pin} may not be safe for Raspberry Pi 3`);
            }
        }
        
        console.log('CoinService: GPIO pins validation passed for Raspberry Pi 3');
        return true;
    }
    
    // Check system resources before GPIO operations
    async checkSystemResources() {
        try {
            // Check if we have proper permissions
            if (process.getuid && process.getuid() !== 0) {
                console.warn('CoinService: Not running as root - GPIO operations may fail');
            }
            
            // Check if gpio group exists
            try {
                execSync('getent group gpio', { stdio: 'ignore' });
                console.log('CoinService: GPIO group found');
            } catch (e) {
                console.warn('CoinService: GPIO group not found - consider creating it');
            }
            
            // Check memory usage
            const memInfo = fs.readFileSync('/proc/meminfo', 'utf8');
            const memTotal = memInfo.match(/MemTotal:\s+(\d+)/);
            if (memTotal && parseInt(memTotal[1]) < 500000) { // Less than ~500MB
                console.warn('CoinService: Low memory detected - system may be unstable');
            }
            
            console.log('CoinService: System resources check completed');
        } catch (error) {
            console.warn('CoinService: System resources check failed:', error.message);
        }
    }

    triggerBan() {
        if (this.isBanned) return;
        this.isBanned = true;
        console.warn(`CoinService: BANNED for ${this.banDuration} minutes due to suspicious activity (>${this.banLimit}s).`);
        
        // Clear any pending commits
        this.pulseCount = 0;
        this.activityStart = 0;
        if (this.timer) clearTimeout(this.timer);

        // Unban after duration
        setTimeout(() => {
            this.isBanned = false;
            console.log('CoinService: Ban lifted.');
        }, this.banDuration * 60 * 1000);
    }

    checkBanCondition() {
        if (this.isBanned) return true;
        
        const now = Date.now();
        // Start tracking activity duration on first pulse
        if (this.activityStart === 0) {
            this.activityStart = now;
        } else {
            // Check if activity has exceeded the limit
            const durationSeconds = (now - this.activityStart) / 1000;
            if (durationSeconds > this.banLimit) {
                this.triggerBan();
                return true;
            }
        }
        
        return false;
    }

    handleCoinPulse(err, value) {
        if (err) {
            console.error('CoinService: Coin pulse error:', err);
            return;
        }
        
        if (this.checkBanCondition()) return;
        
        const now = Date.now();
        
        // Debounce
        if (now - this.lastPulseTime < this.debounceTime) {
            return;
        }
        
        this.lastPulseTime = now;
        this.pulseCount++;
        
        // Reset activity timer on valid pulse
        if (this.activityStart === 0) {
            this.activityStart = now;
        }
        
        // Clear existing timer
        if (this.timer) clearTimeout(this.timer);
        
        // Set new timer to commit after commitTime
        this.timer = setTimeout(() => {
            this.commitPulses('coin');
        }, this.commitTime);
        
        console.log(`CoinService: Coin pulse detected (count: ${this.pulseCount})`);
    }

    handleBillPulse(err, value) {
        if (err) {
            console.error('CoinService: Bill pulse error:', err);
            return;
        }
        
        if (this.checkBanCondition()) return;
        
        const now = Date.now();
        
        // Debounce
        if (now - this.lastPulseTime < this.debounceTime) {
            return;
        }
        
        this.lastPulseTime = now;
        this.pulseCount++;
        
        // Reset activity timer on valid pulse
        if (this.activityStart === 0) {
            this.activityStart = now;
        }
        
        // Clear existing timer
        if (this.timer) clearTimeout(this.timer);
        
        // Set new timer to commit after commitTime
        this.timer = setTimeout(() => {
            this.commitPulses('bill');
        }, this.commitTime);
        
        console.log(`CoinService: Bill pulse detected (count: ${this.pulseCount})`);
    }

    commitPulses(type) {
        if (this.pulseCount === 0) return;
        
        const multiplier = type === 'bill' ? this.billMultiplier : 1;
        const totalValue = this.pulseCount * multiplier;
        
        console.log(`CoinService: Committing ${this.pulseCount} pulses (${type}) = ${totalValue} value`);
        
        // Emit event
        this.emit('coin-inserted', {
            type: type,
            pulses: this.pulseCount,
            value: totalValue,
            timestamp: Date.now()
        });
        
        // Reset counters
        this.pulseCount = 0;
        this.activityStart = 0;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    // Cleanup method
    async cleanup() {
        console.log('CoinService: Cleaning up GPIO resources...');
        
        if (this.timer) clearTimeout(this.timer);
        if (this.banTimer) clearTimeout(this.banTimer);
        
        if (this.coinInsert) {
            try {
                this.coinInsert.unwatchAll();
                await this.forceCleanup(this.gpioPin);
            } catch (e) {
                console.warn('CoinService: Error cleaning up coin GPIO:', e.message);
            }
            this.coinInsert = null;
        }
        
        if (this.billValidator) {
            try {
                this.billValidator.unwatchAll();
                await this.forceCleanup(this.billPin);
            } catch (e) {
                console.warn('CoinService: Error cleaning up bill GPIO:', e.message);
            }
            this.billValidator = null;
        }
        
        console.log('CoinService: Cleanup completed');
    }
}

module.exports = new CoinServiceRPI3();