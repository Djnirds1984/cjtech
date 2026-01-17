const Database = require('better-sqlite3');
const path = require('path');

// Correct path based on src/database/db.js
const dbPath = path.join(__dirname, 'src', 'database', 'pisowifi.sqlite');
console.log('Checking database at:', dbPath);

try {
    const db = new Database(dbPath);
    const admin = db.prepare('SELECT * FROM admins WHERE id = 1').get();
    console.log('Admin record:', admin);
} catch (e) {
    console.error('Error reading database:', e);
}
