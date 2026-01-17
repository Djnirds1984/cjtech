const Database = require('better-sqlite3');
const path = require('path');

// Connect to database (creates file if not exists)
const dbPath = path.join(__dirname, 'pisowifi.sqlite');
const db = new Database(dbPath);

// Initialize tables
const initDb = () => {
  // Table for tracking connected devices/users
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac_address TEXT UNIQUE NOT NULL,
      client_id TEXT, -- For cookie-based identification
      ip_address TEXT,
      time_remaining INTEGER DEFAULT 0, -- in seconds
      is_connected INTEGER DEFAULT 0,   -- 0: false, 1: true
      is_paused INTEGER DEFAULT 0,      -- 0: active, 1: paused
      download_speed INTEGER DEFAULT 5120, -- kbps (Default 5 Mbps)
      upload_speed INTEGER DEFAULT 1024,   -- kbps (Default 1 Mbps)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      session_code TEXT,
      idle_timeout INTEGER DEFAULT 120, -- in seconds
      last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Add session_code column if it doesn't exist (for existing DBs)
  try {
    const columns = db.pragma('table_info(users)');
    
    // Check and add session_code
    if (!columns.some(col => col.name === 'session_code')) {
        db.exec("ALTER TABLE users ADD COLUMN session_code TEXT");
        db.exec("CREATE INDEX IF NOT EXISTS idx_users_session_code ON users(session_code)");
    }

    // Check and add client_id
    if (!columns.some(col => col.name === 'client_id')) {
        db.exec("ALTER TABLE users ADD COLUMN client_id TEXT");
        db.exec("CREATE INDEX IF NOT EXISTS idx_users_client_id ON users(client_id)");
    }

    // Check and add idle_timeout
    if (!columns.some(col => col.name === 'idle_timeout')) {
        db.exec("ALTER TABLE users ADD COLUMN idle_timeout INTEGER DEFAULT 120");
    }

    // Check and add last_active_at
    if (!columns.some(col => col.name === 'last_active_at')) {
        db.exec("ALTER TABLE users ADD COLUMN last_active_at DATETIME");
        db.exec("UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE last_active_at IS NULL");
    }

    // Check and add last_traffic_at
    if (!columns.some(col => col.name === 'last_traffic_at')) {
        db.exec("ALTER TABLE users ADD COLUMN last_traffic_at DATETIME");
        db.exec("UPDATE users SET last_traffic_at = CURRENT_TIMESTAMP WHERE last_traffic_at IS NULL");
    }

    // Check and add session_expiry
    if (!columns.some(col => col.name === 'session_expiry')) {
        db.exec("ALTER TABLE users ADD COLUMN session_expiry DATETIME");
    }

    // Check and add keepalive_timeout
    if (!columns.some(col => col.name === 'keepalive_timeout')) {
        db.exec("ALTER TABLE users ADD COLUMN keepalive_timeout INTEGER DEFAULT 300"); // 5 minutes
    }

    // Check and add QoS columns
    if (!columns.some(col => col.name === 'download_speed')) {
        db.exec("ALTER TABLE users ADD COLUMN download_speed INTEGER DEFAULT 5120");
    }
    if (!columns.some(col => col.name === 'upload_speed')) {
        db.exec("ALTER TABLE users ADD COLUMN upload_speed INTEGER DEFAULT 1024");
    }

    // Check and add Traffic Tracking columns
    if (!columns.some(col => col.name === 'total_data_up')) {
        db.exec("ALTER TABLE users ADD COLUMN total_data_up INTEGER DEFAULT 0");
    }
    if (!columns.some(col => col.name === 'total_data_down')) {
        db.exec("ALTER TABLE users ADD COLUMN total_data_down INTEGER DEFAULT 0");
    }

  } catch (e) {
    console.error('Migration error:', e);
  }

  // Table for Access Control (Bans)
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_control (
      mac_address TEXT PRIMARY KEY,
      failed_attempts INTEGER DEFAULT 0,
      banned_until DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for tracking sales/coins
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount INTEGER NOT NULL,
      mac_address TEXT,
      source TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    const salesCols = db.pragma('table_info(sales)');
    if (!salesCols.some(col => col.name === 'source')) {
      db.exec("ALTER TABLE sales ADD COLUMN source TEXT");
    }
  } catch (e) {
    console.error('Migration error (sales source):', e);
  }

  // Table for Vouchers
  db.exec(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      duration INTEGER NOT NULL, -- in seconds
      download_speed INTEGER, -- Optional override
      upload_speed INTEGER,   -- Optional override
      is_used INTEGER DEFAULT 0,
      used_by_user_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(used_by_user_id) REFERENCES users(id)
    )
  `);

  // Table for Walled Garden
  db.exec(`
    CREATE TABLE IF NOT EXISTS walled_garden (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      type TEXT NOT NULL, -- 'DROP' or 'ACCEPT'
      address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for PPPoE Profiles
  db.exec(`
    CREATE TABLE IF NOT EXISTS pppoe_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      rate_limit_up INTEGER DEFAULT 0, -- Kbps
      rate_limit_down INTEGER DEFAULT 0, -- Kbps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for PPPoE Users
  db.exec(`
    CREATE TABLE IF NOT EXISTS pppoe_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      profile_id INTEGER,
      profile_name TEXT, -- kept for backward compatibility or direct display
      rate_limit_up INTEGER DEFAULT 0, -- Kbps, 0 = unlimited
      rate_limit_down INTEGER DEFAULT 0, -- Kbps
      expiration_date DATETIME, -- NULL = never expires
      is_active INTEGER DEFAULT 1,
      current_ip TEXT, -- Assigned IP if connected
      mac_address TEXT, -- Bound MAC (optional)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(profile_id) REFERENCES pppoe_profiles(id)
    )
  `);

  // Table for Firewall / AdBlock Rules
  db.exec(`
    CREATE TABLE IF NOT EXISTS firewall_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      port INTEGER NOT NULL,
      protocol TEXT DEFAULT 'BOTH', -- TCP, UDP, BOTH
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for Free Time Claims
  db.exec(`
    CREATE TABLE IF NOT EXISTS free_time_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mac_address TEXT NOT NULL,
      ip_address TEXT,
      minutes INTEGER NOT NULL,
      claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Add used_at to vouchers table if not exists
  try {
    const columns = db.pragma('table_info(vouchers)');
    const hasUsedAt = columns.some(col => col.name === 'used_at');
    if (!hasUsedAt) {
        db.exec("ALTER TABLE vouchers ADD COLUMN used_at DATETIME");
    }
  } catch (e) {
    console.error('Migration error (vouchers used_at):', e);
  }

  // Create Admin table
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      security_question TEXT,
      security_answer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Migration: Add security columns to admins if not exists
  try {
    const adminCols = db.pragma('table_info(admins)');
    if (!adminCols.some(col => col.name === 'security_question')) {
        db.exec("ALTER TABLE admins ADD COLUMN security_question TEXT");
    }
    if (!adminCols.some(col => col.name === 'security_answer')) {
        db.exec("ALTER TABLE admins ADD COLUMN security_answer TEXT");
    }
  } catch (e) {
    console.error('Migration error (admin security):', e);
  }
  
  // Seed default admin (admin/admin) if empty
  const adminCount = db.prepare('SELECT count(*) as count FROM admins').get().count;
  if (adminCount === 0) {
      db.prepare('INSERT INTO admins (username, password_hash, security_question, security_answer) VALUES (?, ?, ?, ?)').run('admin', 'admin', 'What is the name of your first pet?', 'admin');
  } else {
      // Ensure existing default admin has a security question for testing/fallback
      const admin = db.prepare('SELECT * FROM admins WHERE id = 1').get();
      if (admin && !admin.security_question) {
          db.prepare('UPDATE admins SET security_question = ?, security_answer = ? WHERE id = 1').run('What is the name of your first pet?', 'admin');
      }
  }

  // Table for System Logs
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'INFO', -- INFO, WARN, ERROR, CRITICAL
      category TEXT DEFAULT 'SYSTEM', -- SYSTEM, PPPOE, VOUCHER, AUTH
      message TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for Settings
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      type TEXT DEFAULT 'string', -- string, number, boolean, json
      category TEXT DEFAULT 'system', -- system, network, hardware
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for Rates
  db.exec(`
    CREATE TABLE IF NOT EXISTS rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      amount INTEGER NOT NULL,
      minutes INTEGER NOT NULL,
      upload_speed INTEGER DEFAULT 5120,
      download_speed INTEGER DEFAULT 5120,
      is_pausable INTEGER DEFAULT 1
    )
  `);

  // Migration: Add user_code to users table if not exists
  try {
    const tableInfo = db.prepare('PRAGMA table_info(users)').all();
    const hasUserCode = tableInfo.some(col => col.name === 'user_code');
    if (!hasUserCode) {
        db.prepare('ALTER TABLE users ADD COLUMN user_code TEXT').run();
        // Note: SQLite ALTER TABLE ADD COLUMN does not support adding UNIQUE constraint easily in one go for some versions
        // We will enforce uniqueness in application logic or create a unique index
        db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_code ON users(user_code)').run();
    }
  } catch (e) {
      console.error('Migration error (user_code):', e);
  }
    
  // Table for Chat Messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_mac TEXT,       -- MAC address of the user (NULL if sent by admin)
      message TEXT NOT NULL,
      is_from_admin INTEGER DEFAULT 0, -- 1 if sent by admin, 0 if sent by user
      is_read INTEGER DEFAULT 0,       -- 1 if read
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Table for Sub Vendo Devices
  db.exec(`
    CREATE TABLE IF NOT EXISTS sub_vendo_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      device_id TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active_at DATETIME
    )
  `);

  try {
    const info = db.prepare('PRAGMA table_info(sub_vendo_devices)').all();
    const has = (col) => info.some(c => c.name === col);
    if (!has('description')) db.prepare("ALTER TABLE sub_vendo_devices ADD COLUMN description TEXT DEFAULT ''").run();
    if (!has('coin_pin')) db.prepare("ALTER TABLE sub_vendo_devices ADD COLUMN coin_pin INTEGER DEFAULT 6").run();
    if (!has('relay_pin')) db.prepare("ALTER TABLE sub_vendo_devices ADD COLUMN relay_pin INTEGER DEFAULT 5").run();
    if (!has('peso_per_pulse')) db.prepare("ALTER TABLE sub_vendo_devices ADD COLUMN peso_per_pulse INTEGER DEFAULT 1").run();
    if (!has('last_active_at')) db.prepare("ALTER TABLE sub_vendo_devices ADD COLUMN last_active_at DATETIME").run();
    if (!has('last_coins_out_at')) db.prepare("ALTER TABLE sub_vendo_devices ADD COLUMN last_coins_out_at DATETIME").run();
    if (!has('download_speed')) db.prepare("ALTER TABLE sub_vendo_devices ADD COLUMN download_speed INTEGER").run();
    if (!has('upload_speed')) db.prepare("ALTER TABLE sub_vendo_devices ADD COLUMN upload_speed INTEGER").run();
  } catch (e) {
    console.error('Migration error (sub_vendo_devices):', e);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sub_vendo_device_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      rate_id INTEGER NOT NULL,
      visible INTEGER DEFAULT 1,
      UNIQUE(device_id, rate_id)
    )
  `);

  // Seed default rates
  const ratesCount = db.prepare('SELECT count(*) as count FROM rates').get().count;
  if (ratesCount === 0) {
      db.prepare('INSERT INTO rates (amount, minutes, upload_speed, download_speed, is_pausable) VALUES (?, ?, ?, ?, ?)').run(1, 15, 5120, 5120, 1);
      db.prepare('INSERT INTO rates (amount, minutes, upload_speed, download_speed, is_pausable) VALUES (?, ?, ?, ?, ?)').run(5, 120, 5120, 5120, 1);
      db.prepare('INSERT INTO rates (amount, minutes, upload_speed, download_speed, is_pausable) VALUES (?, ?, ?, ?, ?)').run(10, 300, 5120, 5120, 1);
  }

  // Seed default settings if empty
  const settingsCount = db.prepare('SELECT count(*) as count FROM settings').get().count;
  if (settingsCount === 0) {
      const defaults = [
          // Network
          { key: 'wan_interface', value: 'eth0', category: 'network' },
          { key: 'lan_interface', value: 'wlan0', category: 'network' },
          { key: 'portal_port', value: '3000', category: 'network' },
          
          // Hardware
          { key: 'coin_pin', value: '12', type: 'number', category: 'hardware' }, // Default OPI PA12
          { key: 'relay_pin', value: '11', type: 'number', category: 'hardware' }, // Default OPI PA11
          { key: 'bill_pin', value: '19', type: 'number', category: 'hardware' }, // Default OPI PA19 (Fixed from 15)
          { key: 'coin_pin_edge', value: 'falling', category: 'hardware' },
          { key: 'bill_pin_edge', value: 'falling', category: 'hardware' },
          { key: 'bill_multiplier', value: '1', type: 'number', category: 'hardware' },
          { key: 'relay_pin_active', value: 'HIGH', category: 'hardware' }, // Default HIGH
          { key: 'ban_limit_counter', value: '10', type: 'number', category: 'security' }, // 10 seconds
          { key: 'ban_duration', value: '1', type: 'number', category: 'security' }, // 1 minute
          
          { key: 'pulse_multiplier', value: '5', type: 'number', category: 'hardware' }, // 1 pulse = 5 mins
          { key: 'temp_threshold', value: '70', type: 'number', category: 'hardware' }, // 70 Celsius
          
          // Pricing
          { key: 'rate_1_peso', value: '300', type: 'number', category: 'pricing' }, // 1 peso = 300s (5m)
          { key: 'rate_5_peso', value: '1800', type: 'number', category: 'pricing' }, // 5 peso = 1800s (30m)
          { key: 'rate_10_peso', value: '3600', type: 'number', category: 'pricing' }, // 10 peso = 3600s (1h)
      ];
      
      const insert = db.prepare('INSERT INTO settings (key, value, type, category) VALUES (@key, @value, @type, @category)');
      defaults.forEach(s => insert.run({ 
          key: s.key, 
          value: s.value, 
          type: s.type || 'string', 
          category: s.category 
      }));
  }

  // Migration: Ensure relay_pin_active is HIGH by default
  try {
      const r = db.prepare("SELECT value FROM settings WHERE key = 'relay_pin_active'").get();
      if (r && r.value === 'LOW') {
          console.log('Migrating: Updating relay_pin_active to HIGH');
          db.prepare("UPDATE settings SET value = 'HIGH' WHERE key = 'relay_pin_active'").run();
      }
  } catch(e) {}

  // Migrations for existing tables
  try {
    // Settings Migration
    const settingsInfo = db.prepare('PRAGMA table_info(settings)').all();
    if (!settingsInfo.some(col => col.name === 'category')) {
        console.log('Migrating: Adding category to settings...');
        db.prepare("ALTER TABLE settings ADD COLUMN category TEXT DEFAULT 'system'").run();
    }

    const tableInfo = db.prepare('PRAGMA table_info(users)').all();
    const hasClientId = tableInfo.some(col => col.name === 'client_id');
    const hasIsPaused = tableInfo.some(col => col.name === 'is_paused');
    const hasDownloadSpeed = tableInfo.some(col => col.name === 'download_speed');
    
    if (!hasClientId) {
      console.log('Migrating: Adding client_id to users...');
      db.prepare('ALTER TABLE users ADD COLUMN client_id TEXT').run();
    }
    if (!hasIsPaused) {
      console.log('Migrating: Adding is_paused to users...');
      db.prepare('ALTER TABLE users ADD COLUMN is_paused INTEGER DEFAULT 0').run();
    }
    if (!hasDownloadSpeed) {
        console.log('Migrating: Adding speed limits to users...');
        db.prepare('ALTER TABLE users ADD COLUMN download_speed INTEGER DEFAULT 5120').run();
        db.prepare('ALTER TABLE users ADD COLUMN upload_speed INTEGER DEFAULT 1024').run();
    }
    
    const hasTotalData = tableInfo.some(col => col.name === 'total_data_up');
    if (!hasTotalData) {
        console.log('Migrating: Adding traffic counters to users...');
        db.prepare('ALTER TABLE users ADD COLUMN total_data_up INTEGER DEFAULT 0').run();
        db.prepare('ALTER TABLE users ADD COLUMN total_data_down INTEGER DEFAULT 0').run();
    }
    
    const hasTotalTime = tableInfo.some(col => col.name === 'total_time');
    if (!hasTotalTime) {
        console.log('Migrating: Adding total_time to users...');
        db.prepare('ALTER TABLE users ADD COLUMN total_time INTEGER DEFAULT 0').run();
        // Initialize total_time = time_remaining for existing users (approximation)
        db.prepare('UPDATE users SET total_time = time_remaining WHERE total_time = 0 AND time_remaining > 0').run();
    }

    const voucherInfo = db.prepare('PRAGMA table_info(vouchers)').all();
    const hasVoucherSpeed = voucherInfo.some(col => col.name === 'download_speed');
    if (!hasVoucherSpeed) {
        console.log('Migrating: Adding speed limits to vouchers...');
        db.prepare('ALTER TABLE vouchers ADD COLUMN download_speed INTEGER').run();
        db.prepare('ALTER TABLE vouchers ADD COLUMN upload_speed INTEGER').run();
    }

    const hasUsedAt = voucherInfo.some(col => col.name === 'used_at');
    const hasPlanName = voucherInfo.some(col => col.name === 'plan_name');
    const hasPrice = voucherInfo.some(col => col.name === 'price');

    if (!hasUsedAt) {
        console.log('Migrating: Adding used_at to vouchers...');
        db.prepare('ALTER TABLE vouchers ADD COLUMN used_at DATETIME').run();
    }
    if (!hasPlanName) {
        console.log('Migrating: Adding plan_name to vouchers...');
        db.prepare('ALTER TABLE vouchers ADD COLUMN plan_name TEXT').run();
    }
    if (!hasPrice) {
        console.log('Migrating: Adding price to vouchers...');
        db.prepare('ALTER TABLE vouchers ADD COLUMN price REAL').run();
    }

    // PPPoE Users Migration
    const pppoeUsersInfo = db.prepare('PRAGMA table_info(pppoe_users)').all();
    const hasProfileId = pppoeUsersInfo.some(col => col.name === 'profile_id');
    const hasProfileName = pppoeUsersInfo.some(col => col.name === 'profile_name');
    const hasRateUp = pppoeUsersInfo.some(col => col.name === 'rate_limit_up');
    const hasRateDown = pppoeUsersInfo.some(col => col.name === 'rate_limit_down');
    const hasExpiration = pppoeUsersInfo.some(col => col.name === 'expiration_date');
    const hasIsActive = pppoeUsersInfo.some(col => col.name === 'is_active');
    
    if (!hasProfileId) {
        console.log('Migrating: Adding profile_id to pppoe_users...');
        db.prepare('ALTER TABLE pppoe_users ADD COLUMN profile_id INTEGER').run();
    }
    if (!hasProfileName) {
        console.log('Migrating: Adding profile_name to pppoe_users...');
        db.prepare('ALTER TABLE pppoe_users ADD COLUMN profile_name TEXT').run();
    }
    if (!hasRateUp) {
        console.log('Migrating: Adding rate_limit_up to pppoe_users...');
        db.prepare('ALTER TABLE pppoe_users ADD COLUMN rate_limit_up INTEGER DEFAULT 0').run();
    }
    if (!hasRateDown) {
        console.log('Migrating: Adding rate_limit_down to pppoe_users...');
        db.prepare('ALTER TABLE pppoe_users ADD COLUMN rate_limit_down INTEGER DEFAULT 0').run();
    }
    if (!hasExpiration) {
        console.log('Migrating: Adding expiration_date to pppoe_users...');
        db.prepare('ALTER TABLE pppoe_users ADD COLUMN expiration_date DATETIME').run();
    }
    if (!hasIsActive) {
        console.log('Migrating: Adding is_active to pppoe_users...');
        db.prepare('ALTER TABLE pppoe_users ADD COLUMN is_active INTEGER DEFAULT 1').run();
    }

  } catch (err) {
    console.error('Migration error:', err.message);
  }

  console.log('Database initialized successfully.');
};

module.exports = { db, initDb };
