const { db } = require('../database/db');
const fs = require('fs');
const { exec } = require('child_process');

class LogService {
    
    // --- DB Logging ---

    log(level, category, message) {
        try {
            db.prepare("INSERT INTO system_logs (level, category, message) VALUES (?, ?, ?)")
              .run(level, category, message);
        } catch (e) {
            console.error("Failed to write log to DB:", e);
        }
    }

    info(category, message) { this.log('INFO', category, message); }
    warn(category, message) { this.log('WARN', category, message); }
    error(category, message) { this.log('ERROR', category, message); }
    critical(category, message) { this.log('CRITICAL', category, message); }

    // --- Log Retrieval ---

    /**
     * Get System/App Logs from DB
     */
    getSystemLogs(limit = 100) {
        return db.prepare("SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ?").all(limit);
    }

    /**
     * Get Voucher Logs (from vouchers table)
     * Shows usage history
     */
    getVoucherLogs(limit = 100) {
        // Join with users table to get details if needed, but vouchers table has used_by_user_id
        // We focus on used vouchers
        return db.prepare(`
            SELECT v.code, v.plan_name, v.price, v.used_at, u.mac_address, u.ip_address 
            FROM vouchers v
            LEFT JOIN users u ON v.used_by_user_id = u.id
            WHERE v.is_used = 1
            ORDER BY v.used_at DESC
            LIMIT ?
        `).all(limit);
    }

    /**
     * Get PPPoE Logs
     * Reads from syslog on Linux, or returns dummy on Windows
     */
    async getPppoeLogs(limit = 100) {
        if (process.platform === 'win32') {
            return [
                { timestamp: new Date().toISOString(), message: "Windows Dev: PPPoE Server started" },
                { timestamp: new Date().toISOString(), message: "Windows Dev: User 'test' connected" }
            ];
        }

        return new Promise((resolve) => {
            // grep for ppp or pppoe in syslog
            // tail -n limit
            const cmd = `grep -E "pppoe|ppp" /var/log/syslog | tail -n ${limit}`;
            exec(cmd, (err, stdout) => {
                if (err) {
                    // Might fail if syslog doesn't exist or empty grep
                    return resolve([{ timestamp: new Date().toISOString(), message: "No PPPoE logs found or error reading syslog" }]);
                }
                
                // Parse lines roughly
                const lines = stdout.split('\n').filter(l => l).reverse();
                const logs = lines.map(line => {
                    return { raw: line }; 
                });
                resolve(logs);
            });
        });
    }

    /**
     * Get Critical Errors
     * Filter DB logs for ERROR/CRITICAL
     */
    getCriticalErrors(limit = 100) {
        return db.prepare("SELECT * FROM system_logs WHERE level IN ('ERROR', 'CRITICAL') ORDER BY timestamp DESC LIMIT ?").all(limit);
    }
}

module.exports = new LogService();
