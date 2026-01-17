const { db } = require('../database/db');
const crypto = require('crypto');
const logService = require('./logService');

function generateUserCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `CJ-${code}`;
}

function generateUniqueUserCode() {
    let userCode = null;
    while (true) {
        userCode = generateUserCode();
        const existing = db.prepare('SELECT id FROM users WHERE user_code = ?').get(userCode);
        if (!existing) return userCode;
    }
}

class VoucherService {
    
    /**
     * Generate Vouchers
     * @param {Object} options
     * @param {number} options.count Number of vouchers
     * @param {number} options.duration Duration in minutes
     * @param {string} options.plan_name Plan Name
     * @param {number} options.price Price
     * @param {number} options.download_speed Download speed in kbps
     * @param {number} options.upload_speed Upload speed in kbps
     * @param {boolean} options.is_random Random generation?
     * @param {string} options.prefix Code prefix
     * @param {number} options.length Code length (excluding prefix)
     * @param {string} options.custom_code Custom code (if not random)
     */
    generateVouchers(options) {
        const {
            count = 1,
            duration = 60,
            plan_name = 'Standard',
            price = 0,
            download_speed = 5120, // Default 5Mbps
            upload_speed = 1024,   // Default 1Mbps
            is_random = true,
            prefix = '',
            length = 6,
            custom_code = ''
        } = options;

        const vouchers = [];
        const durationSeconds = duration * 60;
        
        const insert = db.prepare(`
            INSERT INTO vouchers 
            (code, duration, plan_name, price, download_speed, upload_speed) 
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const check = db.prepare('SELECT id FROM vouchers WHERE code = ?');

        const transaction = db.transaction(() => {
            for (let i = 0; i < count; i++) {
                let code;
                
                if (is_random) {
                    let exists = true;
                    // Generate unique code
                    while(exists) {
                        const randomPart = crypto.randomBytes(Math.ceil(length/2)).toString('hex').toUpperCase().slice(0, length);
                        code = (prefix + randomPart).toUpperCase();
                        exists = check.get(code);
                    }
                } else {
                    // Custom code (only works for count=1 usually, or appended index)
                    code = count > 1 ? `${custom_code}${i+1}` : custom_code;
                    if (check.get(code)) {
                        throw new Error(`Voucher code ${code} already exists`);
                    }
                }
                
                insert.run(code, durationSeconds, plan_name, price, download_speed, upload_speed);
                vouchers.push(code);
            }
        });

        transaction();
        logService.info('VOUCHER', `Generated ${count} vouchers (Plan: ${plan_name}, Price: ${price})`);
        return vouchers;
    }

    /**
     * Redeem a Voucher
     */
    redeemVoucher(code, macAddress, clientId = null) {
        const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ? AND is_used = 0').get(code);
        
        if (!voucher) {
            logService.warn('VOUCHER', `Failed redemption attempt for code ${code} from MAC ${macAddress}`);
            return { success: false, message: 'Invalid or used voucher' };
        }

        // Get user ID first
        let user = db.prepare('SELECT * FROM users WHERE mac_address = ?').get(macAddress);

        const transaction = db.transaction(() => {
            // Create user if not exists
            if (!user) {
                const info = db.prepare('INSERT INTO users (mac_address, time_remaining, is_connected, client_id, last_active_at, last_traffic_at) VALUES (?, 0, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(macAddress, clientId);
                user = { id: info.lastInsertRowid };
            }

            // 1. Mark voucher as used
            db.prepare('UPDATE vouchers SET is_used = 1, used_by_user_id = ?, used_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(user.id, voucher.id);

            // 2. Add time, update speeds, and set user_code if missing
            db.prepare(`
                UPDATE users 
                SET time_remaining = time_remaining + ?, 
                total_time = total_time + ?,
                upload_speed = COALESCE(?, upload_speed), 
                download_speed = COALESCE(?, download_speed),
                user_code = COALESCE(user_code, ?),
                client_id = ?,
                is_connected = 1,
                is_paused = 0,
                last_active_at = CURRENT_TIMESTAMP,
                last_traffic_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(voucher.duration, voucher.duration, voucher.upload_speed, voucher.download_speed, generateUniqueUserCode(), clientId, user.id);
            
            // Apply speed limit
            const bandwidthService = require('./bandwidthService'); // Lazy load to avoid circular dep
            if (user.ip_address) {
                bandwidthService.setLimit(user.ip_address, 
                    voucher.download_speed || user.download_speed, 
                    voucher.upload_speed || user.upload_speed
                );
            }
        });

        transaction();
        
        logService.info('VOUCHER', `Voucher ${code} redeemed by MAC ${macAddress} (Duration: ${voucher.duration}s)`);

        return { 
            success: true, 
            duration: voucher.duration,
            download_speed: voucher.download_speed || 5120,
            upload_speed: voucher.upload_speed || 1024
        };
    }
}

module.exports = new VoucherService();
