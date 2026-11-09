const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const notify = require('../lib/notify');
const v = require('../lib/validate');
const { serializeFull, getListing, LEVELS } = require('./listings');

const router = express.Router();
router.use(requireRole('admin'));

router.get('/stats', async (_req, res) => {
  const c = async (sql) => (await db.get(sql)).n;
  res.json({
    pending: await c("SELECT COUNT(*) AS n FROM listings WHERE status = 'pending'"),
    verified: await c("SELECT COUNT(*) AS n FROM listings WHERE status = 'verified'"),
    users: await c('SELECT COUNT(*) AS n FROM users'),
    open_reports: await c("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
  });
});

router.get('/queue', async (req, res) => {
  const rows = await db.all(`
    SELECT l.*, u.name AS owner_name, u.email AS owner_email
    FROM listings l JOIN users u ON u.id = l.owner_id
    WHERE l.status = 'pending' ORDER BY l.duplicate_deed DESC, l.updated_at`);
  const results = [];
  for (const r of rows) {
    results.push({
      ...(await serializeFull(r, req.user)),
      owner_name: r.owner_name, owner_email: r.owner_email,
      // Other listings using the same deed number, so the admin can compare.
      deed_conflicts: r.deed_number
        ? await db.all('SELECT id, title, status FROM listings WHERE deed_number = ? AND id != ?', r.deed_number, r.id)
        : [],
    });
  }
  res.json({ results });
});

router.post('/listings/:id/approve', async (req, res) => {
  const l = await getListing(req.params.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  if (l.status !== 'pending') return res.status(400).json({ error: 'Only pending listings can be approved.' });
  if (l.deed_number && await db.get("SELECT 1 FROM listings WHERE deed_number = ? AND status IN ('verified','paused') AND id != ?", l.deed_number, l.id)) {
    return res.status(409).json({ error: 'Another verified listing already uses this title deed number. Reject one of them.' });
  }
  // Approval means the documents were checked: level 1. Higher levels are set separately.
  await db.run("UPDATE listings SET status = 'verified', reject_reason = NULL, verification_level = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", l.id);
  await notify(l.owner_id, 'verification', 'Listing verified', `"${l.title}" is now live.`, `#/listing/${l.id}`);
  res.json({ ok: true });
});

// Raise (or lower) a verified listing's level. Each level needs its evidence recorded.
router.post('/listings/:id/level', async (req, res) => {
  const l = await getListing(req.params.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  if (!['verified', 'paused'].includes(l.status)) return res.status(400).json({ error: 'Approve the listing before setting a higher level.' });
  const level = v.num(req.body.level, 'Level', { min: 1, max: 3, required: true });
  if (!Number.isInteger(level)) throw new v.ValidationError('Level must be 1, 2 or 3.');
  const ref = v.str(req.body.title_search_ref, 'Title search reference', { max: 200 }) || l.title_search_ref;
  const note = v.str(req.body.site_visit_note, 'Site visit note', { max: 1000 }) || l.site_visit_note;
  if (level >= 2 && !ref) throw new v.ValidationError('Enter the official title search reference (Ardhisasa / NLA / Irembo) to confirm level 2.');
  if (level >= 3 && !note) throw new v.ValidationError('Describe the site visit (who visited, when, what was checked) to confirm level 3.');
  await db.run('UPDATE listings SET verification_level = ?, title_search_ref = ?, site_visit_note = ? WHERE id = ?', level, ref || null, note || null, l.id);
  if (level > (l.verification_level || 0)) {
    await notify(l.owner_id, 'verification', `Verification upgraded: ${LEVELS[level]}`, `"${l.title}" now shows "${LEVELS[level]}".`, `#/listing/${l.id}`);
  }
  res.json({ ok: true, level, label: LEVELS[level] });
});

router.post('/listings/:id/reject', async (req, res) => {
  const l = await getListing(req.params.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  const reason = v.str(req.body.reason, 'Reason', { min: 5, max: 500, required: true });
  await db.run("UPDATE listings SET status = 'rejected', reject_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", reason, l.id);
  await notify(l.owner_id, 'verification', 'Listing rejected', `"${l.title}": ${reason}`, '#/dashboard');
  res.json({ ok: true });
});

router.get('/users', async (req, res) => {
  const q = `%${String(req.query.q || '').toLowerCase()}%`;
  const rows = await db.all(`
    SELECT id, name, email, phone, role, suspended, created_at,
      (SELECT COUNT(*) FROM listings WHERE owner_id = users.id) AS listings
    FROM users WHERE LOWER(name || ' ' || email) LIKE ? ORDER BY created_at DESC LIMIT 200`, q);
  res.json({ results: rows });
});

router.post('/users/:id/suspend', async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot suspend yourself.' });
  const u = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  const suspended = v.bool(req.body.suspended) ? 1 : 0;
  await db.tx(async (q) => {
    await q.run('UPDATE users SET suspended = ? WHERE id = ?', suspended, id);
    // A suspended owner's live listings come down too.
    if (suspended) await q.run("UPDATE listings SET status = 'paused' WHERE owner_id = ? AND status = 'verified'", id);
  });
  res.json({ ok: true, suspended: !!suspended });
});

router.get('/reports', async (_req, res) => {
  res.json({
    results: await db.all(`
      SELECT r.*, l.title AS listing_title, l.status AS listing_status, l.owner_id, u.name AS reporter_name
      FROM reports r JOIN listings l ON l.id = r.listing_id JOIN users u ON u.id = r.reporter_id
      ORDER BY CASE WHEN r.status = 'open' THEN 0 ELSE 1 END, r.created_at DESC`),
  });
});

router.post('/reports/:id/resolve', async (req, res) => {
  const r = await db.get('SELECT * FROM reports WHERE id = ?', Number(req.params.id) || 0);
  if (!r) return res.status(404).json({ error: 'Report not found.' });
  await db.run("UPDATE reports SET status = 'resolved' WHERE id = ?", r.id);
  if (v.bool(req.body.takedown)) {
    await db.run("UPDATE listings SET status = 'rejected', reject_reason = ? WHERE id = ?", 'Removed after a fraud report.', r.listing_id);
    const l = await getListing(r.listing_id);
    await notify(l.owner_id, 'verification', 'Listing removed', `"${l.title}" was removed after a report. Contact support to appeal.`, '#/dashboard');
  }
  res.json({ ok: true });
});

module.exports = router;
