const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const { initDb, db } = require('./database/db');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require("socket.io");
const networkService = require('./services/networkService');
const coinService = require('./services/coinService');
const voucherService = require('./services/voucherService');
const bandwidthService = require('./services/bandwidthService');
const monitoringService = require('./services/monitoringService');
const configService = require('./services/configService');
const networkConfigService = require('./services/networkConfigService');
const pppoeServerService = require('./services/pppoeServerService');
const hardwareService = require('./services/hardwareService');
const firewallService = require('./services/firewallService');
const dnsService = require('./services/dnsService');
const sessionService = require('./services/sessionService');
const systemService = require('./services/systemService');
const logService = require('./services/logService');
const chatService = require('./services/chatService');
const walledGardenService = require('./services/walledGardenService');
const crypto = require('crypto');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PORTAL_URL = '/portal';
const SUB_VENDO_OFFLINE_AFTER_MS = 70000;

// Debug: Log paths
console.log('--- Path Debug ---');
console.log('__dirname:', __dirname);
console.log('Public Dir:', path.join(__dirname, '../public'));
console.log('Portal File:', path.join(__dirname, '../public', 'portal.html'));
console.log('------------------');

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
// Trust reverse proxies so req.ip/req.ips/X-Forwarded-For are usable
app.set('trust proxy', true);

// Authentication Middleware
// (Handled later in the file)


function servePortalBanner(absolutePath) {
    return (req, res, next) => {
        try {
            if (absolutePath && fs.existsSync(absolutePath)) {
                try {
                    fs.accessSync(absolutePath, fs.constants.R_OK);
                } catch (e) {
                    return next();
                }
                return res.sendFile(absolutePath, (err) => {
                    if (err) return next();
                });
            }
        } catch (e) {}
        return next();
    };
}

app.get('/op-banner.jpg', servePortalBanner('/root/linux_pisowifi/public/op-banner.jpg'));
app.get('/op-banner.png', servePortalBanner('/root/linux_pisowifi/public/op-banner.png'));
app.get('/op-banner1.jpg', servePortalBanner('/root/linux_pisowifi/public/op-banner1.jpg'));
app.get('/op-banner1.png', servePortalBanner('/root/linux_pisowifi/public/op-banner1.png'));
app.get('/op-banner1', servePortalBanner('/root/linux_pisowifi/public/op-banner1'));
app.get('/op-banner1', servePortalBanner('/root/linux_pisowifi/public/op-banner1.jpg'));
app.get('/op-banner1', servePortalBanner('/root/linux_pisowifi/public/op-banner1.png'));

app.use(express.static(path.join(__dirname, '../public'))); // Fix: Public folder is at root, one level up from src

// Serve Chart.js from node_modules if available (for offline support)
try {
    const chartJsPath = require.resolve('chart.js/dist/chart.umd.js');
    app.get('/js/chart.js', (req, res) => {
        res.sendFile(chartJsPath);
    });
} catch (e) {
    console.log('Chart.js not found in node_modules. Using CDN fallback.');
}

// Routes for Portal and Admin (Clean URLs)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/portal.html'));
});
app.get('/portal', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/portal.html'));
});
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Initialize Database & Services
(async () => {
    try {
        initDb();

        // Initialize Config Services first (after DB is ready)
        configService.init();
        networkConfigService.init();
        
        // Initialize Coin Service (depends on config)
        await coinService.init();

        // Ensure Sub Vendo Key exists
        const existingKey = configService.get('sub_vendo_key');
        if (!existingKey) {
            const defaultKey = crypto.randomBytes(8).toString('hex');
            configService.set('sub_vendo_key', defaultKey);
            console.log(`Generated default Sub Vendo Key: ${defaultKey}`);
        }

        await networkService.init();
        await bandwidthService.init(networkService.wanInterface, 'br0'); // Initialize QoS (CAKE)
        await firewallService.init(); // Initialize Firewall/AdBlocker
        await walledGardenService.init(); // Initialize Walled Garden
        hardwareService.init(); // Initialize Hardware (Relay/Temp)
        await pppoeServerService.init(networkService.wanInterface); // Initialize PPPoE Server
        
        // Restore sessions for active users after restart
        const activeUsers = db.prepare('SELECT mac_address, ip_address, download_speed, upload_speed FROM users WHERE time_remaining > 0 AND is_paused = 0').all();
        console.log(`Restoring ${activeUsers.length} active sessions...`);
        for (const user of activeUsers) {
            await networkService.allowUser(user.mac_address);
            if (user.ip_address) {
                await bandwidthService.setLimit(user.ip_address, user.download_speed, user.upload_speed);
            }
        }
        
        console.log(`System initialized with WAN: ${networkService.wanInterface}`);
        
        // Check Internet Connectivity
        const hasInternet = await networkService.checkInternetConnection();
        if (hasInternet) {
            console.log('✅ Internet Connection: ONLINE');
        } else {
            console.warn('⚠️ Internet Connection: OFFLINE (Check WAN Interface or Cable)');
        }

    } catch (e) {
        console.error('Initialization failed:', e);
    }
})();

// --- Helper Functions ---
function generateClientId() {
    return crypto.randomBytes(16).toString('hex');
}

function generateUserCode() {
    // Generate a 6-character alphanumeric code (Capital letters + Numbers, excluding easily confused ones)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `CJ-${code}`;
}

function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return ip;
    return ip.replace(/^::ffff:/, '');
}

function getClientIp(req) {
    const xfwd = req.headers['x-forwarded-for'];
    if (typeof xfwd === 'string' && xfwd.length > 0) {
        const first = xfwd.split(',')[0].trim();
        return normalizeIp(first);
    }
    if (Array.isArray(req.ips) && req.ips.length > 0) {
        return normalizeIp(req.ips[0]);
    }
    return normalizeIp(req.ip);
}

function generateUniqueUserCode() {
    let userCode = null;
    while (true) {
        userCode = generateUserCode();
        const existing = db.prepare('SELECT id FROM users WHERE user_code = ?').get(userCode);
        if (!existing) return userCode;
    }
}

function getTcClassIdFromIp(ip) {
    if (!ip || typeof ip !== 'string') return null;
    const sanitized = normalizeIp(ip);
    const parts = sanitized.split('.');
    if (parts.length !== 4) return null;
    const last = Number(parts[3]);
    if (!Number.isFinite(last) || last <= 0 || last > 9999) return null;
    return String(last);
}

// --- Time Countdown Loop ---
// Robust loop using setTimeout to prevent overlap and memory issues
let lastTick = Date.now();

// Prepare statements once (Performance Optimization)
const selectActiveUsers = db.prepare('SELECT id, mac_address, ip_address, time_remaining, total_data_up, total_data_down FROM users WHERE time_remaining > 0 AND is_paused = 0');
const updateTime = db.prepare('UPDATE users SET time_remaining = ? WHERE id = ?');
const expireUser = db.prepare('UPDATE users SET time_remaining = 0, is_connected = 0 WHERE id = ?');
const updateTraffic = db.prepare('UPDATE users SET total_data_up = ?, total_data_down = ? WHERE id = ?');
const updateTrafficActivity = db.prepare('UPDATE users SET last_traffic_at = CURRENT_TIMESTAMP WHERE id = ?');
const pauseUser = db.prepare('UPDATE users SET is_paused = 1, is_connected = 0 WHERE id = ?');

// Traffic Cache to calculate deltas
// Key: mac_address, Value: { dl: last_dl_bytes, ul: last_ul_bytes }
const trafficCache = {};

// Counter for traffic sync (run every 5s)
let trafficSyncCounter = 0;

const countdownLoop = async () => {
    try {
        const now = Date.now();
        // Calculate elapsed seconds since last successful tick
        // Use Math.max to prevent negative issues if clock changes
        const deltaSeconds = Math.max(0, Math.floor((now - lastTick) / 1000));
        
        // Only run update if at least 1 second has passed
        if (deltaSeconds >= 1) {
            // 1. Get all active, unpaused users
            const users = selectActiveUsers.all();
            
            // 2. Fetch Traffic Stats if sync interval (every 5s)
            trafficSyncCounter += deltaSeconds;
            let trafficStats = null;
            if (trafficSyncCounter >= 5) {
                trafficStats = await monitoringService.getClientTraffic(configService.get('lan_interface') || 'br0');
                trafficSyncCounter = 0;
            }

            for (const user of users) {
                // Decrement by actual elapsed time
                const newTime = user.time_remaining - deltaSeconds;
                
                if (newTime <= 0) {
                    // Time Expired
                    expireUser.run(user.id);
                    await networkService.blockUser(user.mac_address, user.ip_address);
                    if (user.ip_address) {
                        await bandwidthService.removeLimit(user.ip_address);
                    }
                    console.log(`[Session] User ${user.mac_address} expired (IP: ${user.ip_address || 'N/A'}). Connection removed.`);
                    // Clean up cache
                    delete trafficCache[user.mac_address];
                } else {
                    // Update time
                    updateTime.run(newTime, user.id);
                    
                    // Update Traffic & Check Idle (only if stats fetched)
                    if (trafficStats) {
                        const normalizedIp = normalizeIp(user.ip_address);
                        const hasUl = !!normalizedIp && !!trafficStats.uploads[normalizedIp];
                        const tcId = getTcClassIdFromIp(normalizedIp);
                        const hasDlByIp = !!tcId && !!trafficStats.downloads[tcId];
                        const dlStat = (tcId && trafficStats.downloads[tcId]) || { bytes: 0, idle: 0 };
                        const ulStat = (normalizedIp && trafficStats.uploads[normalizedIp]) || { bytes: 0, idle: 0 };
                        
                        // Calculate Deltas
                        const cache = trafficCache[user.mac_address];
                        if (!cache) {
                            trafficCache[user.mac_address] = { dl: dlStat.bytes || 0, ul: ulStat.bytes || 0 };
                        }
                        
                        // Handle tc reset (if current bytes < last bytes, assume reset and take current as delta)
                        const dlDelta = cache ? (dlStat.bytes >= cache.dl ? dlStat.bytes - cache.dl : dlStat.bytes) : 0;
                        const ulDelta = cache ? (ulStat.bytes >= cache.ul ? ulStat.bytes - cache.ul : ulStat.bytes) : 0;
                        
                        // Update DB if there is traffic
                        if (dlDelta > 0 || ulDelta > 0) {
                            const newTotalDl = (user.total_data_down || 0) + dlDelta;
                            const newTotalUl = (user.total_data_up || 0) + ulDelta;
                            updateTraffic.run(newTotalUl, newTotalDl, user.id);
                            updateTrafficActivity.run(user.id);
                        }

                        trafficCache[user.mac_address] = { dl: dlStat.bytes || 0, ul: ulStat.bytes || 0 };
                        
                        // Auto-Pause on Idle is handled by SessionService (checkIdleUsers)
                    }
                }
            }
            // Update lastTick to now (roughly)
            lastTick = now;
        }
    } catch (e) {
        console.error('Error in countdown loop:', e);
    }

    // Schedule next run
    setTimeout(countdownLoop, 1000);
};

// Start the loop
countdownLoop();

// --- Firewall Sync Loop (Every 60s) ---
// Ensures that connected users in DB are actually allowed in Firewall
setInterval(async () => {
    try {
        await sessionService.syncFirewall();
    } catch (e) {
        console.error('Error in firewall sync loop:', e);
    }
}, 60000);

// --- Coin Listener ---
let currentCoinUser = null;
let coinTimeout = null;

function formatMac(mac) {
    return typeof mac === 'string' ? mac.toLowerCase() : mac;
}

function computeBestRateForAmount(totalAmount) {
    const amount = Number(totalAmount) || 0;
    if (amount <= 0) return { minutes: 0, upload_speed: null, download_speed: null };

    const rates = db.prepare('SELECT * FROM rates ORDER BY amount ASC').all();
    if (!rates || rates.length === 0) return { minutes: 0, upload_speed: null, download_speed: null };

    const bestMinutes = Array(amount + 1).fill(-Infinity);
    const prev = Array(amount + 1).fill(null);
    bestMinutes[0] = 0;

    for (let a = 1; a <= amount; a++) {
        for (const r of rates) {
            const rAmount = Number(r.amount) || 0;
            const rMinutes = Number(r.minutes) || 0;
            if (rAmount <= 0 || rMinutes <= 0 || rAmount > a) continue;

            const candidate = bestMinutes[a - rAmount] + rMinutes;
            if (candidate > bestMinutes[a]) {
                bestMinutes[a] = candidate;
                prev[a] = { from: a - rAmount, rateId: r.id };
            }
        }
    }

    let usedRateIds = [];
    if (bestMinutes[amount] !== -Infinity) {
        let cursor = amount;
        while (cursor > 0 && prev[cursor]) {
            usedRateIds.push(prev[cursor].rateId);
            cursor = prev[cursor].from;
        }
    } else {
        const baseRate = rates.find(r => Number(r.amount) === 1);
        if (!baseRate) return { minutes: 0, upload_speed: null, download_speed: null };
        return {
            minutes: amount * (Number(baseRate.minutes) || 0),
            upload_speed: baseRate.upload_speed,
            download_speed: baseRate.download_speed
        };
    }

    let selectedUpload = null;
    let selectedDownload = null;
    for (const id of usedRateIds) {
        const r = rates.find(x => x.id === id);
        if (!r) continue;
        const ul = Number(r.upload_speed);
        const dl = Number(r.download_speed);
        if (Number.isFinite(ul)) selectedUpload = selectedUpload == null ? ul : Math.max(selectedUpload, ul);
        if (Number.isFinite(dl)) selectedDownload = selectedDownload == null ? dl : Math.max(selectedDownload, dl);
    }

    return {
        minutes: bestMinutes[amount],
        upload_speed: selectedUpload,
        download_speed: selectedDownload
    };
}

