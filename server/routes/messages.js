const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const notify = require('../lib/notify');
const v = require('../lib/validate');

const router = express.Router();
router.use(requireAuth);

const httpError = (status, msg) => Object.assign(new Error(msg), { status });
const getThread = (id) => db.get('SELECT * FROM threads WHERE id = ?', Number(id) || 0);
const isParty = (t, user) => !!t && (t.customer_id === user.id || t.lender_id === user.id);

// Customer side: finds or opens the thread for a listing. Lenders can't open threads on their own listings.
async function threadFor(user, listingId) {
  const l = await db.get("SELECT * FROM listings WHERE id = ? AND status = 'verified'", Number(listingId) || 0);
  if (!l) throw httpError(404, 'Listing not found.');
  if (l.owner_id === user.id) throw httpError(400, 'You cannot negotiate on your own listing.');
  if (user.role !== 'customer') throw httpError(403, 'Only customer accounts can contact owners.');
  const existing = await db.get('SELECT * FROM threads WHERE listing_id = ? AND customer_id = ?', l.id, user.id);
  if (existing) return existing;
  return getThread(await db.insert('INSERT INTO threads (listing_id, customer_id, lender_id) VALUES (?, ?, ?)', l.id, user.id, l.owner_id));
}

async function resolveThread(req) {
  if (req.body.thread_id) {
    const t = await getThread(req.body.thread_id);
    if (!isParty(t, req.user)) throw httpError(404, 'Conversation not found.');
    return t;
  }
  return threadFor(req.user, req.body.listing_id);
}

async function post(q, t, fromUser, body, offerId = null) {
  await q.run('INSERT INTO messages (thread_id, from_user, body, offer_id) VALUES (?, ?, ?, ?)', t.id, fromUser.id, body, offerId);
  await q.run('UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', t.id);
}

const other = (t, user) => (t.customer_id === user.id ? t.lender_id : t.customer_id);

router.get('/threads', async (req, res) => {
  const rows = await db.all(`
    SELECT t.*, l.title AS listing_title, l.currency, l.price_unit,
      cu.name AS customer_name, le.name AS lender_name,
      (SELECT body FROM messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT status FROM offers WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS offer_status
    FROM threads t JOIN listings l ON l.id = t.listing_id
    JOIN users cu ON cu.id = t.customer_id JOIN users le ON le.id = t.lender_id
    WHERE t.customer_id = ? OR t.lender_id = ? ORDER BY t.updated_at DESC`, req.user.id, req.user.id);
  res.json({ results: rows });
});

router.get('/threads/:id', async (req, res) => {
  const t = await getThread(req.params.id);
  if (!isParty(t, req.user)) return res.status(404).json({ error: 'Conversation not found.' });
  const listing = await db.get('SELECT id, title, price, currency, price_unit, negotiable FROM listings WHERE id = ?', t.listing_id);
  const messages = await db.all(`
    SELECT m.*, u.name AS from_name FROM messages m JOIN users u ON u.id = m.from_user
    WHERE thread_id = ? ORDER BY m.id`, t.id);
  const offers = await db.all('SELECT * FROM offers WHERE thread_id = ? ORDER BY id', t.id);
  const names = await db.all('SELECT id, name FROM users WHERE id IN (?, ?)', t.customer_id, t.lender_id);
  res.json({ thread: t, listing, messages, offers, names, me: req.user.id });
});

router.post('/', async (req, res) => {
  const body = v.str(req.body.body, 'Message', { min: 1, max: 2000, required: true });
  const t = await resolveThread(req);
  await post(db, t, req.user, body);
  const l = await db.get('SELECT title FROM listings WHERE id = ?', t.listing_id);
  await notify(other(t, req.user), 'message', `New message from ${req.user.name}`, `${l.title}: ${body.slice(0, 120)}`, `#/inbox/${t.id}`);
  res.status(201).json({ thread_id: t.id });
});

module.exports = { router, resolveThread, post, other, getThread, isParty };
