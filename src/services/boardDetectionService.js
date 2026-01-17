const fs = require('fs');
const { execSync } = require('child_process');
const configService = require('./configService');

class BoardDetectionService {
    constructor() {
        this.boardModel = null;
        this.gpioMapping = null;
    }

    init() {
        this.detectBoard();
    }

    detectBoard() {
        try {
            // Method 1: Check device tree model
            if (fs.existsSync('/proc/device-tree/model')) {
                const model = fs.readFileSync('/proc/device-tree/model', 'utf8').trim().replace(/\0/g, '');
                this.boardModel = model;
                console.log(`Board Detection: Found model: ${model}`);
                this.setGpioMapping(model);
                return;
            }

            // Method 2: Check /proc/cpuinfo for hardware field
            if (fs.existsSync('/proc/cpuinfo')) {
                const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
                const hardwareMatch = cpuinfo.match(/^Hardware\s*:\s*(.+)$/m);
                if (hardwareMatch) {
                    this.boardModel = hardwareMatch[1].trim();
                    console.log(`Board Detection: Found hardware: ${this.boardModel}`);
                    this.setGpioMapping(this.boardModel);
                    return;
                }
            }

            // Method 3: Check armbian-release file
            if (fs.existsSync('/etc/armbian-release')) {
                const armbianRelease = fs.readFileSync('/etc/armbian-release', 'utf8');
                const boardMatch = armbianRelease.match(/^BOARD=(.+)$/m);
                if (boardMatch) {
                    this.boardModel = boardMatch[1].trim();
                    console.log(`Board Detection: Found Armbian board: ${this.boardModel}`);
                    this.setGpioMapping(this.boardModel);
                    return;
                }
            }

            // Method 4: Check device tree compatible string
            if (fs.existsSync('/proc/device-tree/compatible')) {
                const compatible = fs.readFileSync('/proc/device-tree/compatible', 'utf8').trim().replace(/\0/g, '');
                const compatibles = compatible.split(',');
                for (const compat of compatibles) {
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
                coin_pin: 2,       // GPIO2 (Physical pin 3) - SDA1 - Safe for RPi3
                relay_pin: 27,     // GPIO27 (Physical pin 13) - Safe for RPi3
                bill_pin: 17,      // GPIO17 (Physical pin 11) - Safe for RPi3
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Raspberry Pi 3B+': {
                coin_pin: 2,       // GPIO2 (Physical pin 3) - SDA1 - Safe for RPi3
                relay_pin: 27,     // GPIO27 (Physical pin 13) - Safe for RPi3
                bill_pin: 17,      // GPIO17 (Physical pin 11) - Safe for RPi3
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Raspberry Pi 4B': {
                coin_pin: 12,      // GPIO12
                relay_pin: 11,     // GPIO11
                bill_pin: 19,      // GPIO19
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
            },
            'Raspberry Pi 3': {
                coin_pin: 2,       // GPIO2 (Physical pin 3) - SDA1 - Safe for RPi3
                relay_pin: 27,     // GPIO27 (Physical pin 13) - Safe for RPi3
                bill_pin: 17,      // GPIO17 (Physical pin 11) - Safe for RPi3
                coin_pin_edge: 'falling',
                bill_pin_edge: 'falling',
                relay_pin_active: 'LOW'
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

    // Method to get GPIO pins for shell scripts
    getGpioPins() {
        if (!this.gpioMapping) return [12, 11, 19]; // Default fallback
        return [
            this.gpioMapping.coin_pin || 12,
            this.gpioMapping.relay_pin || 11,
            this.gpioMapping.bill_pin || 19
        ];
    }
}

module.exports = new BoardDetectionService();