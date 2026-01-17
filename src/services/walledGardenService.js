const { exec } = require('child_process');
const path = require('path');
const { db } = require('../database/db');
const dns = require('dns');

class WalledGardenService {
    constructor() {
        // Placeholder for script path if needed later
        this.scriptPath = path.join(__dirname, '../scripts/walled_garden.sh');
    }

    getAll() {
        try {
            return db.prepare('SELECT * FROM walled_garden ORDER BY created_at DESC').all();
        } catch (e) {
            console.error("Failed to get walled garden entries:", e);
            return [];
        }
    }

    async resolveDomain(domain) {
        return new Promise((resolve, reject) => {
            dns.lookup(domain, (err, address, family) => {
                if (err) resolve(null); // Return null on failure instead of rejecting
                else resolve(address);
            });
        });
    }

    async init() {
        console.log("Initializing Walled Garden...");
        await this.runScript('init');
        
        // Restore rules from DB (Create dnsmasq configs)
        // Note: 'init' script clears ipsets but doesn't delete dnsmasq files unless we call flush.
        // But to be safe and consistent, we can re-apply all.
        // Actually, dnsmasq configs persist on disk. 'init' just sets up ipsets/iptables.
        // But if we want to ensure sync, we can loop through DB.
        
        const entries = this.getAll();
        for (const entry of entries) {
             await this.runScript('add', entry.domain, entry.type);
        }
    }

    async add(domain, type) {
        try {
            // Normalize domain (remove protocol, path, etc.)
            let cleanDomain = domain.toLowerCase().trim();
            cleanDomain = cleanDomain.replace(/^https?:\/\//, ''); // Remove http:// or https://
            cleanDomain = cleanDomain.replace(/^www\./, ''); // Remove leading www.
            cleanDomain = cleanDomain.split('/')[0]; // Remove path
            cleanDomain = cleanDomain.split(':')[0]; // Remove port
            
            if (!cleanDomain) throw new Error("Invalid domain");

            // Auto-resolve address (For display only)
            const address = await this.resolveDomain(cleanDomain);
            
            const stmt = db.prepare('INSERT INTO walled_garden (domain, type, address) VALUES (?, ?, ?)');
            const info = stmt.run(cleanDomain, type, address || 'Unresolved');
            
            // Apply system changes
            let scriptType = type;
            if (scriptType === 'allow') scriptType = 'ACCEPT';
            if (scriptType === 'deny') scriptType = 'DROP';
            await this.runScript('add', cleanDomain, scriptType);
            
            return { id: info.lastInsertRowid, domain: cleanDomain, type, address: address || 'Unresolved' };
        } catch (e) {
            console.error("Failed to add walled garden entry:", e);
            throw e;
        }
    }

    async remove(id) {
        try {
            const entry = db.prepare('SELECT * FROM walled_garden WHERE id = ?').get(id);
            if (!entry) return false;

            db.prepare('DELETE FROM walled_garden WHERE id = ?').run(id);
            
            // Remove system changes
            await this.runScript('remove', entry.domain);
            
            return true;
        } catch (e) {
            console.error("Failed to remove walled garden entry:", e);
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
                    console.error(`WalledGardenService Error (${command}):`, stderr);
                    // Resolve anyway to avoid crashing app, but log error
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }
}

module.exports = new WalledGardenService();
