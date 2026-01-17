const { exec } = require('child_process');
const path = require('path');
const { db } = require('../database/db');

class FirewallService {
    constructor() {
        this.scriptPath = path.join(__dirname, '../scripts/adblock.sh');
    }

    // Initialize: Restore rules from DB
    async init() {
        console.log("Initializing Firewall / AdBlock Rules...");
        // Flush first
        await this.runScript('flush');

        const rules = this.getRules();
        for (const rule of rules) {
            await this.runScript('block_chain', rule.port, rule.protocol);
        }
    }

    getRules() {
        try {
            return db.prepare('SELECT * FROM firewall_rules ORDER BY created_at DESC').all();
        } catch (e) {
            console.error("Failed to get firewall rules:", e);
            return [];
        }
    }

    async addRule(port, protocol, comment) {
        try {
            const stmt = db.prepare('INSERT INTO firewall_rules (port, protocol, comment) VALUES (?, ?, ?)');
            const info = stmt.run(port, protocol, comment);
            
            // Apply immediately
            await this.runScript('block_chain', port, protocol);
            
            return { id: info.lastInsertRowid, port, protocol, comment };
        } catch (e) {
            console.error("Failed to add rule:", e);
            throw e;
        }
    }

    async removeRule(id) {
        try {
            // Get rule first to know what to unblock
            const rule = db.prepare('SELECT * FROM firewall_rules WHERE id = ?').get(id);
            if (!rule) return false;

            db.prepare('DELETE FROM firewall_rules WHERE id = ?').run(id);
            
            // Apply unblock
            await this.runScript('unblock_chain', rule.port, rule.protocol);
            return true;
        } catch (e) {
            console.error("Failed to remove rule:", e);
            throw e;
        }
    }

    async runScript(command, ...args) {
        return new Promise((resolve, reject) => {
            // Ensure executable
            try { 
                require('child_process').execSync(`sed -i 's/\r$//' "${this.scriptPath}"`);
                require('fs').chmodSync(this.scriptPath, '755'); 
            } catch(e) {}

            const cmd = `bash "${this.scriptPath}" ${command} ${args.join(' ')}`;
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error(`FirewallService Error (${command}):`, stderr);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }
}

module.exports = new FirewallService();
