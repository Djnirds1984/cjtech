const { db } = require('../database/db');
const bandwidthService = require('./bandwidthService');

const { exec } = require('child_process');

class SessionService {
    constructor() {
        this.checkInterval = null;
        this.lastTrafficStats = new Map();
        this.currentSpeeds = new Map();
    }

    startMonitoring(intervalMs = 5000) {
        if (this.checkInterval) clearInterval(this.checkInterval);
        
        const runChecks = async () => {
            try {
                const networkService = require('./networkService');

                // Update traffic stats first (before blocking anyone)
                await this.updateTrafficStats();

                const activeMacs = await networkService.getActiveMacs();
                
                await this.checkConnectivity(activeMacs);
                await this.checkPausedUsers(activeMacs);
                await this.checkIdleUsers();
                await this.checkSessionTimeout();
                await this.syncFirewall(activeMacs);
            } catch (e) {
                console.error("[Session] Error in monitoring loop:", e);
            }
        };

        // Run immediately
        runChecks();

        this.checkInterval = setInterval(runChecks, intervalMs);
        
        console.log(`[Session] Idle monitoring started (Interval: ${intervalMs}ms)`);
    }

    async updateTrafficStats() {
        try {
            const networkService = require('./networkService');
            const currentStats = await networkService.getTrafficStats(); // Map<IP, {bytes_up, bytes_down}>
            const now = Date.now();
            // Avoid division by zero or extremely small intervals
            const timeDiff = Math.max(0.1, (now - (this.lastCheckTime || now)) / 1000); 
            
            if (!this.lastTrafficStats) this.lastTrafficStats = new Map();

            for (const [ip, stats] of currentStats) {
                let deltaUp = 0;
                let deltaDown = 0;
                
                if (this.lastTrafficStats.has(ip)) {
                    const last = this.lastTrafficStats.get(ip);
                    if (stats.bytes_up >= last.bytes_up) {
                        deltaUp = stats.bytes_up - last.bytes_up;
                    } else {
                        // Counter reset? Use current value as delta
                        deltaUp = stats.bytes_up;
                    }
                    
                    if (stats.bytes_down >= last.bytes_down) {
                        deltaDown = stats.bytes_down - last.bytes_down;
                    } else {
                        deltaDown = stats.bytes_down;
                    }
                } else {
                    // First time seeing this IP. 
                    // Do NOT assume total is delta (avoids double counting on restart).
                    // Delta remains 0.
                }
                
                // Calculate Speed (Bytes per second)
                const speedUp = Math.floor(deltaUp / timeDiff);
                const speedDown = Math.floor(deltaDown / timeDiff);
                this.currentSpeeds.set(ip, { dl_speed: speedDown, ul_speed: speedUp });

                // Update DB if there is change
                if (deltaUp > 0 || deltaDown > 0) {
                     // We update by adding delta and resetting idle timer (last_active_at)
                     // Use specific IP to find user
                     // We only update currently connected users to avoid updating old sessions
                     db.prepare(`
                        UPDATE users 
                        SET total_data_up = total_data_up + ?, 
                            total_data_down = total_data_down + ?,
                            last_active_at = CURRENT_TIMESTAMP,
                            last_traffic_at = CURRENT_TIMESTAMP
                        WHERE ip_address = ? AND is_connected = 1
                     `).run(deltaUp, deltaDown, ip);
                }
            }
            
            // Update last known stats
            this.lastTrafficStats = currentStats;
            this.lastCheckTime = now;

        } catch (e) {
            console.error("[Session] Error updating traffic stats:", e);
        }
    }

    getCurrentSpeed(ip) {
        if (!ip) return { dl_speed: 0, ul_speed: 0 };
        return this.currentSpeeds.get(ip) || { dl_speed: 0, ul_speed: 0 };
    }

