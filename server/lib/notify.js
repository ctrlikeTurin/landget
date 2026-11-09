const db = require('../db');

const insert = db.prepare('INSERT INTO notifications (user_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?)');

// In-app, email-style notification. Swap in a mail provider here later if needed.
module.exports = function notify(userId, kind, title, body = '', link = null) {
  insert.run(userId, kind, title, body, link);
};
