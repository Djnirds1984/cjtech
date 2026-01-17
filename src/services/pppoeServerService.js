const { db } = require('../database/db');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const logService = require('./logService');

const CHAP_SECRETS_PATH = '/etc/ppp/chap-secrets';
const SCRIPT_PATH = path.join(__dirname, '../scripts/init_pppoe_server.sh');

class PppoeServerService {
    constructor() {
    }

    async init(wanInterface = 'eth0') {
        this.initializeConfig();
        console.log("Initializing PPPoE Server Service...");
        logService.info('SYSTEM', 'Initializing PPPoE Server Service');
        this.wanInterface = wanInterface;
        this.applyConfig();
    }

    initializeConfig() {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'pppoe_server_config'").get();
        if (!row) {
            const defaultConfig = {
                enabled: false,
                interface: 'br0',
                local_ip: '10.10.10.1',
                remote_start: '10.10.10.2',
                remote_count: 50,
                dns1: '8.8.8.8',
                dns2: '8.8.4.4'
            };
            db.prepare("INSERT INTO settings (key, value, type, category) VALUES (?, ?, 'json', 'network')")
              .run('pppoe_server_config', JSON.stringify(defaultConfig));
        }
    }

    getConfig() {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'pppoe_server_config'").get();
        return row ? JSON.parse(row.value) : {};
    }

    saveConfig(config) {
        db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'pppoe_server_config'")
          .run(JSON.stringify(config));
        
        if (config.enabled) {
            this.applyConfig();
        } else {
            this.stopServer();
        }
        return config;
    }

    // --- Profiles ---
    getProfiles() {
        return db.prepare("SELECT * FROM pppoe_profiles ORDER BY name").all();
    }

    addProfile(profile) {
        const stmt = db.prepare("INSERT INTO pppoe_profiles (name, rate_limit_up, rate_limit_down) VALUES (?, ?, ?)");
        const info = stmt.run(profile.name, profile.rate_limit_up, profile.rate_limit_down);
        return { id: info.lastInsertRowid, ...profile };
    }

    updateProfile(id, profile) {
        db.prepare("UPDATE pppoe_profiles SET name = ?, rate_limit_up = ?, rate_limit_down = ? WHERE id = ?")
          .run(profile.name, profile.rate_limit_up, profile.rate_limit_down, id);
        
        // Update associated users to reflect profile changes
        db.prepare(`
            UPDATE pppoe_users 
            SET profile_name = ?, rate_limit_up = ?, rate_limit_down = ? 
            WHERE profile_id = ?
        `).run(profile.name, profile.rate_limit_up, profile.rate_limit_down, id);

        this.syncSecrets(); // Sync secrets in case of any future dependencies
        return this.getProfile(id);
    }

    getProfile(id) {
        return db.prepare("SELECT * FROM pppoe_profiles WHERE id = ?").get(id);
    }

    deleteProfile(id) {
        db.prepare("DELETE FROM pppoe_profiles WHERE id = ?").run(id);
        
        // Update users who had this profile to have no profile
        db.prepare(`
            UPDATE pppoe_users 
            SET profile_id = NULL, profile_name = NULL, rate_limit_up = 0, rate_limit_down = 0 
            WHERE profile_id = ?
        `).run(id);

        this.syncSecrets();
        return { success: true };
    }

    // --- Users ---
    getUsers() {
        return db.prepare("SELECT * FROM pppoe_users ORDER BY username").all();
    }

    addUser(user) {
        try {
            // Populate profile details if profile_id is provided
            if (user.profile_id) {
                const profile = this.getProfile(user.profile_id);
                if (profile) {
                    user.profile_name = profile.name;
                    user.rate_limit_up = profile.rate_limit_up;
                    user.rate_limit_down = profile.rate_limit_down;
                }
            }
            
            // Ensure defaults for missing fields to avoid SQL errors
            user.profile_name = user.profile_name || null;
            user.rate_limit_up = user.rate_limit_up || 0;
            user.rate_limit_down = user.rate_limit_down || 0;

            const stmt = db.prepare(`
                INSERT INTO pppoe_users (username, password, profile_id, profile_name, rate_limit_up, rate_limit_down, expiration_date)
                VALUES (@username, @password, @profile_id, @profile_name, @rate_limit_up, @rate_limit_down, @expiration_date)
            `);
            const info = stmt.run(user);
            this.syncSecrets();
            logService.info('PPPOE', `Created user ${user.username} (Profile: ${user.profile_name || 'None'})`);
            return { id: info.lastInsertRowid, ...user };
        } catch (e) {
            logService.error('PPPOE', `Failed to create user ${user.username}: ${e.message}`);
            throw e;
        }
    }