    async checkConnectivity(activeMacs = null) {
        // Get all connected users
        const connectedUsers = db.prepare('SELECT * FROM users WHERE is_connected = 1 AND is_paused = 0').all();
        
        for (const user of connectedUsers) {
            // Check for Roaming (IP Change) if activeMacs is available
            if (activeMacs && activeMacs.has(user.mac_address)) {
                const newIp = activeMacs.get(user.mac_address);
                if (newIp && newIp !== user.ip_address) {
                    console.log(`[Session] Roaming (Connected) detected for ${user.mac_address}: IP changed ${user.ip_address} -> ${newIp}`);
                    
                    // Update DB
                    db.prepare('UPDATE users SET ip_address = ? WHERE id = ?').run(newIp, user.id);
                    
                    // Update QoS for new IP (and remove old if possible, but let's just set new for now)
                    if (bandwidthService && bandwidthService.setLimit) {
                         // bandwidthService.removeLimit(user.ip_address); // Optional cleanup
                         await bandwidthService.setLimit(newIp, user.download_speed, user.upload_speed);
                    }
                    
                    // Update Firewall Accounting for new IP
                    try {
                        const networkService = require('./networkService');
                        await networkService.allowUser(user.mac_address, newIp);
                    } catch (e) {
                        console.error(`[Session] Failed to update firewall for roamed user ${user.mac_address}:`, e);
                    }

                    user.ip_address = newIp; // Update local object
                }
            }

            // Optimization: Only ping if user hasn't been active/seen recently (e.g. > 30s)
            // last_active_at is updated by traffic stats (traffic = active) or successful ping.
            const lastActive = user.last_active_at ? this.parseDbDate(user.last_active_at) : 0;
            const now = Date.now();
            
            // Only ping if idle for more than 30 seconds
            if (now - lastActive > 30000) {
                this.pingUser(user);
            }
        }
    }

    pingUser(user) {
        if (!user.ip_address) return;

        // Ping timeout 1s, 1 packet
        const cmd = process.platform === 'win32' 
            ? `ping -n 1 -w 1000 ${user.ip_address}`
            : `ping -c 1 -W 1 ${user.ip_address}`;

        exec(cmd, (error, stdout, stderr) => {
            if (!error) {
                // User is active/reachable
                this.updateActivity(user.mac_address);
            } else {
                // User is unreachable, do not update activity.
                // Their 'last_active_at' will age, eventually triggering checkIdleUsers -> pauseUser
            }
        });
    }

    // Helper to parse SQLite UTC timestamps correctly
    parseDbDate(dateStr) {
        if (!dateStr) return null;
        // SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC
        // If we parse this directly in JS, it might be treated as Local Time.
        // We must ensure it's treated as UTC by appending 'Z' if missing.
        if (typeof dateStr === 'string' && !dateStr.endsWith('Z')) {
            return new Date(dateStr + 'Z').getTime();
        }
        return new Date(dateStr).getTime();
    }