async function finalizeCoinSession(reason) {
    if (!currentCoinUser) return { success: false, error: 'No active coin session' };

    const mac = formatMac(currentCoinUser.mac);
    const ip = currentCoinUser.ip;
    const clientId = currentCoinUser.clientId;
    const amount = Number(currentCoinUser.pendingAmount) || 0;
    const saleSource = currentCoinUser.lastSource || currentCoinUser.targetDeviceId || 'hardware';
    const sourceAmounts = currentCoinUser.sourceAmounts || {};

    if (coinTimeout) clearTimeout(coinTimeout);
    coinTimeout = null;
    hardwareService.setRelay(false);
    currentCoinUser = null;

    if (amount <= 0) {
        io.emit('coin_finalized', { mac, amount: 0, secondsAdded: 0, reason });
        return { success: true, amount: 0, secondsAdded: 0 };
    }

    try {
        // Record sales per source
        const sources = sourceAmounts;
        // Fallback if sourceAmounts is empty but amount > 0 (should not happen, but safe fallback)
        if (Object.keys(sources).length === 0) {
            sources[saleSource] = amount;
        }

        const insertSale = db.prepare('INSERT INTO sales (amount, mac_address, source) VALUES (?, ?, ?)');
        
        for (const [src, amt] of Object.entries(sources)) {
            if (amt > 0) {
                insertSale.run(amt, mac, src);
            }
        }
    } catch (err) {
        console.error('[Sales] Error recording sale:', err);
    }
    
    // Calculate best time and speeds using Greedy logic
    const best = calculateTimeFromRates(amount, clientId);
    const minutesToAdd = Number(best.minutes) || 0;
    const secondsToAdd = minutesToAdd * 60;

    if (secondsToAdd <= 0) {
        io.emit('coin_finalized', { mac, amount, secondsAdded: 0, reason });
        return { success: false, error: 'No rate available for this amount' };
    }

    let user = db.prepare('SELECT * FROM users WHERE mac_address = ?').get(mac);
    if (!user) {
        user = db.prepare('SELECT * FROM users WHERE lower(mac_address) = lower(?)').get(mac);
        if (user && user.mac_address !== mac) {
            try {
                db.prepare('UPDATE users SET mac_address = ? WHERE id = ?').run(mac, user.id);
                user = { ...user, mac_address: mac };
            } catch (e) {}
        }
    }
    let userCode = user ? user.user_code : null;
    if (!userCode) userCode = generateUniqueUserCode();

    const prevUpload = (user && user.upload_speed != null) ? Number(user.upload_speed) : 1024;
    const prevDownload = (user && user.download_speed != null) ? Number(user.download_speed) : 5120;
    const nextUpload = (best.upload_speed != null) ? Number(best.upload_speed) : null;
    const nextDownload = (best.download_speed != null) ? Number(best.download_speed) : null;
    let uploadSpeed = (nextUpload != null && nextUpload > prevUpload) ? nextUpload : prevUpload;
    let downloadSpeed = (nextDownload != null && nextDownload > prevDownload) ? nextDownload : prevDownload;

    // Check for Sub-Vendo Device specific bandwidth settings
    if (clientId && Number.isInteger(Number(clientId))) {
        try {
             const svDevice = db.prepare('SELECT download_speed, upload_speed FROM sub_vendo_devices WHERE id = ?').get(clientId);
             if (svDevice) {
                 if (svDevice.download_speed != null) downloadSpeed = svDevice.download_speed;
                 if (svDevice.upload_speed != null) uploadSpeed = svDevice.upload_speed;
             }
        } catch (e) {
             console.error('Error fetching sub-vendo device settings:', e);
        }
    }

    if (user) {
        db.prepare(`
            UPDATE users 
            SET time_remaining = time_remaining + ?, 
                total_time = total_time + ?,
                upload_speed = COALESCE(?, upload_speed), 
                download_speed = COALESCE(?, download_speed), 
                is_paused = 0,
                user_code = COALESCE(user_code, ?),
                ip_address = COALESCE(?, ip_address),
                client_id = ?,
                is_connected = 1,
                last_active_at = CURRENT_TIMESTAMP,
                last_traffic_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(secondsToAdd, secondsToAdd, uploadSpeed, downloadSpeed, userCode, ip, clientId, user.id);
    } else {
        db.prepare(`
            INSERT INTO users (mac_address, ip_address, client_id, time_remaining, total_time, upload_speed, download_speed, is_paused, is_connected, user_code, last_active_at, last_traffic_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(mac, ip, clientId, secondsToAdd, secondsToAdd, uploadSpeed, downloadSpeed, userCode);
    }

    await networkService.allowUser(mac, ip);
    if (ip) await bandwidthService.setLimit(ip, downloadSpeed, uploadSpeed);

    io.emit('user_code_generated', { mac, code: userCode });
    io.emit('coin_finalized', { mac, amount, secondsAdded: secondsToAdd, reason });
    return { success: true, amount, minutesAdded: minutesToAdd, secondsAdded: secondsToAdd };
}

// Helper: Calculate best time for a given amount using available rates
function calculateTimeFromRates(amount, deviceId = null) {
    try {
        // 1. Get all rates sorted by amount DESC (highest first), then minutes DESC (best value first)
        // We cast to INTEGER to ensure numerical sorting even if stored as strings
        let rates;
        let useDeviceRates = false;

        if (deviceId && Number.isInteger(Number(deviceId))) {
             // Check if the device has specific rate configuration
             const hasRates = db.prepare('SELECT 1 FROM sub_vendo_device_rates WHERE device_id = ? LIMIT 1').get(deviceId);
             if (hasRates) {
                 useDeviceRates = true;
             }
        }

        if (useDeviceRates) {
            rates = db.prepare(`
                SELECT r.* 
                FROM rates r
                JOIN sub_vendo_device_rates svr ON r.id = svr.rate_id
                WHERE svr.device_id = ? AND svr.visible = 1
                ORDER BY CAST(r.amount AS INTEGER) DESC, r.minutes DESC
            `).all(deviceId);
        } else {
            rates = db.prepare('SELECT * FROM rates ORDER BY CAST(amount AS INTEGER) DESC, minutes DESC').all();
        }
        
        let remainingAmount = amount;
        let totalMinutes = 0;
        let maxRateUsed = null;
        
        // 2. Greedy approach: match largest denominations first
        for (const rate of rates) {
            if (remainingAmount >= rate.amount) {
                const count = Math.floor(remainingAmount / rate.amount);
                totalMinutes += count * rate.minutes;
                remainingAmount -= count * rate.amount;
                
                if (!maxRateUsed) maxRateUsed = rate; // Capture properties of the largest rate used
            }
        }
        
        // 3. Fallback for any remainder
        if (remainingAmount > 0) {
            const baseRate = rates.find(r => r.amount === 1);
            if (baseRate) {
                totalMinutes += remainingAmount * baseRate.minutes;
                if (!maxRateUsed) maxRateUsed = baseRate;
            }
        }

        return {
            minutes: totalMinutes,
            upload_speed: maxRateUsed ? maxRateUsed.upload_speed : null,
            download_speed: maxRateUsed ? maxRateUsed.download_speed : null
        };
    } catch (err) {
        console.error('Error calculating rates:', err);
        return { minutes: 0, upload_speed: null, download_speed: null };
    }
}

async function handleCoinPulseEvent(pulseCount, source) {
    const pulses = Number(pulseCount) || 0;
    if (pulses <= 0) return;

    io.emit('coin_pulse', { pulses, source });

    if (currentCoinUser) {
        const mode = currentCoinUser.selectionMode || configService.get('vendo_selection_mode') || 'auto';
        if (mode === 'manual' && currentCoinUser.targetDeviceId) {
             // Check if source matches target
             // Source for local is 'hardware', for subvendo is 'subvendo:ID'
             if (source !== currentCoinUser.targetDeviceId) {
                 console.log(`[Coin] Ignored pulse from ${source} (Target: ${currentCoinUser.targetDeviceId})`);
                 return; 
             }
        }

        currentCoinUser.lastSource = source || currentCoinUser.lastSource || 'hardware';
        currentCoinUser.pendingAmount += pulses;
        
        // Track per-source amount
        const src = source || 'hardware';
        if (!currentCoinUser.sourceAmounts) currentCoinUser.sourceAmounts = {};
        if (!currentCoinUser.sourceAmounts[src]) currentCoinUser.sourceAmounts[src] = 0;
        currentCoinUser.sourceAmounts[src] += pulses;

        const totalAmount = currentCoinUser.pendingAmount;

        const best = calculateTimeFromRates(totalAmount, currentCoinUser.clientId);
        const minutes = best.minutes;
        currentCoinUser.pendingMinutes = minutes;

        console.log(`[Coin] ${source || 'unknown'} | User ${currentCoinUser.mac} | Total: P${totalAmount} | Time: ${minutes} mins`);

        io.emit('coin_pending_update', {
            mac: currentCoinUser.mac,
            amount: totalAmount,
            minutes: minutes
        });

        if (coinTimeout) clearTimeout(coinTimeout);
        coinTimeout = setTimeout(() => {
            finalizeCoinSession('timeout').catch(e => console.error('[Coin] Finalize error:', e));
        }, 30000);
    } else {
        console.log(`[Coin] ${source || 'unknown'} pulse ignored: No user in Insert Coin mode`);
    }
}

coinService.on('coin', async (pulseCount) => {
    console.log(`Hardware Coin Event: ${pulseCount} pulses`);
    await handleCoinPulseEvent(pulseCount, 'hardware');
});

// Middleware: Check Session & Seamless Reconnection
app.use(async (req, res, next) => {
    if (req.path.startsWith('/public') || req.path.startsWith('/socket.io')) return next();

    let clientId = req.cookies.client_id;
    if (!clientId) {
        clientId = generateClientId();
        res.cookie('client_id', clientId, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    }

    const clientIp = getClientIp(req);
    const macRaw = await networkService.getMacFromIp(clientIp);
    const mac = formatMac(macRaw);

    // Try to find user by Client ID or MAC
    let user = null;
    
    // 1. Check Cookie (Strongest persistent identifier for roaming)
    if (clientId) {
        user = db.prepare('SELECT * FROM users WHERE client_id = ?').get(clientId);
        
        // Handle MAC Randomization / Roaming
        // If we found a user by cookie, but their MAC has changed (and is valid)
        if (user && mac && user.mac_address !== mac) {
            console.log(`[Roaming] User ${user.id} changed MAC from ${user.mac_address} to ${mac}`);
            
            // Check if the new MAC is already in use by another ACTIVE user
            const existingMacUser = db.prepare('SELECT * FROM users WHERE mac_address = ?').get(mac);
            
            if (existingMacUser && existingMacUser.id !== user.id && existingMacUser.time_remaining > 0) {
                 // Conflict: New MAC belongs to another active user.
                 // Trust the MAC over the cookie in this rare case.
                 console.log(`[Roaming] Conflict: MAC ${mac} belongs to another active user. Switching to that user.`);
                 user = existingMacUser;
            } else {
                 // No conflict (or target is inactive), so we claim the MAC for the Cookie user.
                 
                 // 1. Remove old MAC authorization (clean up)
                 await networkService.blockUser(user.mac_address);
                 
                 // 2. If the new MAC was pointing to a stale user record, clear it to avoid unique constraint error
                 if (existingMacUser) {
                      db.prepare('DELETE FROM users WHERE id = ?').run(existingMacUser.id);
                 }
                 
                 // 3. Update current user to new MAC
                 db.prepare('UPDATE users SET mac_address = ? WHERE id = ?').run(mac, user.id);
                 user.mac_address = mac;
            }
        }
    }

    // 2. Fallback to MAC lookup if no cookie user found
    if (!user && mac) {
        user = db.prepare('SELECT * FROM users WHERE mac_address = ?').get(mac);
        // Case-insensitive check
        if (!user) {
             const caseUser = db.prepare('SELECT * FROM users WHERE lower(mac_address) = lower(?)').get(mac);
             if (caseUser) {
                 // Fix casing in DB
                 db.prepare('UPDATE users SET mac_address = ? WHERE id = ?').run(mac, caseUser.id);
                 user = { ...caseUser, mac_address: mac };
             }
        }
        
        // Auto-link Device ID (Cookie) to User if missing
        // This ensures existing users get linked to their device ID for future roaming
        if (user && clientId && user.client_id !== clientId) {
             console.log(`[Session] Linking User ${user.id} (MAC: ${mac}) to Device ID: ${clientId}`);
             db.prepare('UPDATE users SET client_id = ? WHERE id = ?').run(clientId, user.id);
             user.client_id = clientId;
        }
    }

    if (!mac) {
        console.warn(`[Warning] Could not detect MAC address for IP: ${clientIp}`);
    }

    // Logic: If user exists, has time, AND is not paused
    if (user) {
        req.user = user; // Always attach user so API can return status (even if paused/expired)

        if (user.time_remaining > 0 && user.is_paused === 0) {
            // Initialize session_expiry if not set
            if (!user.session_expiry) {
                const sessionTimeoutMinutes = Number(configService.get('session_timeout_minutes')) || 30; // Default 30 minutes
                const expiryDate = new Date(Date.now() + sessionTimeoutMinutes * 60000);
                // SQLite DATETIME format: YYYY-MM-DD HH:MM:SS
                const expiryStr = expiryDate.toISOString().replace('T', ' ').slice(0, 19);
                db.prepare('UPDATE users SET session_expiry = ? WHERE id = ?').run(expiryStr, user.id);
            }

            const isNewAuth = await networkService.allowUser(user.mac_address);
            
            // Apply bandwidth limit if newly authorized or IP changed
            if (isNewAuth || user.ip_address !== clientIp) {
                 if (user.ip_address && user.ip_address !== clientIp) {
                     await bandwidthService.removeLimit(user.ip_address);
                 }
                 await bandwidthService.setLimit(clientIp, user.download_speed, user.upload_speed);
            }
            
            // Sync IP if changed
            if (user.ip_address !== clientIp) {
                // Safety: Clear this IP from any other users to prevent duplicates
                db.prepare('UPDATE users SET ip_address = NULL WHERE ip_address = ? AND id != ?').run(clientIp, user.id);
                // Update current user
                db.prepare('UPDATE users SET ip_address = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(clientIp, user.id);
            }
            
            // Mark user connected in DB to reflect live status
            if (user.is_connected === 0) {
                db.prepare('UPDATE users SET is_connected = 1, is_paused = 0, updated_at = CURRENT_TIMESTAMP, last_active_at = CURRENT_TIMESTAMP, last_traffic_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
                user.is_connected = 1;
                user.is_paused = 0;
            }
        } else {
            // If paused or no time, ensure blocked
            await networkService.blockUser(user.mac_address);
            // Reflect disconnected status in DB
            if (user.is_connected !== 0) {
                db.prepare('UPDATE users SET is_connected = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
                user.is_connected = 0;
            }
        }
    }

    req.clientId = clientId;
    req.macAddress = mac;
    next();
});

// --- Socket.IO ---
io.on('connection', (socket) => {
    socket.on('disconnect', () => {});

    // --- Chat Events ---
    socket.on('join_chat', ({ mac }) => {
        if (!mac) return;
        
        const enabledSetting = configService.get('chat_enabled');
        const enabled = enabledSetting !== false && enabledSetting !== 'false';

        if (!enabled) {
             socket.emit('chat_status', { enabled: false });
             return;
        }
        
        socket.emit('chat_status', { enabled: true });
        const room = `chat_${mac}`;
        socket.join(room);
        console.log(`Socket ${socket.id} joined room ${room}`);
        
        // Send history
        try {
            const history = chatService.getMessages(mac);
            socket.emit('chat_history', history);
        } catch (e) {
            console.error('Error fetching chat history:', e);
        }
    });

    socket.on('send_message', ({ mac, message }) => {
        if (!mac || !message) return;
        
        const enabledSetting = configService.get('chat_enabled');
        const enabled = enabledSetting !== false && enabledSetting !== 'false';

        if (!enabled) return;

        try {
            chatService.saveMessage(mac, message, false); // isFromAdmin = false
            
            const msgObj = {
                sender: 'user',
                message: message,
                timestamp: new Date()
            };

            // Emit to the room (user sees it)
            io.to(`chat_${mac}`).emit('new_message', msgObj);
            
            // Notify admins
            io.emit('admin_new_message', {
                mac: mac,
                ...msgObj,
                unread_count: 1 
            });

        } catch (e) {
            console.error('Chat save error:', e);
        }
    });

    socket.on('admin_join_chat', ({ mac }) => {
        const room = `chat_${mac}`;
        socket.join(room);
        chatService.markAsRead(mac);
        console.log(`Admin ${socket.id} joined room ${room}`);
    });

    socket.on('admin_send_message', ({ mac, message }) => {
        try {
            chatService.saveMessage(mac, message, true); // isFromAdmin = true
            
            io.to(`chat_${mac}`).emit('new_message', {
                sender: 'admin',
                message: message,
                timestamp: new Date()
            });
        } catch (e) {
            console.error('Admin chat save error:', e);
        }
    });
});

// --- Auth Helper ---
function isAuthenticated(req, res, next) {
    // Check for admin session cookie
    if (req.cookies.admin_session === 'true') {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// --- Routes ---

// 0. Admin Auth
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    
    // Simple check (In production use bcrypt.compare)
    if (admin && admin.password_hash === password) {
        logService.info('SYSTEM', `Admin login successful (User: ${username})`);
        res.cookie('admin_session', 'true', { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
        res.json({ success: true });
    } else {
        logService.warn('SYSTEM', `Admin login failed (User: ${username})`);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    logService.info('SYSTEM', 'Admin logout');
    res.clearCookie('admin_session');
    res.json({ success: true });
});

const resetTokens = new Map(); // Token -> Expiry Timestamp

app.get('/api/auth/security-question', (req, res) => {
    try {
        let admin = db.prepare('SELECT security_question FROM admins WHERE id = 1').get();
        
        // Self-healing: If no question, set default
        if (!admin || !admin.security_question) {
            console.log('No security question found. Seeding default...');
            db.prepare('UPDATE admins SET security_question = ?, security_answer = ? WHERE id = 1')
              .run('What is the name of your first pet?', 'admin');
            admin = { security_question: 'What is the name of your first pet?' };
        }

        if (admin && admin.security_question) {
            res.json({ hasQuestion: true, question: admin.security_question });
        } else {
            // Should not happen due to self-healing
            res.json({ hasQuestion: false });
        }
    } catch (e) {
        console.error('Error fetching security question:', e);
        res.status(500).json({ error: 'Failed to fetch security question' });
    }
});

app.post('/api/auth/verify-security', (req, res) => {
    const { answer } = req.body;
    try {
        const admin = db.prepare('SELECT security_answer FROM admins WHERE id = 1').get();
        if (!admin || !admin.security_answer) {
            return res.status(400).json({ error: 'No security question configured' });
        }

        if (admin.security_answer.toLowerCase().trim() === answer.toLowerCase().trim()) {
            const token = crypto.randomBytes(32).toString('hex');
            resetTokens.set(token, Date.now() + 300000); // 5 minutes validity
            logService.info('SYSTEM', 'Security question verified successfully');
            res.json({ success: true, token });
        } else {
            logService.warn('SYSTEM', 'Security question verification failed');
            res.status(401).json({ error: 'Wrong answer' });
        }
    } catch (e) {
        logService.error('SYSTEM', `Security verification error: ${e.message}`);
        res.status(500).json({ error: 'Verification failed' });
    }
});

app.post('/api/auth/reset-credentials', (req, res) => {
    const { token, username, password, security_question, security_answer } = req.body;
    
    if (!resetTokens.has(token) || resetTokens.get(token) < Date.now()) {
        logService.warn('SYSTEM', 'Password reset attempt with invalid/expired token');
        return res.status(401).json({ error: 'Invalid or expired reset token' });
    }

    if (!username || !password || !security_question || !security_answer) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    try {
        db.prepare(`
            UPDATE admins 
            SET username = ?, password_hash = ?, security_question = ?, security_answer = ? 
            WHERE id = 1
        `).run(username, password, security_question, security_answer);
        
        resetTokens.delete(token); // Consume token
        logService.critical('SYSTEM', `Admin credentials reset via security question (New User: ${username})`);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        logService.error('SYSTEM', `Failed to reset credentials: ${e.message}`);
        res.status(500).json({ error: 'Failed to reset credentials' });
    }
});

// Logs API
app.get('/api/logs', isAuthenticated, async (req, res) => {
    const { source, limit } = req.query;
    const limitVal = parseInt(limit) || 100;
    try {
        let logs = [];
        switch (source) {
            case 'pppoe':
                logs = await logService.getPppoeLogs(limitVal);
                break;
            case 'vouchers':
                logs = logService.getVoucherLogs(limitVal);
                break;
            case 'errors':
                logs = logService.getCriticalErrors(limitVal);
                break;
            case 'system':
            default:
                logs = logService.getSystemLogs(limitVal);
                break;
        }
        res.json(logs);
    } catch (e) {
        console.error("API Logs Error:", e);
        // Ensure we send a JSON response even on error
        res.status(500).json({ 
            error: "Failed to fetch logs", 
            message: e.message, 
            stack: process.env.NODE_ENV === 'development' ? e.stack : undefined 
        });
    }
});

// Chat APIs
app.get('/api/admin/chat/conversations', isAuthenticated, (req, res) => {
    try {
        const convos = chatService.getAllConversations();
        res.json(convos);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/chat/history/:mac', isAuthenticated, (req, res) => {
    try {
        const history = chatService.getMessages(req.params.mac);
        // Mark as read when admin fetches full history
        chatService.markAsRead(req.params.mac);
        res.json(history);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- System Routes ---

// Update Admin Credentials
app.post('/api/admin/security/credentials', isAuthenticated, (req, res) => {
    const { username, password, security_question, security_answer } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    
    try {
        let sql = 'UPDATE admins SET username = ?, password_hash = ?';
        const params = [username, password];

        if (security_question && security_answer) {
            sql += ', security_question = ?, security_answer = ?';
            params.push(security_question, security_answer);
        }

        sql += ' WHERE id = 1';
        db.prepare(sql).run(...params);
        
        logService.warn('SYSTEM', `Admin credentials updated (User: ${username})`);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        logService.error('SYSTEM', `Failed to update credentials: ${e.message}`);
        res.status(500).json({ error: 'Failed to update credentials' });
    }
});

// System Maintenance
app.get('/api/admin/system/verify', isAuthenticated, async (req, res) => {
    try {
        const results = await systemService.verifyConfiguration();
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/system/reboot', isAuthenticated, async (req, res) => {
    try {
        await systemService.reboot();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/system/reset', isAuthenticated, async (req, res) => {
    try {
        await systemService.factoryReset();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/system/upgrade', isAuthenticated, async (req, res) => {
    // type: local or online
    const { type } = req.body;
    try {
        await systemService.upgrade(type);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 0.1 Dashboard Stats
app.get('/api/admin/dashboard', isAuthenticated, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    // Basic System Stats
    // Active Sessions Detail (Removed)

    const stats = {
        uptime: os.uptime(),
        load_avg: os.loadavg(),
        cpu_usage: await monitoringService.getCpuUsage(),
        memory: {
            total: os.totalmem(),
            free: os.freemem()
        },
        storage: await monitoringService.getDiskUsage(),
        cpu_temp: await hardwareService.getCpuTemp(),
        device_model: await hardwareService.getDeviceModel(),
        internet_connected: await monitoringService.checkInternet(),
        total_sales_today: db.prepare("SELECT SUM(amount) as total FROM sales WHERE date(timestamp) = date('now')").get().total || 0,
        total_sales_week: db.prepare("SELECT SUM(amount) as total FROM sales WHERE date(timestamp) >= date('now', '-7 days')").get().total || 0,
        total_sales_month: db.prepare("SELECT SUM(amount) as total FROM sales WHERE date(timestamp) >= date('now', 'start of month')").get().total || 0,
        total_sales_year: db.prepare("SELECT SUM(amount) as total FROM sales WHERE date(timestamp) >= date('now', 'start of year')").get().total || 0
    };
    res.json(stats);
});

// PPPoE Profiles API
app.get('/api/admin/pppoe/profiles', isAuthenticated, (req, res) => {
    try {
        const profiles = pppoeServerService.getProfiles();
        res.json(profiles);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/admin/pppoe/profiles', isAuthenticated, (req, res) => {
    try {
        const profile = pppoeServerService.addProfile(req.body);
        res.json({ success: true, profile });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/api/admin/pppoe/profiles/:id', isAuthenticated, (req, res) => {
    try {
        const profile = pppoeServerService.updateProfile(req.params.id, req.body);
        res.json({ success: true, profile });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/admin/pppoe/profiles/:id', isAuthenticated, (req, res) => {
    try {
        pppoeServerService.deleteProfile(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 0.1.5 Network Interfaces
app.get('/api/admin/network-interfaces', isAuthenticated, async (req, res) => {
    try {
        const interfaces = await monitoringService.getNetworkInterfaces();
        res.json(interfaces);
    } catch (error) {
        console.error("Error fetching interfaces:", error);
        res.status(500).json({ error: "Failed to fetch network interfaces" });
    }
});

// 0.1.6 Update WAN Interface
app.post('/api/admin/settings/wan', isAuthenticated, async (req, res) => {
    const { interface: iface } = req.body;
    if (!iface) return res.status(400).json({ error: 'Interface is required' });
    
    try {
        networkService.saveWanInterface(iface);
        res.json({ success: true, wan_interface: iface });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// System Time & NTP API
app.get('/api/admin/system/time', isAuthenticated, async (req, res) => {
    try {
        const settings = await systemService.getTimeSettings();
        res.json(settings);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/system/time', isAuthenticated, async (req, res) => {
    try {
        await systemService.saveTimeSettings(req.body);
        res.json({ success: true });
    } catch (e) {
        console.error('API Error /api/admin/system/time:', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/system/timezones', isAuthenticated, async (req, res) => {
    try {
        const timezones = await systemService.getTimezones();
        res.json(timezones);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Logs API
app.get('/api/admin/logs/system', isAuthenticated, (req, res) => {
    try {
        const logs = logService.getSystemLogs();
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/logs/pppoe', isAuthenticated, async (req, res) => {
    try {
        const logs = await logService.getPppoeLogs();
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/logs/vouchers', isAuthenticated, (req, res) => {
    try {
        const logs = logService.getVoucherLogs();
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/logs/errors', isAuthenticated, (req, res) => {
    try {
        const logs = logService.getCriticalErrors();
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 0.2 Sales Reports
app.get('/api/admin/sales', isAuthenticated, (req, res) => {
    const type = req.query.type || 'daily'; // daily, weekly, monthly, yearly
    let query = "";
    
    if (type === 'daily') {
        // Last 7 days
        query = `SELECT date(timestamp) as label, SUM(amount) as value FROM sales 
                 WHERE timestamp >= date('now', '-7 days') 
                 GROUP BY date(timestamp) ORDER BY label ASC`;
    } else if (type === 'weekly') {
        // Last 12 weeks
        query = `SELECT strftime('%Y-W%W', timestamp) as label, SUM(amount) as value FROM sales 
                 WHERE timestamp >= date('now', '-84 days') 
                 GROUP BY strftime('%Y-W%W', timestamp) ORDER BY label ASC`;
    } else if (type === 'monthly') {
        // Last 12 months
        query = `SELECT strftime('%Y-%m', timestamp) as label, SUM(amount) as value FROM sales 
                 WHERE timestamp >= date('now', '-12 months') 
                 GROUP BY strftime('%Y-%m', timestamp) ORDER BY label ASC`;
    } else if (type === 'yearly') {
        // Last 5 years
        query = `SELECT strftime('%Y', timestamp) as label, SUM(amount) as value FROM sales 
                 WHERE timestamp >= date('now', '-5 years') 
                 GROUP BY strftime('%Y', timestamp) ORDER BY label ASC`;
    } else if (type === 'history') {
        // Full History (Limit 500 for performance)
        query = `SELECT * FROM sales ORDER BY timestamp DESC LIMIT 500`;
        const data = db.prepare(query).all();
        return res.json(data);
    }
    
    const data = db.prepare(query).all();
    res.json(data);
});

app.get('/api/admin/sales/by-device', isAuthenticated, (req, res) => {
    const type = req.query.type || 'daily';
    try {
        let rangeQuery = '';
        if (type === 'daily') {
            rangeQuery = `datetime(timestamp, 'localtime') >= datetime('now', 'localtime', 'start of day')`;
        } else if (type === 'weekly') {
            rangeQuery = `datetime(timestamp, 'localtime') >= datetime('now', 'localtime', '-7 days')`;
        } else if (type === 'monthly') {
            rangeQuery = `datetime(timestamp, 'localtime') >= datetime('now', 'localtime', 'start of month')`;
        } else if (type === 'yearly') {
            rangeQuery = `datetime(timestamp, 'localtime') >= datetime('now', 'localtime', 'start of year')`;
        } else if (type === 'history') {
            rangeQuery = `1=1`;
        } else {
            return res.status(400).json({ error: 'Invalid type' });
        }

        // 1. Get all unique sources from sales (to capture legacy/unregistered) + 'hardware'
        const salesSources = db.prepare("SELECT DISTINCT COALESCE(source, 'hardware') as source FROM sales").all().map(s => s.source);
        
        // 2. Get all registered sub devices
        const subDevices = db.prepare('SELECT device_id, name, last_coins_out_at FROM sub_vendo_devices').all();
        const deviceInfoById = new Map(subDevices.map(d => [String(d.device_id), { name: d.name, last_coins_out_at: d.last_coins_out_at }]));
        
        // 3. Build Master Set of Sources
        const allSources = new Set(['hardware']);
        salesSources.forEach(s => allSources.add(s));
        subDevices.forEach(d => allSources.add(`subvendo:${d.device_id}`));

        // 4. Pre-fetch Aggregates
        // Total (Based on Filter)
        const totalRows = db.prepare(`
            SELECT COALESCE(source, 'hardware') AS source, SUM(amount) AS total
            FROM ${type === 'history' ? "(SELECT * FROM sales ORDER BY timestamp DESC LIMIT 500)" : "sales"}
            WHERE ${type === 'history' ? "1=1" : rangeQuery}
            GROUP BY COALESCE(source, 'hardware')
        `).all();
        const totalMap = new Map(totalRows.map(r => [String(r.source), Number(r.total) || 0]));

        // Daily (Always Today)
        const todayRows = db.prepare(`
            SELECT COALESCE(source, 'hardware') AS source, SUM(amount) AS daily
            FROM sales
            WHERE date(timestamp, 'localtime') = date('now', 'localtime')
            GROUP BY COALESCE(source, 'hardware')
        `).all();
        const dailyMap = new Map(todayRows.map(r => [String(r.source), Number(r.daily) || 0]));

        const mainCoinsOutAt = configService.get('main_coins_out_at', null);
        const pendingStmt = db.prepare(`
            SELECT SUM(amount) AS pending FROM sales WHERE COALESCE(source, 'hardware') = ? AND (? IS NULL OR timestamp > ?)
        `);

        // 5. Build Result List
        const result = [];
        for (const source of allSources) {
            let name = source;
            let lastOut = null;
            let isHidden = false; // Optional: hide sources with no activity ever?

            if (source === 'hardware') {
                name = 'Main Vendo';
                lastOut = mainCoinsOutAt || null;
            } else if (source.startsWith('subvendo:')) {
                const deviceId = source.slice('subvendo:'.length);
                const info = deviceInfoById.get(deviceId);
                if (info) {
                    name = info.name || `ESP8266 ${deviceId}`;
                    lastOut = info.last_coins_out_at || null;
                } else {
                    // Unregistered subvendo found in sales
                    name = `Unregistered ${deviceId}`;
                }
            }

            const total = totalMap.get(source) || 0;
            const daily = dailyMap.get(source) || 0;
            const pendingRow = pendingStmt.get(source, lastOut, lastOut);
            const pending = (pendingRow && Number(pendingRow.pending)) || 0;

            // Optional: Filter out devices with absolutely zero data to reduce clutter? 
            // User requirement: "every sub vendo(esp8266) must have a Total..."
            // So we list all registered devices + any other source with non-zero metrics.
            const isRegistered = source === 'hardware' || (source.startsWith('subvendo:') && deviceInfoById.has(source.slice('subvendo:'.length)));
            const hasMetrics = total > 0 || daily > 0 || pending > 0;

            if (isRegistered || hasMetrics) {
                result.push({ source, name, total, daily, pending });
            }
        }
        
        // Sort by Total DESC
        result.sort((a, b) => b.total - a.total);

        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/sales/coins-out', isAuthenticated, (req, res) => {
    console.log('[API] Coins Out Request:', req.body);
    try {
        const { source } = req.body || {};
        if (!source) return res.status(400).json({ error: 'source required' });
        // Use UTC format YYYY-MM-DD HH:MM:SS to match SQLite CURRENT_TIMESTAMP
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        if (source === 'hardware') {
            configService.set('main_coins_out_at', now);
        } else if (source.startsWith('subvendo:')) {
            const deviceId = source.slice('subvendo:'.length);
            db.prepare('UPDATE sub_vendo_devices SET last_coins_out_at = ? WHERE device_id = ?').run(now, deviceId);
        } else {
            configService.set(`coins_out_at_${source}`, now);
        }
        res.json({ success: true, coins_out_at: now });
    } catch (e) {
        console.error('[API] Coins Out Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// 0.4 Settings
app.get('/api/admin/settings', isAuthenticated, (req, res) => {
    const allSettings = configService.getAll();
    const filteredSettings = { ...allSettings };
    const hiddenKeys = [
        'wan_interface', 
        'lan_interface', 
        'portal_port', 
        'temp_threshold', 
        'rate_1_peso', 
        'rate_5_peso', 
        'rate_10_peso'
    ];
    hiddenKeys.forEach(key => delete filteredSettings[key]);
    res.json(filteredSettings);
});

app.post('/api/admin/settings', isAuthenticated, (req, res) => {
    const settings = req.body; // Expect { key: value, ... }
    for (const [key, value] of Object.entries(settings)) {
        configService.set(key, value);
    }
    // Trigger re-init of services if needed
    coinService.initGpio();
    hardwareService.initRelay();
    res.json({ success: true });
});

// 0.4.1 Portal Configuration
app.get('/api/portal/config', (req, res) => {
    const config = {
        container_max_width: configService.get('portal_container_width'),
        icon_size: configService.get('portal_icon_size'),
        status_icon_container_size: configService.get('portal_status_icon_container_size'),
        banner_height: configService.get('portal_banner_height'),
        banner_version: configService.get('portal_banner_version') || Date.now(),
        banner_filename: configService.get('portal_banner_filename'),
        use_default_banner: configService.get('portal_use_default_banner'),
        default_banner_file: configService.get('portal_default_banner_file'),
        hide_voucher_code: configService.get('portal_hide_voucher_code')
    };
    res.json(config);
});

// 0.5 PPPoE Server API
app.get('/api/admin/pppoe/config', isAuthenticated, (req, res) => {
    try {
        const config = pppoeServerService.getConfig();
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/pppoe/config', isAuthenticated, (req, res) => {
    try {
        const config = pppoeServerService.saveConfig(req.body);
        res.json({ success: true, config });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/pppoe/users', isAuthenticated, (req, res) => {
    try {
        const users = pppoeServerService.getUsers();
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/pppoe/users', isAuthenticated, (req, res) => {
    try {
        const user = pppoeServerService.addUser(req.body);
        res.json({ success: true, user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/pppoe/users/:id', isAuthenticated, (req, res) => {
    try {
        const user = pppoeServerService.updateUser(req.params.id, req.body);
        res.json({ success: true, user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/pppoe/users/:id', isAuthenticated, (req, res) => {
    try {
        pppoeServerService.deleteUser(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/portal-config', isAuthenticated, (req, res) => {
    const { container_width, icon_size, status_container_size, banner_height, use_default_banner, default_banner_file, hide_voucher_code } = req.body;
    if (container_width) configService.set('portal_container_width', container_width);
    if (icon_size) configService.set('portal_icon_size', icon_size);
    if (status_container_size) configService.set('portal_status_icon_container_size', status_container_size);
    if (banner_height) configService.set('portal_banner_height', banner_height);
    if (default_banner_file) configService.set('portal_default_banner_file', default_banner_file);
    
    // Boolean setting
    configService.set('portal_use_default_banner', !!use_default_banner);
    configService.set('portal_hide_voucher_code', !!hide_voucher_code);
    
    res.json({ success: true });
});

app.post('/api/admin/upload-banner', isAuthenticated, (req, res) => {
    const { image, type } = req.body;
    if (!image || !type) return res.status(400).json({ error: 'Missing image data' });
    
    try {
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');
        const ext = type === 'image/png' ? 'png' : 'jpg';
        const filename = `custom-banner.${ext}`;
        const filepath = path.join(__dirname, '../public', filename);
        
        fs.writeFileSync(filepath, buffer);
        configService.set('portal_banner_version', Date.now()); // Force refresh
        configService.set('portal_banner_filename', filename);
        
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to save banner' });
    }
});


app.get('/api/admin/walled-garden', isAuthenticated, (req, res) => {
    try {
        const list = walledGardenService.getAll();
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/walled-garden', isAuthenticated, async (req, res) => {
    const { domain, type } = req.body;
    if (!domain || !type) return res.status(400).json({ error: 'Domain and Type are required' });
    
    try {
        const entry = await walledGardenService.add(domain, type);
        res.json({ success: true, entry });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/walled-garden/:id', isAuthenticated, (req, res) => {
    try {
        const success = walledGardenService.remove(req.params.id);
        res.json({ success });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Sub Vendo API ---

// 1. Get Key
app.get('/api/admin/subvendo/key', isAuthenticated, (req, res) => {
    const key = configService.get('sub_vendo_key') || '';
    res.json({ key });
});

// 2. Set Key
app.post('/api/admin/subvendo/key', isAuthenticated, (req, res) => {
    const { key } = req.body;
    configService.set('sub_vendo_key', key || '');
    res.json({ success: true });
});

app.get('/api/admin/subvendo/free-time', isAuthenticated, (req, res) => {
    try {
        const raw = configService.get('sub_vendo_free_time');
        const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        res.json(cfg);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/subvendo/free-time', isAuthenticated, (req, res) => {
    try {
        const body = req.body || {};
        const raw = configService.get('sub_vendo_free_time');
        const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        const vlans = networkConfigService.getVlans() || [];

        Object.keys(body).forEach(key => {
            const v = body[key];
            if (!v || typeof v !== 'object') return;

            const enabled = v.enabled === true || v.enabled === 1 || v.enabled === '1';
            const widgetEnabled = v.widget_enabled === true || v.widget_enabled === 1 || v.widget_enabled === '1';
            let minutes = parseFloat(v.minutes);
            if (!Number.isFinite(minutes) || minutes <= 0) minutes = 0;
            const reclaimPeriod = typeof v.reclaim_period === 'string' ? v.reclaim_period : '24:00:00';

            // Basic validation: Check if key is eth0/br0 or a valid VLAN interface
            let isValid = (key === 'eth0' || key === 'br0');
            if (!isValid) {
                const vlan = vlans.find(x => {
                    const parent = String(x.parent);
                    const vlanId = String(x.vlanId);
                    const iface = `${parent}.${vlanId}`;
                    return iface === key;
                });
                if (vlan) isValid = true;
            }

            if (isValid) {
                 cfg[key] = {
                    enabled,
                    widget_enabled: widgetEnabled,
                    minutes,
                    reclaim_period: reclaimPeriod
                };
            }
        });

        configService.set('sub_vendo_free_time', cfg);
        res.json({ success: true, config: cfg });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. List Devices
app.get('/api/admin/subvendo/devices', isAuthenticated, (req, res) => {
    try {
        const devices = db.prepare('SELECT * FROM sub_vendo_devices ORDER BY created_at DESC').all();
        const now = Date.now();
        // Calculate start of day in local time for daily sales
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayIso = today.toISOString(); // Note: sales timestamp is usually UTC/ISO

        const enrichedDevices = devices.map(d => {
            let online = false;
            if (d.last_active_at) {
                const raw = String(d.last_active_at);
                const parsedA = new Date(raw);
                const parsedB = new Date(raw.includes('T') ? raw : (raw.replace(' ', 'T') + 'Z'));
                const lastActive = isNaN(parsedA.getTime()) ? parsedB : parsedA;
                if (!isNaN(lastActive.getTime())) {
                    const diffMs = now - lastActive.getTime();
                    if (diffMs < SUB_VENDO_OFFLINE_AFTER_MS) online = true;
                }
            }

            // Sales Stats
            const source = `subvendo:${d.id}`;
            const totalSales = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM sales WHERE source = ?").get(source).total;
            
            // For Daily Sales, we compare timestamp. 
            // Assuming sales.timestamp is in ISO format or compatible with SQLite string comparison.
            // If sales.timestamp is 'YYYY-MM-DD HH:MM:SS', we need to be careful with timezone.
            // Using SQLite 'start of day' is safer if timestamps are standard.
            const dailySales = db.prepare(`
                SELECT COALESCE(SUM(amount), 0) as total 
                FROM sales 
                WHERE source = ? AND timestamp >= datetime('now', 'start of day', 'localtime')
            `).get(source).total;

            const lastCoinsOut = d.last_coins_out_at || '1970-01-01 00:00:00';
            const unCoinsOutSales = db.prepare(`
                SELECT COALESCE(SUM(amount), 0) as total 
                FROM sales 
                WHERE source = ? AND timestamp > ?
            `).get(source, lastCoinsOut).total;

            return {
                ...d,
                online,
                total_sales: totalSales,
                daily_sales: dailySales,
                uncoins_out_sales: unCoinsOutSales
            };
        });
        res.json(enrichedDevices);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3.1 Coins Out
app.post('/api/admin/subvendo/devices/:id/coins-out', isAuthenticated, (req, res) => {
    try {
        const id = req.params.id;
        db.prepare("UPDATE sub_vendo_devices SET last_coins_out_at = datetime('now', 'localtime') WHERE id = ?").run(id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Delete Device
app.delete('/api/admin/subvendo/devices/:id', isAuthenticated, (req, res) => {
    try {
        db.prepare('DELETE FROM sub_vendo_devices WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4.1 Update Device
app.put('/api/admin/subvendo/devices/:id', isAuthenticated, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name : null;
    const description = typeof body.description === 'string' ? body.description : null;

    const asIntOrNull = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    };

    const coinPin = asIntOrNull(body.coin_pin);
    const relayPin = asIntOrNull(body.relay_pin);
    const pesoPerPulse = asIntOrNull(body.peso_per_pulse);
    const downloadSpeed = asIntOrNull(body.download_speed);
    const uploadSpeed = asIntOrNull(body.upload_speed);

    if (coinPin != null && (coinPin < 0 || coinPin > 16)) return res.status(400).json({ error: 'Invalid coin pin' });
    if (relayPin != null && (relayPin < 0 || relayPin > 16)) return res.status(400).json({ error: 'Invalid relay pin' });
    if (pesoPerPulse != null && (pesoPerPulse < 1 || pesoPerPulse > 100)) return res.status(400).json({ error: 'Invalid vendo rate' });

    try {
        db.prepare(`
            UPDATE sub_vendo_devices
            SET name = COALESCE(?, name),
                description = COALESCE(?, description),
                coin_pin = COALESCE(?, coin_pin),
                relay_pin = COALESCE(?, relay_pin),
                peso_per_pulse = COALESCE(?, peso_per_pulse),
                download_speed = COALESCE(?, download_speed),
                upload_speed = COALESCE(?, upload_speed)
            WHERE id = ?
        `).run(name, description, coinPin, relayPin, pesoPerPulse, downloadSpeed, uploadSpeed, id);

        const device = db.prepare('SELECT * FROM sub_vendo_devices WHERE id = ?').get(id);
        res.json({ success: true, device });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/subvendo/devices/:id/rates', isAuthenticated, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    try {
        const allRates = db.prepare('SELECT * FROM rates ORDER BY amount ASC').all();
        const vis = db.prepare('SELECT rate_id FROM sub_vendo_device_rates WHERE device_id = ? AND visible = 1').all(id).map(r => r.rate_id);
        const result = allRates.map(r => ({
            ...r,
            visible: vis.includes(r.id)
        }));
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/subvendo/devices/:id/rates', isAuthenticated, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const body = req.body || {};
    const visibleRateIds = Array.isArray(body.visible_rate_ids) ? body.visible_rate_ids.map(Number).filter(Number.isFinite) : [];
    try {
        const device = db.prepare('SELECT id FROM sub_vendo_devices WHERE id = ?').get(id);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        db.prepare('DELETE FROM sub_vendo_device_rates WHERE device_id = ?').run(id);
        const stmt = db.prepare('INSERT INTO sub_vendo_device_rates (device_id, rate_id, visible) VALUES (?, ?, 1)');
        for (const rid of visibleRateIds) {
            const r = db.prepare('SELECT id FROM rates WHERE id = ?').get(rid);
            if (r) stmt.run(id, rid);
        }
        const vis = db.prepare('SELECT rate_id FROM sub_vendo_device_rates WHERE device_id = ? AND visible = 1').all(id);
        res.json({ success: true, visible_rate_ids: vis.map(x => x.rate_id) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Auth/Bind (Public Endpoint for ESP8266)
app.post('/api/subvendo/auth', (req, res) => {
    const { key, device_id, name } = req.body;
    
    // 1. Validate Key
    const masterKey = configService.get('sub_vendo_key');
    // If no master key set, disable registration
    if (!masterKey) {
        return res.status(403).json({ error: 'Sub Vendo registration disabled (No key set)' });
    }

    if (masterKey !== key) {
        return res.status(401).json({ error: 'Invalid authentication key' });
    }

    if (!device_id) {
        return res.status(400).json({ error: 'Device ID is required' });
    }

    try {
        // 2. Check if device exists
        let device = db.prepare('SELECT * FROM sub_vendo_devices WHERE device_id = ?').get(device_id);
        
        const now = new Date().toISOString();

        if (device) {
            // Update last active
            db.prepare(`
                UPDATE sub_vendo_devices
                SET last_active_at = ?,
                    status = ?,
                    name = CASE
                        WHEN name IS NULL OR name = '' OR name = 'Unknown Device' THEN COALESCE(?, name)
                        ELSE name
                    END
                WHERE id = ?
            `).run(now, 'active', name, device.id);
        } else {
            // Register new device
            db.prepare('INSERT INTO sub_vendo_devices (device_id, name, status, last_active_at) VALUES (?, ?, ?, ?)')
                .run(device_id, name || 'Unknown Device', 'active', now);
        }

        device = db.prepare('SELECT * FROM sub_vendo_devices WHERE device_id = ?').get(device_id);
        console.log(`[SubVendo] Auth/Heartbeat from ${device_id} (${name}) at ${now}`);
        res.json({ success: true, message: 'Authenticated and binded successfully', device });
    } catch (e) {
        console.error('Sub Vendo Auth Error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/subvendo/pulse', (req, res) => {
    const { key, device_id, pulses } = req.body || {};

    const masterKey = configService.get('sub_vendo_key');
    if (!masterKey) return res.status(403).json({ error: 'Sub Vendo disabled (No key set)' });
    if (masterKey !== key) return res.status(401).json({ error: 'Invalid authentication key' });
    if (!device_id) return res.status(400).json({ error: 'Device ID is required' });

    const count = Math.trunc(Number(pulses));
    if (!Number.isFinite(count) || count <= 0 || count > 200) return res.status(400).json({ error: 'Invalid pulses' });

    try {
        const device = db.prepare('SELECT * FROM sub_vendo_devices WHERE device_id = ?').get(device_id);
        if (!device) return res.status(404).json({ error: 'Device not registered' });
        if (device.status && device.status !== 'active') return res.status(403).json({ error: 'Device inactive' });
        
        const now = new Date().toISOString();
        db.prepare('UPDATE sub_vendo_devices SET last_active_at = ? WHERE id = ?').run(now, device.id);

        const pesoPerPulse = Number(device.peso_per_pulse) > 0 ? Number(device.peso_per_pulse) : 1;
        const amount = count * pesoPerPulse;
        handleCoinPulseEvent(amount, `subvendo:${device_id}`).catch(() => {});

        res.json({ success: true, pulses: count, amount });
    } catch (e) {
        console.error('Sub Vendo Pulse Error:', e);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 0.5 Network Stats (Existing)
app.get('/api/admin/network-stats', isAuthenticated, async (req, res) => {
    const stats = await monitoringService.getInterfaceStats();
    res.json(stats);
});

// 0.5.1 QoS Configuration
app.get('/api/admin/qos/config', isAuthenticated, (req, res) => {
    res.json({
        default_download_speed: configService.get('default_download_speed') || 5120,
        default_upload_speed: configService.get('default_upload_speed') || 1024,
        qos_mode: configService.get('qos_mode') || 'gaming'
    });
});

app.post('/api/admin/qos/config', isAuthenticated, async (req, res) => {
    const { default_download_speed, default_upload_speed, qos_mode } = req.body;
    if (default_download_speed) configService.set('default_download_speed', default_download_speed);
    if (default_upload_speed) configService.set('default_upload_speed', default_upload_speed);
    
    if (qos_mode) {
        configService.set('qos_mode', qos_mode);
        // Apply Mode
        await bandwidthService.setMode(qos_mode);
    }
    
    res.json({ success: true });
});

app.post('/api/admin/qos/rage', isAuthenticated, (req, res) => {
    // 5 minutes default
    bandwidthService.triggerRageMode(300);
    res.json({ success: true, message: "Rage Mode Activated!" });
});

app.post('/api/admin/qos/limit', isAuthenticated, async (req, res) => {
    const { ip, download_speed, upload_speed } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP Address is required' });

    try {
        // Update DB
        const result = db.prepare('UPDATE users SET download_speed = ?, upload_speed = ? WHERE ip_address = ?').run(download_speed, upload_speed, ip);
        
        if (result.changes > 0) {
            // Apply immediately
            await bandwidthService.setLimit(ip, download_speed, upload_speed);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'User not found or IP not assigned' });
        }
    } catch (e) {
        console.error("QoS Limit Error:", e);
        res.status(500).json({ error: "Failed to set limit" });
    }
});



// 0.6 Network Configuration
app.get('/api/admin/network/status', isAuthenticated, async (req, res) => {
    try {
        const isOnline = await networkService.checkInternetConnection();
        res.json({ online: isOnline });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/network/wan', isAuthenticated, (req, res) => {
    res.json(networkConfigService.getWanConfig());
});

app.post('/api/admin/network/wan', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.setWanConfig(req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to save WAN configuration" });
    }
});

// ZeroTier
app.get('/api/admin/network/zerotier', isAuthenticated, async (req, res) => {
    const status = await networkService.getZeroTierStatus();
    res.json(status);
});

app.post('/api/admin/network/zerotier/join', isAuthenticated, async (req, res) => {
    try {
        const { networkId } = req.body;
        const success = await networkService.joinZeroTier(networkId);
        if (success) res.json({ success: true });
        else res.status(500).json({ error: "Failed to join network" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/network/zerotier/leave', isAuthenticated, async (req, res) => {
    try {
        const { networkId } = req.body;
        const success = await networkService.leaveZeroTier(networkId);
        if (success) res.json({ success: true });
        else res.status(500).json({ error: "Failed to leave network" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/network/vlans', isAuthenticated, (req, res) => {
    res.json(networkConfigService.getVlans());
});

app.post('/api/admin/network/vlans', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.addVlan(req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to add VLAN" });
    }
});

app.delete('/api/admin/network/vlans/:id', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.removeVlan(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to remove VLAN" });
    }
});

app.get('/api/admin/network/dhcp', isAuthenticated, (req, res) => {
    try {
        const cfg = networkConfigService.getDhcpConfig();
        res.json({
            bitmask: cfg.bitmask,
            maxServers: cfg.maxServers,
            servers: cfg.servers || []
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/network/dhcp', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.setDhcpGlobals(req.body || {});
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/network/dhcp/servers', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.addDhcpServer(req.body || {});
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/network/dhcp/servers/:id', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.removeDhcpServer(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bridge Configuration
app.get('/api/admin/network/bridges', isAuthenticated, (req, res) => {
    try {
        const bridges = networkConfigService.getBridges();
        res.json(bridges);
    } catch (e) {
        console.error("Bridge API Error:", e);
        res.status(500).json({ error: e.message, stack: e.stack });
    }
});

app.post('/api/admin/network/bridges', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.addBridge(req.body);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/admin/network/bridges/:name', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.updateBridge(req.params.name, req.body);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/network/bridges/:name', isAuthenticated, async (req, res) => {
    try {
        await networkConfigService.removeBridge(req.params.name);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 0.7 Firewall / AdBlock Configuration
app.get('/api/admin/firewall/rules', isAuthenticated, (req, res) => {
    try {
        const rules = firewallService.getRules();
        res.json(rules);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/firewall/rules', isAuthenticated, async (req, res) => {
    try {
        const { port, protocol, comment } = req.body;
        if (!port) return res.status(400).json({ error: "Port is required" });
        
        const rule = await firewallService.addRule(port, protocol || 'BOTH', comment || '');
        res.json({ success: true, rule });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/admin/firewall/rules/:id', isAuthenticated, async (req, res) => {
    try {
        const success = await firewallService.removeRule(req.params.id);
        if (success) res.json({ success: true });
        else res.status(404).json({ error: "Rule not found" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 1. Dashboard Data
app.get('/api/admin/system/verify', isAuthenticated, async (req, res) => {
    try {
        const results = await systemService.verifyConfiguration();
        res.json(results);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/dashboard', isAuthenticated, async (req, res) => {
    try {
        // Sales
        const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
        const startOfWeek = new Date(); startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); startOfWeek.setHours(0,0,0,0);
        const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0,0,0,0);
        const startOfYear = new Date(); startOfYear.setMonth(0, 1); startOfYear.setHours(0,0,0,0);

        const salesToday = db.prepare('SELECT sum(amount) as total FROM sales WHERE created_at >= ?').get(startOfDay.toISOString())?.total || 0;
        const salesWeek = db.prepare('SELECT sum(amount) as total FROM sales WHERE created_at >= ?').get(startOfWeek.toISOString())?.total || 0;
        const salesMonth = db.prepare('SELECT sum(amount) as total FROM sales WHERE created_at >= ?').get(startOfMonth.toISOString())?.total || 0;
        const salesYear = db.prepare('SELECT sum(amount) as total FROM sales WHERE created_at >= ?').get(startOfYear.toISOString())?.total || 0;

        // System
        const systemStats = await monitoringService.getSystemStats();
        const diskStats = await monitoringService.getDiskUsage();
        const dnsStats = await dnsService.getStats();
        
        // Active Sessions (Removed)

        res.json({
            total_sales_today: salesToday,
            total_sales_week: salesWeek,
            total_sales_month: salesMonth,
            total_sales_year: salesYear,
            
            cpu_temp: 50, // TODO: Read from file
            memory: systemStats.memory,
            storage: diskStats,
            uptime: systemStats.uptime,
            
            cpu_usage: systemStats.cpu, // { avg, cores }
            
            dns: dnsStats
        });
    } catch (e) {
        console.error("Dashboard Error:", e);
        res.status(500).json({ error: "Failed to load dashboard data" });
    }
});

app.get(['/generate_204', '/hotspot-detect.html', '/ncsi.txt', '/connecttest.txt'], (req, res) => {
    res.redirect(PORTAL_URL);
});

// 2. Main Portal Pages
app.get('/', (req, res) => {
    res.redirect('/portal');
});

app.get('/portal', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'portal.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'admin.html'));
});

// 3. Client API Endpoints (Used by portal.html)

// Get Status
app.get('/api/status', async (req, res) => {
    const { macAddress, user } = req;
    let ip = getClientIp(req);
    // Prefer DB IP if available (handles roaming and proxy cases)
    if (user && user.ip_address) {
        ip = normalizeIp(user.ip_address);
    }

    // Prefer DB MAC if available, else use detected one
    let mac = formatMac(user && user.mac_address ? user.mac_address : macAddress);
    if (!mac && ip) {
        // Attempt to resolve MAC live if missing
        try {
            const resolved = await require('./services/networkService').getMacFromIp(ip);
            mac = formatMac(resolved);
        } catch (e) {}
    }

    // Update Activity for Idle Timeout
    if (user && user.is_connected) {
        sessionService.updateActivity(mac);
    }

    const pendingAmount = currentCoinUser && formatMac(currentCoinUser.mac) === mac ? (Number(currentCoinUser.pendingAmount) || 0) : 0;
    const pendingMinutes = pendingAmount > 0 ? (Number(calculateTimeFromRates(pendingAmount, currentCoinUser.clientId).minutes) || 0) : 0;

    if (user && !user.user_code) {
        try {
            const newCode = generateUniqueUserCode();
            db.prepare('UPDATE users SET user_code = ? WHERE id = ?').run(newCode, user.id);
            user.user_code = newCode;
        } catch(e) {
            console.error('Error generating missing user code:', e);
        }
    }

    const vendoMode = configService.get('vendo_selection_mode') || 'auto';
    let availableVendos = [{ id: 'hardware', name: 'Main Vendo', is_online: true }];
    try {
        const subs = db.prepare('SELECT device_id, name, status, last_active_at FROM sub_vendo_devices ORDER BY created_at DESC').all();
        const now = new Date();
        availableVendos = availableVendos.concat(subs.map(s => {
            let isOnline = false;
            if (s.last_active_at) {
                const raw = String(s.last_active_at);
                const parsedA = new Date(raw);
                const parsedB = new Date(raw.includes('T') ? raw : (raw.replace(' ', 'T') + 'Z'));
                const lastActiveLocal = isNaN(parsedA.getTime()) ? parsedB : parsedA;
                
                if (!isNaN(lastActiveLocal.getTime())) {
                    const diffMs = (now - lastActiveLocal);
                    if (diffMs < SUB_VENDO_OFFLINE_AFTER_MS) isOnline = true;
                }
            }
            
            return {
                id: `subvendo:${s.device_id}`,
                name: s.name || `Device ${s.device_id}`,
                status: s.status || null,
                is_online: isOnline,
                last_seen: s.last_active_at
            };
        }));
    } catch (e) {
        console.error('Error fetching vendos:', e);
    }

    const activeCoinSession = (currentCoinUser && formatMac(currentCoinUser.mac) === mac) ? {
        selection_mode: currentCoinUser.selectionMode || null,
        target_device_id: currentCoinUser.targetDeviceId || null
    } : null;

    let freeTime = null;
    try {
        const cfg = configService.get('sub_vendo_free_time') || {};
        if (ip && cfg && typeof cfg === 'object') {
            const vlans = networkConfigService.getVlans() || [];
            const match = vlans.find(v => {
                if (!v.ip || !v.netmask) return false;
                const base = v.ip.split('.').slice(0, 3).join('.') + '.';
                return String(ip).startsWith(base);
            });
            
            let vcfg = null;
            if (match) {
                const parent = String(match.parent);
                const iface = `${parent}.${match.vlanId}`;
                vcfg = cfg[iface] || cfg['br0'] || cfg['eth0'];
            } else {
                vcfg = cfg['br0'] || cfg['eth0'];
            }

            if (vcfg && vcfg.enabled) {
                // Re-claim logic based on configurable period (default 24:00:00)
                const lastClaim = db.prepare(`
                    SELECT claimed_at FROM free_time_claims 
                    WHERE mac_address = ? 
                    ORDER BY claimed_at DESC 
                    LIMIT 1
                `).get(mac);
                const periodStr = typeof vcfg.reclaim_period === 'string' ? vcfg.reclaim_period : '24:00:00';
                const m = periodStr.match(/^(\d{1,3}):([0-5]?\d):([0-5]?\d)$/);
                const h = m ? parseInt(m[1], 10) : 24;
                const mi = m ? parseInt(m[2], 10) : 0;
                const s = m ? parseInt(m[3], 10) : 0;
                const periodMs = ((h * 3600) + (mi * 60) + s) * 1000;
                let canClaim = true;
                if (lastClaim && lastClaim.claimed_at) {
                    const last = new Date(String(lastClaim.claimed_at).replace(' ', 'T'));
                    if (!isNaN(last.getTime())) {
                        const diff = Date.now() - last.getTime();
                        if (diff < periodMs) canClaim = false;
                    }
                }
                const minutesCfg = Number(vcfg.minutes) || 0;
                freeTime = {
                    minutes: minutesCfg,
                    widget_enabled: !!vcfg.widget_enabled,
                    claimed: !canClaim, // considered claimed within period
                    available: canClaim && minutesCfg > 0,
                    can_claim: canClaim
                };
            }
        }
    } catch (e) {
        console.error('Error checking free time:', e);
    }

    res.set('Cache-Control', 'no-store');
    res.json({
        mac: mac || null,
        ip: ip || null,
        session_code: user ? user.user_code : null,
        time_remaining: user ? user.time_remaining : 0,
        is_paused: user ? user.is_paused : 0,
        is_connected: user ? user.is_connected : 0,
        pending_amount: pendingAmount,
        pending_minutes: pendingMinutes,
        status: user && user.time_remaining > 0 ? 'active' : 'expired',
        vendo_mode: vendoMode,
        available_vendos: availableVendos,
        coin_session: activeCoinSession,
        free_time: freeTime
    });
});

// Auth: Restore Session (Switch Device / Resume)
app.post('/api/session/restore', async (req, res) => {
    const { code, deviceId } = req.body;
    const ip = normalizeIp(req.ip);
    const mac = formatMac(await networkService.getMacFromIp(ip));

    if (!mac) return res.json({ success: false, error: 'Could not detect MAC address' });

    let user = null;

    // 1. Try Restore by Device ID (Preferred for Roaming)
    if (deviceId) {
        user = db.prepare('SELECT * FROM users WHERE client_id = ?').get(deviceId);
        
        if (user) {
             console.log(`[Restore] Found user by DeviceID: ${deviceId} (Old MAC: ${user.mac_address}, New MAC: ${mac})`);
             // Roaming Check
             if (formatMac(user.mac_address) !== mac) {
                 // Check if new MAC is already taken by another active user
                 const conflict = db.prepare('SELECT * FROM users WHERE mac_address = ? AND id != ? AND time_remaining > 0').get(mac, user.id);
                 if (conflict) {
                     return res.json({ success: false, error: 'Device ID valid, but current MAC is in use by another active session.' });
                 }
                 
                 // Update MAC (Roaming)
                 console.log(`[Restore] Roaming detected. Updating MAC ${user.mac_address} -> ${mac}`);
                 db.prepare('UPDATE users SET mac_address = ? WHERE id = ?').run(mac, user.id);
                 
                 // Block old MAC to be safe (Clean up old firewall rule)
                 await networkService.blockUser(user.mac_address);
                 user.mac_address = mac;
             }
        }
    }

    // 2. Try Restore by Code (Legacy + Manual Transfer)
    if (!user && code) {
        user = db.prepare('SELECT * FROM users WHERE user_code = ?').get(code);
        if (user) {
             // Handle Session Transfer (Roaming via Code)
             if (formatMac(user.mac_address) !== mac) {
                 console.log(`[Restore] Code transfer detected. ${user.mac_address} -> ${mac}`);
                 
                 // Check if new MAC is busy
                 const conflict = db.prepare('SELECT * FROM users WHERE mac_address = ? AND id != ? AND time_remaining > 0').get(mac, user.id);
                 if (conflict) {
                     return res.json({ success: false, error: 'Cannot transfer session. This device already has an active session.' });
                 }

                 // Block old MAC
                 await networkService.blockUser(user.mac_address);
                 
                 // Update to new MAC
                 db.prepare('UPDATE users SET mac_address = ? WHERE id = ?').run(mac, user.id);
                 user.mac_address = mac;
                 
                 // Link to current deviceId if available
                 if (deviceId) {
                     db.prepare('UPDATE users SET client_id = ? WHERE id = ?').run(deviceId, user.id);
                     user.client_id = deviceId;
                 }
             }
        }
    }

    if (!user) {
        return res.json({ success: false, error: 'Invalid Session or Code' });
    }
    
    // Check time
    if (user.time_remaining <= 0) {
         return res.json({ success: false, error: 'Session Expired' });
    }

    // 3. Restore Access
    await networkService.allowUser(user.mac_address);
    
    // Update IP & QoS
    if (ip) {
        db.prepare('UPDATE users SET ip_address = ?, is_connected = 1, is_paused = 0, last_active_at = CURRENT_TIMESTAMP, last_traffic_at = CURRENT_TIMESTAMP WHERE id = ?').run(ip, user.id);
        await bandwidthService.setLimit(ip, user.download_speed, user.upload_speed);
    }
    
    // Ensure cookie is set (syncs cookie with deviceId if missing)
    if (user.client_id) {
         res.cookie('client_id', user.client_id, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    }

    return res.json({ success: true, message: 'Session resumed', user });
});

// Coin Inserted (Called by hardware or simulated)
app.post('/api/coin-inserted', async (req, res) => {
    const { pulses, mac_address, device_id } = req.body;
    const amount = Number(pulses) || 0;
    const mac = formatMac(mac_address);

    if (!mac || amount <= 0) return res.status(400).json({ success: false, error: 'Invalid coin payload' });

    let source = 'hardware';
    let svDevice = null;

    if (device_id) {
        try {
            svDevice = db.prepare('SELECT * FROM sub_vendo_devices WHERE device_id = ?').get(device_id);
            if (svDevice) {
                source = `subvendo:${svDevice.device_id}`;
                // Update last active
                db.prepare('UPDATE sub_vendo_devices SET last_active_at = datetime("now", "localtime") WHERE id = ?').run(svDevice.id);
            }
        } catch (e) {
            console.error('[Coin] Error checking sub-vendo device:', e);
        }
    }

    try {
        db.prepare('INSERT INTO sales (amount, mac_address, source) VALUES (?, ?, ?)').run(amount, mac, source);
    } catch (err) {
        console.error('[Sales] Error recording sale:', err);
    }

    // Pass device ID (database ID) if available for rate calculation
    const best = calculateTimeFromRates(amount, svDevice ? svDevice.id : null);
    const minutesToAdd = Number(best.minutes) || 0;
    const secondsToAdd = minutesToAdd * 60;

    if (secondsToAdd <= 0) return res.status(400).json({ success: false, error: 'No rate available for this amount' });

    const user = db.prepare('SELECT * FROM users WHERE lower(mac_address) = lower(?)').get(mac);
    const prevUpload = (user && user.upload_speed != null) ? Number(user.upload_speed) : 1024;
    const prevDownload = (user && user.download_speed != null) ? Number(user.download_speed) : 5120;
    const nextUpload = (best.upload_speed != null) ? Number(best.upload_speed) : null;
    const nextDownload = (best.download_speed != null) ? Number(best.download_speed) : null;
    let uploadSpeed = (nextUpload != null && nextUpload > prevUpload) ? nextUpload : prevUpload;
    let downloadSpeed = (nextDownload != null && nextDownload > prevDownload) ? nextDownload : prevDownload;

    // Apply Sub-Vendo specific speed overrides if they exist
    if (svDevice) {
        if (svDevice.download_speed != null) downloadSpeed = svDevice.download_speed;
        if (svDevice.upload_speed != null) uploadSpeed = svDevice.upload_speed;
    }

    if (user) {
        db.prepare(`
            UPDATE users 
            SET time_remaining = time_remaining + ?, 
                total_time = total_time + ?,
                upload_speed = COALESCE(?, upload_speed), 
                download_speed = COALESCE(?, download_speed),
                is_paused = 0,
                is_connected = 1,
                last_active_at = CURRENT_TIMESTAMP,
                last_traffic_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(secondsToAdd, secondsToAdd, uploadSpeed, downloadSpeed, user.id);
    } else {
        db.prepare(`
            INSERT INTO users (mac_address, time_remaining, total_time, upload_speed, download_speed, is_paused, is_connected, last_active_at, last_traffic_at) 
            VALUES (?, ?, ?, ?, ?, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(mac, secondsToAdd, secondsToAdd, uploadSpeed, downloadSpeed);
    }

    networkService.allowUser(mac);

    // Apply speed immediately if user has an IP (Connected)
    try {
        const currentUser = db.prepare('SELECT ip_address FROM users WHERE mac_address = ?').get(mac);
        if (currentUser && currentUser.ip_address) {
             await bandwidthService.setLimit(currentUser.ip_address, downloadSpeed, uploadSpeed);
        }
    } catch (e) {
        console.error('[Coin] Error applying speed:', e);
    }

    res.json({ success: true, amount, minutesAdded: minutesToAdd, secondsAdded: secondsToAdd });
});

// Claim Free Time
app.post('/api/claim-free-time', async (req, res) => {
    let ip = getClientIp(req);
    let mac = formatMac(req.body.mac);
    
    if (!mac && ip) {
        // Try to resolve MAC from IP
        try {
            const resolved = await networkService.getMacFromIp(ip);
            mac = formatMac(resolved);
        } catch (e) {}
    }

    if (!mac || !ip) return res.status(400).json({ error: 'Unable to identify device' });

    try {
        // 1. Check Eligibility (VLAN & Config)
        const cfg = configService.get('sub_vendo_free_time') || {};
        let minutes = 0;
        let allowed = false;

        const vlans = networkConfigService.getVlans() || [];
        const match = vlans.find(v => {
            if (!v.ip || !v.netmask) return false;
            const base = v.ip.split('.').slice(0, 3).join('.') + '.';
            return String(ip).startsWith(base);
        });

        if (match) {
            const parent = String(match.parent);
            const iface = `${parent}.${match.vlanId}`;
            const vcfg = cfg[iface] || cfg['br0'] || cfg['eth0'];
            if (vcfg && vcfg.enabled) {
                minutes = Number(vcfg.minutes) || 0;
                allowed = true;
                // Enforce reclaim period
                // Check last claim and compare
                const lastClaim = db.prepare(`
                    SELECT claimed_at FROM free_time_claims 
                    WHERE mac_address = ? 
                    ORDER BY claimed_at DESC 
                    LIMIT 1
                `).get(mac);
                const periodStr = typeof vcfg.reclaim_period === 'string' ? vcfg.reclaim_period : '24:00:00';
                const m = periodStr.match(/^(\d{1,3}):([0-5]?\d):([0-5]?\d)$/);
                const h = m ? parseInt(m[1], 10) : 24;
                const mi = m ? parseInt(m[2], 10) : 0;
                const s = m ? parseInt(m[3], 10) : 0;
                const periodMs = ((h * 3600) + (mi * 60) + s) * 1000;
                if (lastClaim && lastClaim.claimed_at) {
                    const last = new Date(String(lastClaim.claimed_at).replace(' ', 'T'));
                    if (!isNaN(last.getTime())) {
                        const diff = Date.now() - last.getTime();
                        if (diff < periodMs) {
                            const remainingMs = periodMs - diff;
                            const rh = Math.floor(remainingMs / 3600000);
                            const rrem = remainingMs % 3600000;
                            const rmm = Math.floor(rrem / 60000);
                            const rss = Math.floor((rrem % 60000) / 1000);
                            const pad = (x) => String(x).padStart(2, '0');
                            const msg = `You can claim again in ${rh}:${pad(rmm)}:${pad(rss)}.`;
                            return res.json({ success: false, error: msg });
                        }
                    }
                }
            }
        } else {
             // Fallback to eth0 (default)
             const vcfg = cfg['br0'] || cfg['eth0'];
             if (vcfg && vcfg.enabled) {
                minutes = Number(vcfg.minutes) || 0;
                allowed = true;
                const lastClaim = db.prepare(`
                    SELECT claimed_at FROM free_time_claims 
                    WHERE mac_address = ? 
                    ORDER BY claimed_at DESC 
                    LIMIT 1
                `).get(mac);
                const periodStr = typeof vcfg.reclaim_period === 'string' ? vcfg.reclaim_period : '24:00:00';
                const m = periodStr.match(/^(\d{1,3}):([0-5]?\d):([0-5]?\d)$/);
                const h = m ? parseInt(m[1], 10) : 24;
                const mi = m ? parseInt(m[2], 10) : 0;
                const s = m ? parseInt(m[3], 10) : 0;
                const periodMs = ((h * 3600) + (mi * 60) + s) * 1000;
                if (lastClaim && lastClaim.claimed_at) {
                    const last = new Date(String(lastClaim.claimed_at).replace(' ', 'T'));
                    if (!isNaN(last.getTime())) {
                        const diff = Date.now() - last.getTime();
                        if (diff < periodMs) {
                            const remainingMs = periodMs - diff;
                            const rh = Math.floor(remainingMs / 3600000);
                            const rrem = remainingMs % 3600000;
                            const rmm = Math.floor(rrem / 60000);
                            const rss = Math.floor((rrem % 60000) / 1000);
                            const pad = (x) => String(x).padStart(2, '0');
                            const msg = `You can claim again in ${rh}:${pad(rmm)}:${pad(rss)}.`;
                            return res.json({ success: false, error: msg });
                        }
                    }
                }
             }
        }

        if (!allowed || minutes <= 0) {
            return res.json({ success: false, error: 'Free time is not available for your connection.' });
        }

        // 2. Re-claim period is enforced above; no daily check needed

        // 3. Grant Time
        const secondsToAdd = minutes * 60;
        
        // Find or Create User
        let user = db.prepare('SELECT * FROM users WHERE lower(mac_address) = lower(?)').get(mac);
        
        // Use default rates for speed
        const defaultRate = db.prepare('SELECT * FROM rates ORDER BY amount ASC LIMIT 1').get();
        const uploadSpeed = defaultRate ? defaultRate.upload_speed : 1024;
        const downloadSpeed = defaultRate ? defaultRate.download_speed : 5120;
        
        if (user) {
            db.prepare(`
                UPDATE users 
                SET time_remaining = time_remaining + ?, 
                    total_time = total_time + ?,
                    upload_speed = COALESCE(?, upload_speed), 
                    download_speed = COALESCE(?, download_speed),
                    is_paused = 0,
                    is_connected = 1,
                    last_active_at = CURRENT_TIMESTAMP,
                    last_traffic_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(secondsToAdd, secondsToAdd, uploadSpeed, downloadSpeed, user.id);
        } else {
             const userCode = generateUniqueUserCode();
             db.prepare(`
                INSERT INTO users (mac_address, ip_address, time_remaining, total_time, upload_speed, download_speed, is_paused, is_connected, user_code, last_active_at, last_traffic_at) 
                VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(mac, ip, secondsToAdd, secondsToAdd, uploadSpeed, downloadSpeed, userCode);
        }

        // 4. Record Claim
        db.prepare('INSERT INTO free_time_claims (mac_address, ip_address, minutes) VALUES (?, ?, ?)').run(mac, ip, minutes);

        // 5. Allow Access
        await networkService.allowUser(mac);
        if (ip) {
            await bandwidthService.setLimit(ip, downloadSpeed, uploadSpeed);
        }

        res.json({ success: true, minutesAdded: minutes });

    } catch (e) {
        console.error('Error claiming free time:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Start Coin Mode
app.post('/api/coin/start', async (req, res) => {
    let ip = req.ip;
    if (ip.startsWith('::ffff:')) ip = ip.substring(7);
    const mac = formatMac(await networkService.getMacFromIp(ip));
    if (!mac) return res.json({ success: false, error: 'Could not detect MAC' });

    // 1. Check if user is banned
    const banRecord = db.prepare('SELECT * FROM access_control WHERE mac_address = ?').get(mac);
    if (banRecord && banRecord.banned_until) {
        const bannedUntil = new Date(banRecord.banned_until);
        if (bannedUntil > new Date()) {
            const minutesLeft = Math.ceil((bannedUntil - new Date()) / 60000);
            return res.json({ success: false, error: `You are banned for ${minutesLeft} minutes due to too many failed attempts.` });
        }
    }

    // 2. Check if Coinslot is Busy (Another user is inserting)
    if (currentCoinUser && formatMac(currentCoinUser.mac) !== mac) {
        console.log(`[Coin] User ${mac} blocked. Coinslot busy with ${currentCoinUser.mac}`);
        return res.json({ success: false, error: 'Coinslot Busy Please Try again later' });
    }

    // Preserve pending amount if same user reconnects
    let pending = 0;
    if (currentCoinUser && formatMac(currentCoinUser.mac) === mac) {
        pending = currentCoinUser.pendingAmount || 0;
    }

    currentCoinUser = { 
        ip, 
        mac, 
        clientId: req.body.deviceId || req.clientId, 
        start: Date.now(), 
        pendingAmount: pending,
        sourceAmounts: {}, // Track amount per source
        targetDeviceId: req.body.targetDeviceId,
        selectionMode: null
    };
    
    // Initialize sourceAmounts if there is pending amount (rare, usually 0)
    if (pending > 0) {
        currentCoinUser.sourceAmounts['hardware'] = pending;
    }
    
    const bodyMode = (req.body && typeof req.body.selectionMode === 'string') ? req.body.selectionMode.trim().toLowerCase() : '';
    const defaultMode = configService.get('vendo_selection_mode') || 'auto';
    const mode = (bodyMode === 'auto' || bodyMode === 'manual') ? bodyMode : defaultMode;
    currentCoinUser.selectionMode = mode;

    if (mode !== 'manual') {
        currentCoinUser.targetDeviceId = null;
    } else if (!currentCoinUser.targetDeviceId) {
        currentCoinUser.targetDeviceId = 'hardware';
    }

    const target = currentCoinUser.targetDeviceId;
    
    if (mode === 'auto' || target === 'hardware') {
        hardwareService.setRelay(true);
    } else {
        hardwareService.setRelay(false);
    }

    if (coinTimeout) clearTimeout(coinTimeout);
    coinTimeout = setTimeout(() => { 
        finalizeCoinSession('timeout').catch(e => console.error('[Coin] Finalize error:', e));
    }, 60000);

    console.log(`[Coin] User ${mac} started inserting coins`);
    res.json({ success: true });
});

app.post('/api/coin/done', async (req, res) => {
    let ip = req.ip;
    if (ip.startsWith('::ffff:')) ip = ip.substring(7);
    const mac = formatMac(await networkService.getMacFromIp(ip));
    if (!mac) return res.json({ success: false, error: 'Could not detect MAC' });

    if (!currentCoinUser || formatMac(currentCoinUser.mac) !== mac) {
        return res.json({ success: false, error: 'No active coin session' });
    }

    try {
        const result = await finalizeCoinSession('done');
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Voucher Redeem
app.post('/api/voucher/redeem', async (req, res) => {
    const { code, mac: bodyMac } = req.body;
    const mac = req.macAddress || bodyMac; // Prioritize middleware, fallback to body
    
    if (!mac) return res.status(400).json({ success: false, error: "Could not detect MAC address." });

    // 1. Check if user is banned
    const banRecord = db.prepare('SELECT * FROM access_control WHERE mac_address = ?').get(mac);
    if (banRecord && banRecord.banned_until) {
        const bannedUntil = new Date(banRecord.banned_until);
        if (bannedUntil > new Date()) {
            const minutesLeft = Math.ceil((bannedUntil - new Date()) / 60000);
            return res.json({ success: false, error: `You are banned for ${minutesLeft} minutes due to too many failed attempts.` });
        }
    }

    const result = voucherService.redeemVoucher(code, mac, req.body.deviceId || req.clientId);
    
    if (result.success) {
        // Reset failed attempts
        db.prepare('INSERT INTO access_control (mac_address, failed_attempts, banned_until) VALUES (?, 0, NULL) ON CONFLICT(mac_address) DO UPDATE SET failed_attempts = 0, banned_until = NULL').run(mac);

        await networkService.allowUser(mac);
        // Apply bandwidth limit (use request IP or stored IP)
        // If the user is redeeming from the device itself, req.ip is correct.
        if (req.ip) {
            await bandwidthService.setLimit(req.ip, result.download_speed, result.upload_speed);
        }
        res.json({ success: true, added_time: result.duration });
    } else {
        // Handle failure & Ban Logic
        const banCounter = parseInt(configService.get('ban_counter')) || 10;
        const banDuration = parseInt(configService.get('ban_duration')) || 1;

        // Upsert failure count
        const currentFailures = (banRecord ? banRecord.failed_attempts : 0) + 1;
        let bannedUntil = null;
        let errorMsg = result.message;

        if (currentFailures >= banCounter) {
            bannedUntil = new Date(Date.now() + banDuration * 60000).toISOString();
            errorMsg = `You are banned for ${banDuration} minutes due to too many failed attempts.`;
        }

        db.prepare(`
            INSERT INTO access_control (mac_address, failed_attempts, banned_until, updated_at) 
            VALUES (?, ?, ?, CURRENT_TIMESTAMP) 
            ON CONFLICT(mac_address) DO UPDATE SET 
                failed_attempts = ?,
                banned_until = ?,
                updated_at = CURRENT_TIMESTAMP
        `).run(mac, currentFailures, bannedUntil, currentFailures, bannedUntil);

        res.json({ success: false, error: errorMsg });
    }
});

// Pause Time
app.post('/api/session/pause', async (req, res) => {
    if (req.user) {
        try {
            db.prepare('UPDATE users SET is_paused = 1, is_connected = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.user.id);
        } catch (e) {}
        try {
            await networkService.blockUser(req.user.mac_address, req.user.ip_address);
        } catch (e) {}
        try {
            if (req.user.ip_address) {
                await bandwidthService.removeLimit(req.user.ip_address);
            }
        } catch (e) {}
    }
    res.json({ success: true });
});

// Resume Time
app.post('/api/session/resume', async (req, res) => {
    if (req.user) {
        let clientIp = req.ip;
        if (clientIp.startsWith('::ffff:')) clientIp = clientIp.substring(7);

        // Update IP in case it changed while paused, and set is_paused=0
        db.prepare('UPDATE users SET is_paused = 0, ip_address = ?, last_active_at = CURRENT_TIMESTAMP, last_traffic_at = CURRENT_TIMESTAMP WHERE id = ?').run(clientIp, req.user.id);
        
        // Safety: Ensure no one else holds this IP
        db.prepare('UPDATE users SET ip_address = NULL WHERE ip_address = ? AND id != ?').run(clientIp, req.user.id);

        await networkService.allowUser(req.user.mac_address);
        
        // Re-apply bandwidth limit to the CURRENT IP
        await bandwidthService.setLimit(clientIp, req.user.download_speed, req.user.upload_speed);
    }
    res.json({ success: true });
});

// Admin: Generate Vouchers
app.post('/api/admin/vouchers/generate', isAuthenticated, (req, res) => {
    try {
        const options = req.body;
        const codes = voucherService.generateVouchers(options);
        res.json({ success: true, codes });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: List Vouchers
app.get('/api/admin/vouchers', isAuthenticated, (req, res) => {
    const vouchers = db.prepare('SELECT * FROM vouchers ORDER BY created_at DESC LIMIT 500').all();
    res.json(vouchers);
});

// Admin: Delete Vouchers
app.delete('/api/admin/vouchers', isAuthenticated, (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids)) {
             return res.status(400).json({ success: false, error: 'Invalid IDs' });
        }
        
        const deleteStmt = db.prepare('DELETE FROM vouchers WHERE id = ?');
        const transaction = db.transaction((voucherIds) => {
            for (const id of voucherIds) deleteStmt.run(id);
        });
        
        transaction(ids);
        res.json({ success: true, count: ids.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Public: Get Rates for Portal
app.get('/api/rates', (req, res) => {
    try {
        const deviceParam = String(req.query.device || '').trim();
        let rates = [];
        if (deviceParam.startsWith('subvendo:')) {
            const did = deviceParam.slice('subvendo:'.length);
            const dev = db.prepare('SELECT id FROM sub_vendo_devices WHERE device_id = ?').get(did);
            if (dev) {
                const mapped = db.prepare(`
                    SELECT r.amount, r.minutes, r.upload_speed, r.download_speed, r.is_pausable
                    FROM rates r
                    JOIN sub_vendo_device_rates m ON m.rate_id = r.id
                    WHERE m.device_id = ? AND m.visible = 1
                    ORDER BY r.amount ASC
                `).all(dev.id);
                rates = mapped.length > 0 ? mapped : db.prepare('SELECT amount, minutes, upload_speed, download_speed, is_pausable FROM rates ORDER BY amount ASC').all();
            } else {
                rates = db.prepare('SELECT amount, minutes, upload_speed, download_speed, is_pausable FROM rates ORDER BY amount ASC').all();
            }
        } else {
            rates = db.prepare('SELECT amount, minutes, upload_speed, download_speed, is_pausable FROM rates ORDER BY amount ASC').all();
        }
        res.json(rates);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin: Get Rates
app.get('/api/admin/rates', isAuthenticated, (req, res) => {
    try {
        const rates = db.prepare('SELECT * FROM rates ORDER BY amount ASC').all();
        res.json(rates);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Add/Edit Rate
app.post('/api/admin/rates', isAuthenticated, (req, res) => {
    try {
        const { id, amount, minutes, upload_speed, download_speed, is_pausable } = req.body;
        
        if (id) {
            db.prepare(`UPDATE rates SET amount=?, minutes=?, upload_speed=?, download_speed=?, is_pausable=? WHERE id=?`)
              .run(amount, minutes, upload_speed, download_speed, is_pausable, id);
        } else {
            db.prepare(`INSERT INTO rates (amount, minutes, upload_speed, download_speed, is_pausable) VALUES (?, ?, ?, ?, ?)`)
              .run(amount, minutes, upload_speed, download_speed, is_pausable);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Delete Rate
app.delete('/api/admin/rates/:id', isAuthenticated, (req, res) => {
    try {
        db.prepare('DELETE FROM rates WHERE id=?').run(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Get Devices
app.get('/api/admin/devices', isAuthenticated, (req, res) => {
    try {
        const globalIdleSec = Number(configService.get('idle_timeout_seconds')) || 120;
        const devices = db.prepare(`
            SELECT u.*, 
            (SELECT code FROM vouchers WHERE used_by_user_id = u.id ORDER BY used_at DESC LIMIT 1) as last_voucher_code
            FROM users u 
            ORDER BY u.updated_at DESC
        `).all();

        const networkService = require('./services/networkService');
        const ifaceMapPromise = networkService.getArpInterfacesMap();

        // Map IP -> hostname from dnsmasq leases
        const leasePaths = [
            '/var/lib/misc/dnsmasq.leases',
            '/tmp/dnsmasq.leases',
            '/var/lib/dnsmasq/dnsmasq.leases'
        ];
        const ipToHostname = {};
        for (const p of leasePaths) {
            try {
                if (fs.existsSync(p)) {
                    const content = fs.readFileSync(p, 'utf8');
                    const lines = content.split('\n');
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        // <ts> <mac> <ip> <hostname> <clientid>
                        if (parts.length >= 4) {
                            const ip = parts[2];
                            const hostname = parts[3] && parts[3] !== '*' ? parts[3] : '';
                            if (ip) ipToHostname[ip] = hostname;
                        }
                    }
                }
            } catch (e) {}
        }

        const devicesWithTimeout = devices.map(d => {
            let speed = { dl_speed: 0, ul_speed: 0 };
            try {
                if (sessionService && typeof sessionService.getCurrentSpeed === 'function') {
                    speed = sessionService.getCurrentSpeed(d.ip_address);
                }
            } catch (err) {
                console.error("Error getting speed for " + d.ip_address, err);
            }

            const ipClean = (d.ip_address || '').replace('::ffff:', '');
            let iface = null;
            try {
                const arpMap = (typeof ifaceMapPromise.then === 'function') ? null : ifaceMapPromise;
            } catch (e) {}

            return {
                ...d,
                effective_idle_timeout: d.idle_timeout || globalIdleSec,
                current_speed: speed,
                hostname: ipToHostname[ipClean] || null
            };
        });

        Promise.resolve(ifaceMapPromise).then(async (arpMap) => {
            const results = [];
            for (const d of devicesWithTimeout) {
                const ipClean = (d.ip_address || '').replace('::ffff:', '');
                let iface = arpMap && arpMap.get(ipClean);
                if (!iface) {
                    try {
                        iface = await networkService.getInterfaceForIp(ipClean);
                    } catch (e) {}
                }
                const label = networkService.formatInterfaceLabel(iface || '');
                results.push({ ...d, interface_name: iface || null, interface_label: label });
            }
            res.json(results);
        }).catch(() => {
            res.json(devicesWithTimeout);
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Update Device
app.put('/api/admin/devices/:id', isAuthenticated, async (req, res) => {
    try {
        const id = req.params.id;
        const { session_code, time_remaining } = req.body;
        
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        // Update both session_code (legacy) and user_code (actual)
        const codeToUpdate = session_code !== undefined ? session_code : (user.user_code || user.session_code);
        
        db.prepare('UPDATE users SET session_code = ?, user_code = ?, time_remaining = ? WHERE id = ?')
          .run(codeToUpdate, codeToUpdate, 
               time_remaining !== undefined ? time_remaining : user.time_remaining, 
               id);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Admin: Delete Device (Disconnect)
app.delete('/api/admin/devices/:id', isAuthenticated, async (req, res) => {
    try {
        const id = req.params.id;
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
        
        if (user) {
            // Cut internet access
            await networkService.blockUser(user.mac_address);
            db.prepare('DELETE FROM users WHERE id = ?').run(id);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Listen with error handling
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} is already in use.`);
        console.log('Trying to kill the existing process...');
        
        // Try to kill the process on Linux/Unix
        require('child_process').exec(`fuser -k ${PORT}/tcp`, (err) => {
                    if (err) {
                         console.log('Could not kill process automatically. Please run: killall node');
                         process.exit(1);
                    } else {
                         console.log('Process killed. Retrying in 2 seconds...');
                         setTimeout(() => {
                             server.close();
                             server.listen(PORT);
                         }, 2000);
                    }
                });
    } else {
        console.error('Server Error:', e);
    }
});

// Start Session Monitoring (Idle Timeout)
sessionService.startMonitoring(5000); // Check every 5 seconds

// Initialize System (Firewall & QoS) - Linux Only
if (process.platform !== 'win32') {
    try {
        console.log('Initializing Firewall & Traffic Accounting...');
        const initFirewallPath = path.join(__dirname, 'scripts/init_firewall.sh');
        // Ensure executable
        try { require('child_process').execSync(`chmod +x "${initFirewallPath}"`); } catch (e) {}
        
        // Run init_firewall.sh
        require('child_process').exec(
            `bash "${initFirewallPath}"`, 
            (error, stdout, stderr) => {
                if (error) {
                    console.error(`Firewall Init Error: ${error.message}`);
                    return;
                }
                if (stderr) console.error(`Firewall Init Stderr: ${stderr}`);
                console.log(`Firewall Init Output: ${stdout}`);
            }
        );
        
        console.log('Initializing QoS...');
        const wanIface = configService.get('wan_interface') || 'eth0';
        const lanIface = configService.get('lan_interface') || 'br0';
        bandwidthService.init(wanIface, lanIface).catch(e => console.error('QoS Init Failed:', e));

    } catch (e) {
        console.error('System Initialization Failed:', e);
    }
}

// Global Error Handler (Express)
app.use((err, req, res, next) => {
    console.error('Unhandled Express Error:', err);
    logService.critical('SYSTEM', `Unhandled Express Error: ${err.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Global Process Error Handlers
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Ensure logService is available (it should be)
    try {
        logService.critical('SYSTEM', `Uncaught Exception: ${err.message}\nStack: ${err.stack}`);
    } catch (e) {
        console.error('Failed to log critical error:', e);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    try {
        logService.critical('SYSTEM', `Unhandled Rejection: ${reason}`);
    } catch (e) {
        console.error('Failed to log critical error:', e);
    }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Piso Wifi Server running on http://0.0.0.0:${PORT}`);
});