    updateUser(id, user) {
        // Populate profile details if profile_id is provided
        if (user.profile_id) {
            const profile = this.getProfile(user.profile_id);
            if (profile) {
                user.profile_name = profile.name;
                user.rate_limit_up = profile.rate_limit_up;
                user.rate_limit_down = profile.rate_limit_down;
            }
        }
        
        // Ensure defaults
        user.profile_name = user.profile_name || null;
        user.rate_limit_up = user.rate_limit_up || 0;
        user.rate_limit_down = user.rate_limit_down || 0;
        user.expiration_date = user.expiration_date || null;
        user.is_active = user.is_active !== undefined ? user.is_active : 1;

        const stmt = db.prepare(`
            UPDATE pppoe_users 
            SET username = @username, password = @password, profile_id = @profile_id, profile_name = @profile_name,
                rate_limit_up = @rate_limit_up, rate_limit_down = @rate_limit_down,
                expiration_date = @expiration_date, is_active = @is_active
            WHERE id = @id
        `);
        stmt.run({ ...user, id });
        this.syncSecrets();
        logService.info('PPPOE', `Updated user ${user.username} (Active: ${user.is_active})`);
        return this.getUser(id);
    }

    getUser(id) {
        return db.prepare("SELECT * FROM pppoe_users WHERE id = ?").get(id);
    }

    deleteUser(id) {
        const user = this.getUser(id);
        db.prepare("DELETE FROM pppoe_users WHERE id = ?").run(id);
        this.syncSecrets();
        if (user) logService.info('PPPOE', `Deleted user ${user.username}`);
        return { success: true };
    }

    syncSecrets() {
        // Read existing secrets (to preserve WAN client secrets if any)
        // Ideally we should manage WAN secrets separately or parse them.
        // For now, we'll rewrite the file with all enabled users from DB.
        // WARNING: This overwrites manual edits or other services.
        // TODO: Merge with WAN client user if exists.

        const users = db.prepare("SELECT * FROM pppoe_users WHERE is_active = 1").all();
        let content = "# Secrets for PPPoE Server\n# client\tserver\tsecret\tIP addresses\n";
        
        users.forEach(u => {
            content += `"${u.username}" * "${u.password}" *\n`;
        });

        // Append WAN Client secret if it exists in settings
        try {
            const wanConfigRow = db.prepare("SELECT value FROM settings WHERE key = 'network_config'").get();
            if (wanConfigRow) {
                const wanConfig = JSON.parse(wanConfigRow.value);
                if (wanConfig.wan && wanConfig.wan.pppoe && wanConfig.wan.pppoe.username) {
                     content += `\n# WAN Client\n"${wanConfig.wan.pppoe.username}" * "${wanConfig.wan.pppoe.password}" *\n`;
                }
            }
        } catch(e) {
            console.error("Error merging WAN secret:", e);
        }

        try {
            fs.writeFileSync(CHAP_SECRETS_PATH, content);
            console.log("CHAP secrets updated.");
        } catch (e) {
            console.error("Failed to write chap-secrets:", e);
            logService.error('PPPOE', `Failed to update chap-secrets: ${e.message}`);
        }
    }

    applyConfig() {
        const config = this.getConfig();
        if (!config.enabled) {
            logService.info('PPPOE', 'PPPoE Server disabled in config');
            return;
        }

        this.syncSecrets();
        
        const wanIface = this.wanInterface || 'eth0';
        const cmd = `bash "${SCRIPT_PATH}" start "${config.interface}" "${config.local_ip}" "${config.remote_start}" "${config.remote_count}" "${config.dns1}" "${config.dns2}" "${wanIface}"`;
        
        logService.info('PPPOE', `Starting PPPoE Server on ${config.interface} (WAN: ${wanIface})`);

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`PPPoE Start Error: ${error.message}`);
                logService.error('PPPOE', `Failed to start server: ${error.message}`);
                return;
            }
            if (stderr) console.error(`PPPoE Start Stderr: ${stderr}`);
            console.log(`PPPoE Start Output: ${stdout}`);
            logService.info('PPPOE', 'PPPoE Server started successfully');
        });
    }

    stopServer() {
        logService.info('PPPOE', 'Stopping PPPoE Server...');
        exec(`bash "${SCRIPT_PATH}" stop`, (error, stdout, stderr) => {
             if (error) {
                 console.error(`PPPoE Stop Error: ${error}`);
                 logService.error('PPPOE', `Failed to stop server: ${error.message}`);
             } else {
                 logService.info('PPPOE', 'PPPoE Server stopped');
             }
        });
    }
}

module.exports = new PppoeServerService();
