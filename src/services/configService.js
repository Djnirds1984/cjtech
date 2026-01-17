const { db } = require('../database/db');

class ConfigService {
    constructor() {
        this.cache = {};
        // Removed automatic loading in constructor to allow DB initialization first
    }

    init() {
        this.loadSettings();
    }

    loadSettings() {
        try {
            const settings = db.prepare('SELECT * FROM settings').all();
            settings.forEach(s => {
                this.cache[s.key] = this.parseValue(s.value, s.type);
            });
            console.log('Settings loaded:', this.cache);
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    parseValue(value, type) {
        if (type === 'number') return Number(value);
        if (type === 'boolean') return value === 'true' || value === '1';
        if (type === 'json') return JSON.parse(value);
        return value;
    }

    get(key, defaultValue = null) {
        return this.cache[key] !== undefined ? this.cache[key] : defaultValue;
    }

    set(key, value) {
        try {
            let type = 'string';
            if (typeof value === 'number') type = 'number';
            else if (typeof value === 'boolean') type = 'boolean';
            else if (typeof value === 'object') type = 'json';

            let dbValue = value;
            if (type === 'json') dbValue = JSON.stringify(value);
            else dbValue = String(value);

            // Update DB
            const stmt = db.prepare(`
                INSERT INTO settings (key, value, type, updated_at) 
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET 
                value = excluded.value, 
                type = excluded.type,
                updated_at = excluded.updated_at
            `);
            stmt.run(key, dbValue, type);

            // Update Cache
            this.cache[key] = value;
            return true;
        } catch (e) {
            console.error(`Failed to set setting ${key}:`, e);
            return false;
        }
    }
    
    getAll() {
        return this.cache;
    }
}

module.exports = new ConfigService();
