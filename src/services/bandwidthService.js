const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

class BandwidthService {
    constructor() {
        this.scriptPath = path.join(__dirname, '../scripts/traffic_control.sh');
        this.wanInterface = 'eth0'; // Default, should be configurable via env or DB
        this.lanInterface = 'br0'; // Default (Bridge)
    }

    async init(wan, lan) {
        if(wan) this.wanInterface = wan;
        if(lan) this.lanInterface = lan;
        
        console.log(`Initializing QoS on WAN:${this.wanInterface} LAN:${this.lanInterface}`);
        await this.runScript('init', this.wanInterface, this.lanInterface);
    }

    async setLimit(ip, downKbps, upKbps) {
        if (!ip) return;
        // Defaults if not provided (5Mbps / 1Mbps)
        const down = downKbps || 5120; 
        const up = upKbps || 1024;     
        await this.runScript('limit', this.lanInterface, ip, down, up);
    }

    async removeLimit(ip) {
        if (!ip) return;
        await this.runScript('unlimit', this.lanInterface, ip);
    }

    async setMode(mode) {
        console.log(`Setting QoS Mode: ${mode}`);
        await this.runScript('mode', this.wanInterface, this.lanInterface, mode);
    }

    triggerRageMode(durationSeconds = 300) {
        console.log(`Triggering RAGE MODE for ${durationSeconds} seconds`);
        // Fire and forget - do not await
        // We use the same runScript logic but don't return the promise chain to the caller in a way that blocks response
        this.runScript('rage', this.wanInterface, durationSeconds).catch(err => console.error("Rage Mode Error:", err));
    }

    async runScript(command, ...args) {
        return new Promise((resolve, reject) => {
            // Ensure script is executable and has LF line endings
            try { 
                // We use execSync for setup tasks to ensure they finish before running the script
                // sed -i 's/\r$//' fixes Windows CRLF issues
                require('child_process').execSync(`sed -i 's/\r$//' "${this.scriptPath}"`);
                fs.chmodSync(this.scriptPath, '755'); 
            } catch(e) {
                // Ignore errors here (e.g. sed might fail on Windows dev env, but we care about Linux prod)
            }

            const cmd = `bash "${this.scriptPath}" ${command} ${args.join(' ')}`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    // Log but don't crash (dev environment safe)
                    console.error(`BandwidthService Error (${command}):`);
                    console.error(`  Error:`, error.message);
                    console.error(`  Stderr:`, stderr);
                    console.error(`  Stdout:`, stdout);
                    resolve(false); 
                } else {
                    if (stdout.trim()) console.log(`BandwidthService Output: ${stdout.trim()}`);
                    resolve(true);
                }
            });
        });
    }
}

module.exports = new BandwidthService();
