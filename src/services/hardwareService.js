const configService = require('./configService');
const fs = require('fs');
const { exec } = require('child_process');

// Use dynamic import for onoff to avoid build errors on Windows dev
let Gpio;
try {
    // Only try to require onoff if not on Windows, or catch the error
    if (process.platform !== 'win32') {
        Gpio = require('onoff').Gpio;
    }
} catch (e) {
    console.log('GPIO not available (Simulation Mode)');
}

class HardwareService {
    constructor() {
        this.relayPin = null;
        this.relay = null;
    }

    init() {
        this.initRelay();
        
        // Start temp monitoring
        setInterval(() => this.monitorTemp(), 60000); // Every minute
    }

    initRelay() {
        const pin = parseInt(configService.get('relay_pin', 11)); // Default 11 (PA11)
        const activeState = configService.get('relay_pin_active', 'HIGH');
        
        // Check if anything changed (Pin or Active State)
        // We need to store current activeState to check for changes
        if (this.relayPin === pin && this.currentActiveState === activeState && this.relay) return; 

        // Clean up old
        if (this.relay) {
            try { this.relay.unexport(); } catch(e){}
            this.relay = null;
        }

        this.relayPin = pin;
        this.currentActiveState = activeState;
        
        if (Gpio) {
            try {
                // Determine OFF state based on Active setting
                // If Active HIGH: ON=1, OFF=0. Initial should be 0.
                // If Active LOW:  ON=0, OFF=1. Initial should be 1.
                const initialVal = activeState === 'HIGH' ? 0 : 1;

                this.relay = new Gpio(this.relayPin, 'out', initialVal);
                console.log(`HardwareService: Relay initialized on GPIO ${this.relayPin} (Active ${activeState})`);
            } catch (e) {
                console.error('HardwareService: Failed to init GPIO (Relay might not work):', e.message);
            }
        }
    }

    setRelay(state) {
        // state: true = ON (Active), false = OFF (Inactive)
        const activeState = configService.get('relay_pin_active', 'HIGH'); // Default HIGH trigger
        
        let val;
        if (activeState === 'HIGH') {
            // Active HIGH: ON=1, OFF=0
            val = state ? 1 : 0;
        } else {
            // Active LOW: ON=0, OFF=1
            val = state ? 0 : 1;
        }

        console.log(`HardwareService: Relay ${state ? 'ON' : 'OFF'} (GPIO val: ${val})`);
        
        if (this.relay) {
            this.relay.writeSync(val);
        }
    }

    // Trigger relay for a duration (e.g., to open a door or flash a light)
    triggerRelay(durationMs = 1000) {
        this.setRelay(true);
        setTimeout(() => this.setRelay(false), durationMs);
    }

    async getCpuTemp() {
        // Linux: /sys/class/thermal/thermal_zone0/temp
        return new Promise(resolve => {
            if (process.platform === 'win32') {
                // Return dynamic mock data for Windows
                const baseTemp = 45;
                const jitter = (Math.random() * 5) - 2.5; // +/- 2.5 degrees
                return resolve(parseFloat((baseTemp + jitter).toFixed(1)));
            }
            
            fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8', (err, data) => {
                if (err) return resolve(null);
                // Value is in millidegrees
                resolve(parseInt(data) / 1000);
            });
        });
    }

    async getDeviceModel() {
        return new Promise(resolve => {
            if (process.platform === 'win32') {
                return resolve('Windows Dev Environment');
            }
            
            // 1. Try Device Tree (ARM / RPi / Orange Pi) - Most accurate for SBCs
            const dtPaths = [
                '/sys/firmware/devicetree/base/model',
                '/proc/device-tree/model'
            ];
            
            for (const p of dtPaths) {
                try {
                    if (fs.existsSync(p)) {
                        const data = fs.readFileSync(p, 'utf8');
                        // Remove null bytes and trim
                        if (data) return resolve(data.replace(/\0/g, '').trim());
                    }
                } catch (e) {}
            }

            // 2. Try DMI Product Name (x86 PCs, Laptops, Mini PCs)
            try {
                const dmiProduct = '/sys/devices/virtual/dmi/id/product_name';
                if (fs.existsSync(dmiProduct)) {
                    const data = fs.readFileSync(dmiProduct, 'utf8');
                    if (data && data.trim()) return resolve(data.trim());
                }
            } catch(e) {}

            // 3. Try DMI Board Name (Motherboard model)
            try {
                const dmiBoard = '/sys/devices/virtual/dmi/id/board_name';
                if (fs.existsSync(dmiBoard)) {
                    const data = fs.readFileSync(dmiBoard, 'utf8');
                    if (data && data.trim()) return resolve(data.trim());
                }
            } catch(e) {}

            // 4. Try /proc/cpuinfo (Older ARM / Fallback)
            try {
                const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
                // Check for 'Hardware' field (common in ARM cpuinfo)
                const hwMatch = cpuinfo.match(/^Hardware\s+:\s+(.+)$/m);
                if (hwMatch && hwMatch[1]) return resolve(hwMatch[1].trim());

                // Check for 'Model' field (sometimes used)
                const modelMatch = cpuinfo.match(/^Model\s+:\s+(.+)$/m);
                if (modelMatch && modelMatch[1]) return resolve(modelMatch[1].trim());
            } catch(e) {}

            // 5. Fallback: hostnamectl (Systemd) or Generic
            exec('hostnamectl', (err, stdout) => {
                if (!err && stdout) {
                    // Try to extract Chassis or Icon Name
                    const chassis = stdout.match(/Chassis:\s+(.+)/);
                    if (chassis && chassis[1]) return resolve('Linux ' + chassis[1].trim());
                }
                resolve('Generic Linux Device');
            });
        });
    }

    async monitorTemp() {
        const temp = await this.getCpuTemp();
        if (!temp) return;

        const threshold = configService.get('temp_threshold', 70);
        if (temp > threshold) {
            console.warn(`[WARNING] CPU Temperature High: ${temp}°C (Threshold: ${threshold}°C)`);
            // In a real scenario, we might trigger a fan or shutdown
            // this.triggerFan(true);
        }
    }
}

module.exports = new HardwareService();