    async checkIdleUsers() {
        try {
            const configService = require('./configService');
            const networkService = require('./networkService'); // Import here
            const globalIdleSec = Number(configService.get('idle_timeout_seconds')) || 120;
            const globalKeepaliveSec = Number(configService.get('keepalive_timeout_seconds')) || 300;
            const activeConnSet = await networkService.getActiveConnectionsSnapshot();
            // Get all connected users
            const users = db.prepare(`
                SELECT id, mac_address, ip_address, 
                       last_active_at, last_traffic_at, 
                       keepalive_timeout, idle_timeout 
                FROM users 
                WHERE is_connected = 1 AND is_paused = 0
            `).all();

            const now = Date.now();
            let pingBudget = 10;

            for (const user of users) {
                // 1. Check Keepalive Timeout (Disconnected/Unreachable)
                // last_active_at is updated on successful ping (checkConnectivity -> pingUser)
                const keepaliveTimeout = ((user.keepalive_timeout || globalKeepaliveSec)) * 1000;
                const lastActive = user.last_active_at ? this.parseDbDate(user.last_active_at) : now;
                
                if (now - lastActive > keepaliveTimeout) {
                    console.log(`[Session] User ${user.mac_address} timed out (Keepalive). Pausing session. Last seen: ${user.last_active_at}`);
                    await this.pauseUser(user);
                    continue; // User paused, skip idle check
                }

                // 2. Check Idle Timeout (Active Connections Check)
                // If user has active TCP/UDP connections, we consider them active and reset the timer.
                let hasActiveConns = false;
                if (user.ip_address) {
                    hasActiveConns = activeConnSet.has(user.ip_address);
                }

                if (hasActiveConns) {
                    // Active connections detected -> Reset Idle Timer (Update last_traffic_at)
                    // Optimization: Only update DB if it's been > 10s to reduce write load
                    const lastTrafficTime = user.last_traffic_at ? this.parseDbDate(user.last_traffic_at) : 0;
                    if (now - lastTrafficTime > 10000) {
                         db.prepare("UPDATE users SET last_traffic_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
                         // console.log(`[Session] Active connections detected for ${user.mac_address}. Idle timer reset.`);
                    }
                    continue; // Skip timeout check
                }

                // 3. If NO active connections, check if time has elapsed
                // last_traffic_at is updated above or in app.js traffic loop
                const idleTimeout = ((user.idle_timeout || globalIdleSec)) * 1000;
                const lastTraffic = user.last_traffic_at ? this.parseDbDate(user.last_traffic_at) : now;

                if (now - lastTraffic > idleTimeout) {
                    console.log(`[Session] User ${user.mac_address} timed out (Idle - No Active Connections). Pausing session. Last traffic: ${user.last_traffic_at}`);
                    await this.pauseUser(user, 'Idle Timeout');
                } else if (pingBudget > 0) {
                    // As a fallback keepalive, ping a limited number of users each cycle
                    const la = user.last_active_at ? this.parseDbDate(user.last_active_at) : 0;
                    if (now - la > 30000) {
                        this.pingUser(user);
                        pingBudget--;
                    }
                }
            }
        } catch (e) {
            console.error("[Session] Error checking idle users:", e);
        }
    }

    async checkSessionTimeout() {
        try {
            // Get users with expired sessions
            const expiredUsers = db.prepare(`
                SELECT id, mac_address, ip_address 
                FROM users 
                WHERE session_expiry IS NOT NULL 
                  AND session_expiry < CURRENT_TIMESTAMP
                  AND is_connected = 1
            `).all();

            if (expiredUsers.length > 0) {
                const networkService = require('./networkService');
                
                for (const user of expiredUsers) {
                    console.log(`[Session] User ${user.mac_address} session expired. Forcing re-login.`);
                    
                    // Reset session_expiry to NULL so they get a new session on next login
                    // Set is_connected = 0 to force portal redirect
                    db.prepare('UPDATE users SET is_connected = 0, session_expiry = NULL WHERE id = ?').run(user.id);
                    
                    // Block access immediately
                    await networkService.blockUser(user.mac_address, user.ip_address);
                    
                    if (user.ip_address) {
                        if (bandwidthService && bandwidthService.removeLimit) {
                            await bandwidthService.removeLimit(user.ip_address);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("[Session] Error checking session timeouts:", e);
        }
    }

    async checkPausedUsers(activeMacs = null) {
        return;
    }

    async resumeUser(user) {
        console.log(`[Session] Auto-resuming user: ${user.mac_address}`);
        
        try {
            // Update DB
            db.prepare('UPDATE users SET is_paused = 0, is_connected = 1, last_active_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
            
            // Restore Firewall Access
            // Using require inside function to avoid circular dependency
            const networkService = require('./networkService');
            await networkService.allowUser(user.mac_address, user.ip_address);

            // Restore Traffic Control (QoS)
            if (user.ip_address) {
                if (bandwidthService && bandwidthService.setLimit) {
                    await bandwidthService.setLimit(user.ip_address, user.download_speed, user.upload_speed);
                }
            }
        } catch (e) {
            console.error(`[Session] Failed to resume user ${user.mac_address}:`, e);
        }
    }

    async pauseUser(user, reason = 'Idle') {
        console.log(`[Session] Pausing user: ${user.mac_address} (Reason: ${reason})`);
        
        try {
            // Capture final traffic stats before blocking
            await this.updateTrafficStats();

            // Update DB
            db.prepare('UPDATE users SET is_paused = 1, is_connected = 0 WHERE id = ?').run(user.id);
            
            // Remove from Firewall/Internet
            // We must call blockUser to remove the iptables mark
            // Using require inside function to avoid circular dependency if networkService requires sessionService
            const networkService = require('./networkService');
            await networkService.blockUser(user.mac_address, user.ip_address);

            // Remove from Traffic Control (QoS)
            if (bandwidthService && bandwidthService.removeLimit) {
                await bandwidthService.removeLimit(user.ip_address);
            }
        } catch (e) {
            console.error(`[Session] Failed to pause user ${user.mac_address}:`, e);
        }
    }

    async disconnectUser(user) {
        console.log(`[Session] Disconnecting user: ${user.mac_address}`);
        try {
            // Capture final traffic stats before blocking
            await this.updateTrafficStats();

            // Force re-login behavior
            db.prepare('UPDATE users SET is_connected = 0, is_paused = 0 WHERE id = ?').run(user.id);
            
            // Block firewall access immediately
            const networkService = require('./networkService');
            await networkService.blockUser(user.mac_address, user.ip_address);
            
            // Remove QoS if IP is known
            if (user.ip_address) {
                if (bandwidthService && bandwidthService.removeLimit) {
                    await bandwidthService.removeLimit(user.ip_address);
                }
            }
        } catch (e) {
            console.error(`[Session] Failed to disconnect user ${user.mac_address}:`, e);
        }
    }

    updateActivity(mac) {
        try {
            db.prepare("UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE mac_address = ?").run(mac);
        } catch (e) {
            console.error("[Session] Error updating activity:", e);
        }
    }

    /**
     * Reconciliation Loop: Ensures firewall state matches DB state
     * 1. Get list of MACs currently authorized in iptables
     * 2. Get list of Connected users in DB
     * 3. Sync: Allow missing users, Block unauthorized users
     */
    async syncFirewall(activeMacs = null) {
        try {
            const networkService = require('./networkService');
            
            // 1. Get currently authorized MACs from iptables
            const authorizedMacs = await networkService.getAuthorizedMacs();
            
            // 2. Get Connected Users from DB
            const connectedUsers = db.prepare('SELECT id, mac_address, ip_address, time_remaining, is_paused FROM users WHERE is_connected = 1 AND is_paused = 0 AND time_remaining > 0').all();
            const connectedMacs = new Set(connectedUsers.map(u => u.mac_address.toUpperCase()));

            // 3. Check for Missing Users (In DB but NOT in Firewall) -> ALLOW
            for (const user of connectedUsers) {
                if (!authorizedMacs.has(user.mac_address.toUpperCase())) {
                    console.log(`[Session] Sync: User ${user.mac_address} is connected in DB but missing from Firewall. Re-authorizing.`);
                    await networkService.allowUser(user.mac_address, user.ip_address);
                    // Also restore QoS if needed
                    if (user.ip_address && bandwidthService && bandwidthService.setLimit) {
                         // We don't have speed info in this query, maybe fetch or ignore for now
                         // Ideally we should fetch speeds too
                    }
                }
            }

            // 4. Check for Unauthorized Users (In Firewall but INVALID in DB) -> BLOCK
            if (authorizedMacs.size > 0) {
                for (const mac of authorizedMacs) {
                    // specific check for each mac found in firewall
                    const user = db.prepare('SELECT id, time_remaining, is_paused, ip_address FROM users WHERE mac_address = ?').get(mac);
                    
                    let shouldBlock = false;

                    if (!user) {
                        // User not in DB at all? Block.
                        console.log(`[Session] Sync: MAC ${mac} authorized in firewall but not in DB. Blocking.`);
                        shouldBlock = true;
                    } else if (user.time_remaining <= 0) {
                        // Time expired? Block.
                        console.log(`[Session] Sync: MAC ${mac} authorized but time expired (${user.time_remaining}). Blocking.`);
                        shouldBlock = true;
                    } else if (user.is_paused === 1) {
                        // Paused? Block.
                        console.log(`[Session] Sync: MAC ${mac} authorized but is paused. Blocking.`);
                        shouldBlock = true;
                    } else if (user.is_connected === 0) {
                        // Marked disconnected? Block.
                         console.log(`[Session] Sync: MAC ${mac} authorized but marked disconnected. Blocking.`);
                         shouldBlock = true;
                    }

                    if (shouldBlock) {
                        // Resolve IP if possible
                        let ip = user ? user.ip_address : null;
                        if (!ip && activeMacs && activeMacs.has(mac)) {
                            ip = activeMacs.get(mac);
                        }

                        await networkService.blockUser(mac, ip);
                        
                        // Also ensure DB reflects disconnected state
                        if (user) {
                            db.prepare('UPDATE users SET is_connected = 0 WHERE id = ?').run(user.id);
                        }
                    }
                }
            }
        } catch (e) {
            console.error("[Session] Error in syncFirewall:", e);
        }
    }
}

module.exports = new SessionService();
