const EventEmitter = require('events');
const configService = require('./configService');
const boardDetectionService = require('./boardDetectionService');
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

class CoinService extends EventEmitter {
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
        // Detect board and update config before initializing GPIO
        if (boardDetectionService && typeof boardDetectionService.init === 'function') {
            boardDetectionService.init();
        }

        // Initialize with config
        await this.initGpio().catch(err => console.error('CoinService: Fatal Init Error', err));
    }
    
    // Helper to force unexport a pin if it's busy
    forceCleanup(pin) {
        if (!pin || process.platform === 'win32') return;
        try {
            console.log(`CoinService: Forcing cleanup of GPIO ${pin}...`);
            // Check if exported first to avoid error? sysfs unexport doesn't care much, but good to check.
            if (fs.existsSync(`/sys/class/gpio/gpio${pin}`)) {
                 fs.writeFileSync('/sys/class/gpio/unexport', pin.toString());
                 console.log(`CoinService: Successfully unexported GPIO ${pin}`);
            }
        } catch (e) {
            console.warn(`CoinService: Failed to force cleanup GPIO ${pin}: ${e.message}`);
        }
    }

    async initGpio() {
        // --- Coin Settings ---
        const pin = parseInt(configService.get('coin_pin', 12)); // Default 12 (PA12)
        let pinEdge = configService.get('coin_pin_edge', 'falling');
        if (typeof pinEdge === 'string') pinEdge = pinEdge.toLowerCase();
        
        // --- Bill Settings ---
        const billPin = parseInt(configService.get('bill_pin', 19)); // Default 19 (PA19) - Changed from 15 to avoid EBUSY
        let billPinEdge = configService.get('bill_pin_edge', 'falling');
        if (typeof billPinEdge === 'string') billPinEdge = billPinEdge.toLowerCase();
        this.billMultiplier = parseInt(configService.get('bill_multiplier', 1));
        
        // --- Ban Settings ---
        // User requested "Insert attempt ban Counter: 10s". 
        // We interpret this as a time limit (seconds) for continuous activity before banning.
        this.banLimit = parseInt(configService.get('ban_limit_counter', 10)); 
        this.banDuration = parseInt(configService.get('ban_duration', 1)); // minutes

        // Raspberry Pi 3 GPIO Safety Check
        const boardModel = boardDetectionService.getBoardModel();
        if (boardModel && boardModel.includes('Raspberry Pi 3')) {
            console.log('CoinService: Raspberry Pi 3 detected - Applying GPIO safety checks');
            
            // Validate GPIO pins for RPi3
            const safeRPi3Pins = [2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 17, 18, 22, 23, 24, 25, 27];
            const systemRPi3Pins = [0, 1, 5, 6, 12, 13, 16, 19, 20, 21, 26];
            
            if (systemRPi3Pins.includes(pin)) {
                console.warn(`CoinService: GPIO ${pin} is a system pin on RPi3 - switching to safe alternative`);
                configService.set('coin_pin', 2); // Use GPIO2 (physical pin 3)
            }
            if (systemRPi3Pins.includes(billPin)) {
                console.warn(`CoinService: GPIO ${billPin} is a system pin on RPi3 - switching to safe alternative`);
                configService.set('bill_pin', 17); // Use GPIO17 (physical pin 11)
            }
        }

        console.log(`CoinService: Init Coin(GPIO${pin}, ${pinEdge}) | Bill(GPIO${billPin}, ${billPinEdge}, x${this.billMultiplier}) | Ban(Limit: ${this.banLimit}s, Duration: ${this.banDuration}m)`);

        // Cleanup Coin Object
        if (this.coinInsert) {
             try { this.coinInsert.unexport(); } catch(e){}
             this.coinInsert = null;
        }
        
        // Cleanup Bill Object
        if (this.billValidator) {
             try { this.billValidator.unexport(); } catch(e){}
             this.billValidator = null;
        }

        this.gpioPin = pin;
        this.billPin = billPin;

        if (Gpio) {
            const initPin = async (pinNum, edge, label) => {
                try {
                    const gpio = new Gpio(pinNum, 'in', edge, { debounceTimeout: 50 });
                    return gpio;
                } catch (err) {
                    if (err.code === 'EBUSY') {
                        console.warn(`CoinService: GPIO ${pinNum} is BUSY. Attempting force cleanup...`);
                        this.forceCleanup(pinNum);
                        
                        // Wait for cleanup
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        try {
                            // Retry 1
                            return new Gpio(pinNum, 'in', edge, { debounceTimeout: 50 });
                        } catch (retryErr) {
                            if (retryErr.code === 'EBUSY') {
                                console.warn(`CoinService: GPIO ${pinNum} still BUSY. Trying second cleanup (2s)...`);
                                this.forceCleanup(pinNum);
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                try {
                                    return new Gpio(pinNum, 'in', edge, { debounceTimeout: 50 });
                                } catch (err2) {
                                    console.error(`CoinService: Failed to init ${label} GPIO ${pinNum} after 2nd cleanup:`, err2.message);
                                    return null;
                                }
                            }
                            console.error(`CoinService: Failed to init ${label} GPIO ${pinNum} after cleanup:`, retryErr.message);
                            return null;
                        }
                    } else {
                        console.error(`CoinService: Error initializing ${label} GPIO ${pinNum}:`, err.message);
                        return null;
                    }
                }
            };

            // Coin
            this.coinInsert = await initPin(this.gpioPin, pinEdge, 'Coin');
            if (this.coinInsert) {
                this.coinInsert.watch(this.handleCoinPulse.bind(this));
            }
            
            // Bill
            this.billValidator = await initPin(this.billPin, billPinEdge, 'Bill');
            if (this.billValidator) {
                this.billValidator.watch(this.handleBillPulse.bind(this));
            }

        } else {
            console.log('CoinService: Running in simulation mode (Windows/No GPIO)');
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
        if (this.checkBanCondition()) return;
        
        const now = Date.now();
        
        // Simple debounce
        if (now - this.lastPulseTime < this.debounceTime) return;
        this.lastPulseTime = now;

        this.pulseCount++;
        
        // Reset the commit timer
        if (this.timer) clearTimeout(this.timer);

        this.timer = setTimeout(() => {
            this.commitCoins();
        }, this.commitTime);
    }
    
    handleBillPulse(err, value) {
        if (this.checkBanCondition()) return;
        
        const now = Date.now();
        if (now - this.lastPulseTime < this.debounceTime) return;
        this.lastPulseTime = now;
        
        this.pulseCount += this.billMultiplier; 
        
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.commitCoins();
        }, this.commitTime);
    }

    commitCoins() {
        if (this.pulseCount > 0) {
            console.log(`Coin Inserted: ${this.pulseCount} pulses`);
            this.emit('coin', this.pulseCount);
            this.pulseCount = 0;
            this.activityStart = 0; // Reset activity timer on successful commit
        }
    }
}

module.exports = new CoinService();
