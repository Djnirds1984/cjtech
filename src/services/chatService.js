const { db } = require('../database/db');

class ChatService {
    saveMessage(senderMac, message, isFromAdmin) {
        const stmt = db.prepare('INSERT INTO chat_messages (sender_mac, message, is_from_admin, timestamp) VALUES (?, ?, ?, CURRENT_TIMESTAMP)');
        return stmt.run(senderMac, message, isFromAdmin ? 1 : 0);
    }

    getMessages(senderMac, limit = 50) {
        // If senderMac is provided, get messages for that specific user (conversation)
        // If not provided (and logic handles it), it might be global, but for this app, chat is per-device.
        const stmt = db.prepare('SELECT * FROM chat_messages WHERE sender_mac = ? ORDER BY timestamp ASC LIMIT ?');
        return stmt.all(senderMac, limit);
    }

    // For Admin: Get list of all users who have chatted, with their last message
    getAllConversations() {
        // Group by sender_mac to get unique conversations
        // We need to fetch the last message for each mac
        // Join with users table to get client_id
        const stmt = db.prepare(`
            SELECT 
                m.sender_mac, 
                u.client_id,
                u.user_code,
                m.message, 
                m.timestamp,
                (SELECT COUNT(*) FROM chat_messages WHERE sender_mac = m.sender_mac AND is_read = 0 AND is_from_admin = 0) as unread_count
            FROM chat_messages m
            LEFT JOIN users u ON u.mac_address = m.sender_mac
            WHERE m.id IN (
                SELECT MAX(id) 
                FROM chat_messages 
                GROUP BY sender_mac
            )
            ORDER BY m.timestamp DESC
        `);
        return stmt.all();
    }

    markAsRead(senderMac) {
        const stmt = db.prepare('UPDATE chat_messages SET is_read = 1 WHERE sender_mac = ? AND is_from_admin = 0');
        return stmt.run(senderMac);
    }
}

module.exports = new ChatService();
