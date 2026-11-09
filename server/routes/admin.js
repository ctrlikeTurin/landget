const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const notify = require('../lib/notify');
const v = require('../lib/validate');
const { serialize, getListing } = require('./listings');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/stats', (_req, res) => {
  const c = (sql) => db.prepare(sql).get().n;
  res.json({
    pending: c("SELECT COUNT(*) n FROM listings WHERE status = 'pending'"),
    verified: c("SELECT COUNT(*) n FROM listings WHERE status = 'verified'"),
    users: c('SELECT COUNT(*) n FROM users'),
    open_reports: c("SELECT COUNT(*) n FROM reports WHERE status = 'open'"),
  });
});

router.get('/queue', (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, u.name AS owner_name, u.email AS owner_email,
      (SELECT filename FROM photos WHERE listing_id = l.id ORDER BY position LIMIT 1) AS cover
    FROM listings l JOIN users u ON u.id = l.owner_id
    WHERE l.status = 'pending' ORDER BY l.duplicate_deed DESC, l.updated_at`).all();
  res.json({
    results: rows.map((r) => ({
      ...serialize(r, req.user, { full: true }),
      owner_name: r.owner_name, owner_email: r.owner_email,
      // Other listings using the same deed number, so the admin can compare.
      deed_conflicts: r.deed_number
        ? db.prepare('SELECT id, title, status FROM listings WHERE deed_number = ? AND id != ?').all(r.deed_number, r.id)
        : [],
    })),
  });
});

router.post('/listings/:id/approve', (req, res) => {
  const l = getListing(req.params.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  if (l.status !== 'pending') return res.status(400).json({ error: 'Only pending listings can be approved.' });
  if (l.deed_number && db.prepare("SELECT 1 FROM listings WHERE deed_number = ? AND status IN ('verified','paused') AND id != ?").get(l.deed_number, l.id)) {
    return res.status(409).json({ error: 'Another verified listing already uses this title deed number. Reject one of them.' });
  }
  db.prepare("UPDATE listings SET status = 'verified', reject_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(l.id);
  notify(l.owner_id, 'verification', 'Listing verified', `"${l.title}" is now live.`, `#/listing/${l.id}`);
  res.json({ ok: true });
});

router.post('/listings/:id/reject', (req, res) => {
  const l = getListing(req.params.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  const reason = v.str(req.body.reason, 'Reason', { min: 5, max: 500, required: true });
  db.prepare("UPDATE listings SET status = 'rejected', reject_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reason, l.id);
  notify(l.owner_id, 'verification', 'Listing rejected', `"${l.title}": ${reason}`, '#/dashboard');
  res.json({ ok: true });
});

router.get('/users', (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const rows = db.prepare(`
    SELECT id, name, email, phone, role, suspended, created_at,
      (SELECT COUNT(*) FROM listings WHERE owner_id = users.id) AS listings
    FROM users WHERE LOWER(name || ' ' || email) LIKE ? ORDER BY created_at DESC LIMIT 200`).all(q);
  res.json({ results: rows });
});

router.post('/users/:id/suspend', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot suspend yourself.' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const suspended = v.bool(req.body.suspended) ? 1 : 0;
  db.transaction(() => {
    db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(suspended, id);
    // A suspended owner's live listings come down too.
    if (suspended) db.prepare("UPDATE listings SET status = 'paused' WHERE owner_id = ? AND status = 'verified'").run(id);
  })();
  res.json({ ok: true, suspended: !!suspended });
});

router.get('/reports', (_req, res) => {
  res.json({
    results: db.prepare(`
      SELECT r.*, l.title AS listing_title, l.status AS listing_status, l.owner_id, u.name AS reporter_name
      FROM reports r JOIN listings l ON l.id = r.listing_id JOIN users u ON u.id = r.reporter_id
      ORDER BY r.status = 'open' DESC, r.created_at DESC`).all(),
  });
});

router.post('/reports/:id/resolve', (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Report not found.' });
  db.prepare("UPDATE reports SET status = 'resolved' WHERE id = ?").run(r.id);
  if (v.bool(req.body.takedown)) {
    db.prepare("UPDATE listings SET status = 'rejected', reject_reason = ? WHERE id = ?").run('Removed after a fraud report.', r.listing_id);
    const l = getListing(r.listing_id);
    notify(l.owner_id, 'verification', 'Listing removed', `"${l.title}" was removed after a report. Contact support to appeal.`, '#/dashboard');
  }
  res.json({ ok: true });
});

module.exports = router;
