const db = require('../db');

// In-app, email-style notification. Swap in a mail provider here later if needed.
module.exports = function notify(userId, kind, title, body = '', link = null, q = db) {
  return q.run('INSERT INTO notifications (user_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?)', userId, kind, title, body, link);
};
