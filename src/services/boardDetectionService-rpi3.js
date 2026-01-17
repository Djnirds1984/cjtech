const fs = require('fs');
const { execSync } = require('child_process');
const configService = require('./configService');

class BoardDetectionServiceRPI3 {
    constructor() {
        this.boardModel = null;
        this.gpioMapping = null;
        this.isRaspberryPi3 = false;
        this.hardwareRevision = null;
    }

    init() {
        this.detectBoard();
        this.detectHardwareRevision();
        this.validateGpioPins();
    }

    detectBoard() {
        try {
            // Enhanced detection for Raspberry Pi 3
            if (fs.existsSync('/proc/device-tree/model')) {
                const model = fs.readFileSync('/proc/device-tree/model', 'utf8').trim().replace(/\0/g, '');
                this.boardModel = model;
                
                // Check if it's Raspberry Pi 3
                if (model.includes('Raspberry Pi 3') || model.includes('Raspberry Pi 3 Model B')) {
                    this.isRaspberryPi3 = true;
                    console.log('Board Detection: Raspberry Pi 3 detected');
                    this.setRaspberryPi3GpioMapping();
                    return;
                }
                
                console.log(`Board Detection: Found model: ${model}`);
                this.setGpioMapping(model);
                return;
            }

            // Check /proc/cpuinfo for hardware field
            if (fs.existsSync('/proc/cpuinfo')) {
                const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
                const hardwareMatch = cpuinfo.match(/^Hardware\s*:\s*(.+)$/m);
                if (hardwareMatch) {
                    this.boardModel = hardwareMatch[1].trim();
                    console.log(`Board Detection: Found hardware: ${this.boardModel}`);
                    
                    // Check for BCM2835/2837 (Raspberry Pi 3)
                    if (this.boardModel.includes('BCM2835') || this.boardModel.includes('BCM2837')) {
                        this.isRaspberryPi3 = true;
                        console.log('Board Detection: BCM2835/2837 detected (Raspberry Pi 3)');
                        this.setRaspberryPi3GpioMapping();
                        return;
                    }
                    
                    this.setGpioMapping(this.boardModel);
                    return;
                }
            }

            // Check device tree compatible string
            if (fs.existsSync('/proc/device-tree/compatible')) {
                const compatible = fs.readFileSync('/proc/device-tree/compatible', 'utf8').trim().replace(/\0/g, '');
                const compatibles = compatible.split(',');
                for (const compat of compatibles) {
                    if (compat.includes('raspberrypi,3')) {
                        this.isRaspberryPi3 = true;
                        this.boardModel = 'Raspberry Pi 3B';
                        console.log(`Board Detection: Found compatible: ${this.boardModel}`);
                        this.setRaspberryPi3GpioMapping();
                        return;
                    }
                    if (this.getBoardFromCompatible(compat)) {
                        this.boardModel = this.getBoardFromCompatible(compat);
                        console.log(`Board Detection: Found compatible: ${this.boardModel}`);
                        this.setGpioMapping(this.boardModel);
                        return;
                    }
                }
            }

            // Fallback to Orange Pi One as default
            console.log('Board Detection: No board detected, defaulting to Orange Pi One');
            this.boardModel = 'Orange Pi One';
            this.setGpioMapping(this.boardModel);

        } catch (error) {
            console.error('Board Detection Error:', error.message);
            this.boardModel = 'Orange Pi One';
            this.setGpioMapping(this.boardModel);
        }
    }

    detectHardwareRevision() {
        try {
            if (fs.existsSync('/proc/cpuinfo')) {
                const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
                const revisionMatch = cpuinfo.match(/^Revision\s*:\s*(.+)$/m);
                if (revisionMatch) {
                    this.hardwareRevision = revisionMatch[1].trim();
                    console.log(`Board Detection: Hardware revision: ${this.hardwareRevision}`);
                }
            }
        } catch (error) {
            console.warn('Board Detection: Could not detect hardware revision');
        }
    }

