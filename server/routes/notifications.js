const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const results = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id);
  const { n } = await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', req.user.id);
  res.json({ results, unread: n });
});

router.post('/read', async (req, res) => {
  await db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

module.exports = router;
