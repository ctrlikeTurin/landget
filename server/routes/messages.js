const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const notify = require('../lib/notify');
const v = require('../lib/validate');

const router = express.Router();
router.use(requireAuth);

const getThread = (id) => db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(id));
const isParty = (t, user) => t && (t.customer_id === user.id || t.lender_id === user.id);

// Customer side: finds or opens the thread for a listing. Lenders can't open threads on their own listings.
function threadFor(user, listingId) {
  const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'verified'").get(Number(listingId));
  if (!l) { const e = new Error('Listing not found.'); e.status = 404; throw e; }
  if (l.owner_id === user.id) { const e = new Error('You cannot negotiate on your own listing.'); e.status = 400; throw e; }
  if (user.role !== 'customer') { const e = new Error('Only customer accounts can contact owners.'); e.status = 403; throw e; }
  let t = db.prepare('SELECT * FROM threads WHERE listing_id = ? AND customer_id = ?').get(l.id, user.id);
  if (!t) {
    const { lastInsertRowid } = db.prepare('INSERT INTO threads (listing_id, customer_id, lender_id) VALUES (?, ?, ?)').run(l.id, user.id, l.owner_id);
    t = getThread(lastInsertRowid);
  }
  return t;
}

function resolveThread(req) {
  if (req.body.thread_id) {
    const t = getThread(req.body.thread_id);
    if (!isParty(t, req.user)) { const e = new Error('Conversation not found.'); e.status = 404; throw e; }
    return t;
  }
  return threadFor(req.user, req.body.listing_id);
}

function post(t, fromUser, body, offerId = null) {
  db.prepare('INSERT INTO messages (thread_id, from_user, body, offer_id) VALUES (?, ?, ?, ?)').run(t.id, fromUser.id, body, offerId);
  db.prepare('UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(t.id);
}

const other = (t, user) => (t.customer_id === user.id ? t.lender_id : t.customer_id);

router.get('/threads', (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, l.title AS listing_title, l.currency, l.price_unit,
      cu.name AS customer_name, le.name AS lender_name,
      (SELECT body FROM messages WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT status FROM offers WHERE thread_id = t.id ORDER BY id DESC LIMIT 1) AS offer_status
    FROM threads t JOIN listings l ON l.id = t.listing_id
    JOIN users cu ON cu.id = t.customer_id JOIN users le ON le.id = t.lender_id
    WHERE t.customer_id = ? OR t.lender_id = ? ORDER BY t.updated_at DESC`).all(req.user.id, req.user.id);
  res.json({ results: rows });
});

router.get('/threads/:id', (req, res) => {
  const t = getThread(req.params.id);
  if (!isParty(t, req.user)) return res.status(404).json({ error: 'Conversation not found.' });
  const listing = db.prepare('SELECT id, title, price, currency, price_unit, negotiable FROM listings WHERE id = ?').get(t.listing_id);
  const messages = db.prepare(`
    SELECT m.*, u.name AS from_name FROM messages m JOIN users u ON u.id = m.from_user
    WHERE thread_id = ? ORDER BY m.id`).all(t.id);
  const offers = db.prepare('SELECT * FROM offers WHERE thread_id = ? ORDER BY id').all(t.id);
  const names = db.prepare('SELECT id, name FROM users WHERE id IN (?, ?)').all(t.customer_id, t.lender_id);
  res.json({ thread: t, listing, messages, offers, names, me: req.user.id });
});

router.post('/', (req, res) => {
  const body = v.str(req.body.body, 'Message', { min: 1, max: 2000, required: true });
  const t = resolveThread(req);
  post(t, req.user, body);
  const l = db.prepare('SELECT title FROM listings WHERE id = ?').get(t.listing_id);
  notify(other(t, req.user), 'message', `New message from ${req.user.name}`, `${l.title}: ${body.slice(0, 120)}`, `#/inbox/${t.id}`);
  res.status(201).json({ thread_id: t.id });
});

module.exports = { router, resolveThread, post, other, getThread, isParty };