    validateGpioPins() {
        if (this.isRaspberryPi3) {
            // Validate that GPIO pins are safe for Raspberry Pi 3
            const safePins = [2, 3, 4, 14, 15, 17, 18, 22, 23, 24, 25, 26, 27, 10, 9, 11, 8, 7];
            const currentCoinPin = this.gpioMapping?.coin_pin;
            const currentBillPin = this.gpioMapping?.bill_pin;
            const currentRelayPin = this.gpioMapping?.relay_pin;

            if (currentCoinPin && !safePins.includes(currentCoinPin)) {
                console.warn(`Board Detection: GPIO ${currentCoinPin} may not be safe for Raspberry Pi 3, using GPIO 2 instead`);
                this.gpioMapping.coin_pin = 2; // Physical pin 3
            }
            if (currentBillPin && !safePins.includes(currentBillPin)) {
                console.warn(`Board Detection: GPIO ${currentBillPin} may not be safe for Raspberry Pi 3, using GPIO 17 instead`);
                this.gpioMapping.bill_pin = 17; // Physical pin 11
            }
            if (currentRelayPin && !safePins.includes(currentRelayPin)) {
                console.warn(`Board Detection: GPIO ${currentRelayPin} may not be safe for Raspberry Pi 3, using GPIO 27 instead`);
                this.gpioMapping.relay_pin = 27; // Physical pin 13
            }
        }
    }

    setRaspberryPi3GpioMapping() {
        // Optimized GPIO mapping for Raspberry Pi 3
        this.gpioMapping = {
            coin_pin: 2,        // GPIO2 (Physical pin 3) - SDA1, safe for input
            relay_pin: 27,      // GPIO27 (Physical pin 13) - Safe for output
            bill_pin: 17,       // GPIO17 (Physical pin 11) - Safe for input
            coin_pin_edge: 'falling',
            bill_pin_edge: 'falling',
            relay_pin_active: 'LOW',
            board_specific: {
                model: 'Raspberry Pi 3',
                safe_mode: true,
                max_current_ma: 16,  // Maximum current per pin
                total_current_ma: 50,  // Total current for all pins
                voltage: 3.3
            }
        };
        console.log('Board Detection: Applied Raspberry Pi 3 optimized GPIO mapping');
        this.updateConfigSettings();
    }

    getBoardFromCompatible(compat) {
        // Map compatible strings to board names
        const compatMap = {
            'xunlong,orangepi-one': 'Orange Pi One',
            'xunlong,orangepi-pc': 'Orange Pi PC',
            'xunlong,orangepi-pc-plus': 'Orange Pi PC Plus',
            'xunlong,orangepi-plus2e': 'Orange Pi Plus 2E',
            'xunlong,orangepi-zero': 'Orange Pi Zero',
            'xunlong,orangepi-zero2': 'Orange Pi Zero 2',
            'xunlong,orangepi-3': 'Orange Pi 3',
            'xunlong,orangepi-4': 'Orange Pi 4',
            'friendlyarm,nanopi-neo': 'NanoPi NEO',
            'friendlyarm,nanopi-neo2': 'NanoPi NEO2',
            'friendlyarm,nanopi-m1': 'NanoPi M1',
            'raspberrypi,model-zero-w': 'Raspberry Pi Zero W',
            'raspberrypi,model-zero-2-w': 'Raspberry Pi Zero 2 W',
            'raspberrypi,3-model-b': 'Raspberry Pi 3B',
            'raspberrypi,3-model-b-plus': 'Raspberry Pi 3B+',
            'raspberrypi,4-model-b': 'Raspberry Pi 4B'
        };
        return compatMap[compat] || null;
    }

    setGpioMapping(boardModel) {
        // Define GPIO pin mappings for different boards
        const gpioMappings = {
            'Orange Pi One': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Orange Pi PC': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Orange Pi PC Plus': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Orange Pi Plus 2E': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Orange Pi Zero': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Orange Pi Zero 2': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Orange Pi 3': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Orange Pi 4': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'NanoPi NEO': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'NanoPi NEO2': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'NanoPi M1': {
                coin_pin: 12,      // PA12
                relay_pin: 11,     // PA11
                bill_pin: 19,      // PA19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Raspberry Pi Zero W': {
                coin_pin: 12,      // GPIO12
                relay_pin: 11,     // GPIO11
                bill_pin: 19,      // GPIO19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Raspberry Pi Zero 2 W': {
                coin_pin: 12,      // GPIO12
                relay_pin: 11,     // GPIO11
                bill_pin: 19,      // GPIO19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Raspberry Pi 3B': {
                coin_pin: 2,        // GPIO2 (Physical pin 3) - SDA1, safe for input
                relay_pin: 27,      // GPIO27 (Physical pin 13) - Safe for output
                bill_pin: 17,       // GPIO17 (Physical pin 11) - Safe for input
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW',
                board_specific: {
                    model: 'Raspberry Pi 3B',
                    safe_mode: true,
                    max_current_ma: 16,
                    total_current_ma: 50,
                    voltage: 3.3
                }
            },
            'Raspberry Pi 3B+': {
                coin_pin: 2,        // GPIO2 (Physical pin 3) - SDA1, safe for input
                relay_pin: 27,      // GPIO27 (Physical pin 13) - Safe for output
                bill_pin: 17,       // GPIO17 (Physical pin 11) - Safe for input
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW',
                board_specific: {
                    model: 'Raspberry Pi 3B+',
                    safe_mode: true,
                    max_current_ma: 16,
                    total_current_ma: 50,
                    voltage: 3.3
                }
            },
            'Raspberry Pi 4B': {
                coin_pin: 2,        // GPIO2 (Physical pin 3) - SDA1, safe for input
                relay_pin: 27,      // GPIO27 (Physical pin 13) - Safe for output
                bill_pin: 17,       // GPIO17 (Physical pin 11) - Safe for input
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW',
                board_specific: {
                    model: 'Raspberry Pi 4B',
                    safe_mode: true,
                    max_current_ma: 16,
                    total_current_ma: 50,
                    voltage: 3.3
                }
            }
        };

        this.gpioMapping = gpioMappings[boardModel] || gpioMappings['Orange Pi One'];
        console.log(`Board Detection: GPIO mapping for ${boardModel}:`, this.gpioMapping);
        
        // Update config service with board-specific settings
        this.updateConfigSettings();
    }

    updateConfigSettings() {
        if (!this.gpioMapping) return;

        try {
            // Update GPIO pin settings
            if (this.gpioMapping.coin_pin !== undefined) {
                configService.set('coin_pin', this.gpioMapping.coin_pin);
            }
            if (this.gpioMapping.relay_pin !== undefined) {
                configService.set('relay_pin', this.gpioMapping.relay_pin);
            }
            if (this.gpioMapping.bill_pin !== undefined) {
                configService.set('bill_pin', this.gpioMapping.bill_pin);
            }
            if (this.gpioMapping.coin_pin_edge !== undefined) {
                configService.set('coin_pin_edge', this.gpioMapping.coin_pin_edge);
            }
            if (this.gpioMapping.bill_pin_edge !== undefined) {
                configService.set('bill_pin_edge', this.gpioMapping.bill_pin_edge);
            }
            if (this.gpioMapping.relay_pin_active !== undefined) {
                configService.set('relay_pin_active', this.gpioMapping.relay_pin_active);
            }

            console.log('Board Detection: Updated config settings with board-specific GPIO mapping');
        } catch (error) {
            console.error('Board Detection Error updating config:', error.message);
        }
    }

    getBoardModel() {
        return this.boardModel;
    }

    getGpioMapping() {
        return this.gpioMapping;
    }

    isRaspberryPi3Board() {
        return this.isRaspberryPi3;
    }

    getHardwareRevision() {
        return this.hardwareRevision;
    }

    // Method to get GPIO pins for shell scripts
    getGpioPins() {
        if (!this.gpioMapping) return [2, 27, 17]; // Raspberry Pi 3 safe pins
        return [
            this.gpioMapping.coin_pin || 2,
            this.gpioMapping.relay_pin || 27,
            this.gpioMapping.bill_pin || 17
        ];
    }

    // Get safe GPIO pins for Raspberry Pi 3
    getSafeGpioPins() {
        if (this.isRaspberryPi3) {
            return {
                coin_pin: 2,    // GPIO2 (Physical pin 3)
                relay_pin: 27,  // GPIO27 (Physical pin 13)
                bill_pin: 17    // GPIO17 (Physical pin 11)
            };
        }
        return this.gpioMapping;
    }

    // Get board-specific warnings and recommendations
    getBoardWarnings() {
        const warnings = [];
        
        if (this.isRaspberryPi3) {
            warnings.push({
                type: 'info',
                message: 'Raspberry Pi 3 detected - Using safe GPIO pins to prevent system crashes'
            });
            warnings.push({
                type: 'warning',
                message: 'Maximum current per GPIO pin: 16mA, Total current: 50mA'
            });
            warnings.push({
                type: 'warning',
                message: 'Do not connect devices that draw more than 16mA per pin'
            });
        }
        
        return warnings;
    }
}

module.exports = new BoardDetectionServiceRPI3();