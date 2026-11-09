const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const notify = require('../lib/notify');
const v = require('../lib/validate');
const { resolveThread, post, other, getThread, isParty } = require('./messages');

const router = express.Router();
router.use(requireAuth);

const fmt = (n, cur) => `${cur} ${Number(n).toLocaleString('en-US')}`;
const offerInput = (b) => ({
  price: v.num(b.price, 'Offer price', { min: 1, required: true }),
  duration: v.str(b.duration, 'Proposed duration', { max: 60 }) || null,
  message: v.str(b.message, 'Message', { max: 1000 }) || null,
});

function createOffer(t, user, input) {
  const { lastInsertRowid } = db.prepare('INSERT INTO offers (thread_id, from_user, price, duration, message) VALUES (?, ?, ?, ?, ?)')
    .run(t.id, user.id, input.price, input.duration, input.message);
  return lastInsertRowid;
}

// Customer makes an offer on a listing (opens the thread if needed).
router.post('/', (req, res) => {
  const input = offerInput(req.body);
  const t = resolveThread(req);
  if (req.user.id !== t.customer_id) return res.status(403).json({ error: 'Only the customer can open with an offer. Use counter-offer instead.' });
  const pending = db.prepare("SELECT 1 FROM offers WHERE thread_id = ? AND status = 'offered'").get(t.id);
  if (pending) return res.status(409).json({ error: 'There is already an open offer in this conversation. Wait for a response.' });
  const l = db.prepare('SELECT title, currency FROM listings WHERE id = ?').get(t.listing_id);
  const id = db.transaction(() => {
    const oid = createOffer(t, req.user, input);
    post(t, req.user, `Offer: ${fmt(input.price, l.currency)}${input.duration ? `, ${input.duration}` : ''}${input.message ? ` — ${input.message}` : ''}`, oid);
    return oid;
  })();
  notify(t.lender_id, 'offer', `New offer on ${l.title}`, `${req.user.name} offered ${fmt(input.price, l.currency)}`, `#/inbox/${t.id}`);
  res.status(201).json({ offer_id: id, thread_id: t.id });
});

// Accept, decline or counter an open offer. Only the party who did NOT make it can respond.
router.post('/:id/respond', (req, res) => {
  const o = db.prepare('SELECT * FROM offers WHERE id = ?').get(Number(req.params.id));
  const t = o && getThread(o.thread_id);
  if (!o || !isParty(t, req.user)) return res.status(404).json({ error: 'Offer not found.' });
  if (o.from_user === req.user.id) return res.status(400).json({ error: 'You cannot respond to your own offer.' });
  if (o.status !== 'offered') return res.status(400).json({ error: `This offer is already ${o.status}.` });
  const action = v.oneOf(req.body.action, 'Action', ['accept', 'decline', 'counter']);
  const l = db.prepare('SELECT title, currency FROM listings WHERE id = ?').get(t.listing_id);
  const to = other(t, req.user);

  db.transaction(() => {
    if (action === 'counter') {
      const input = offerInput(req.body);
      db.prepare("UPDATE offers SET status = 'countered' WHERE id = ?").run(o.id);
      const nid = createOffer(t, req.user, input);
      post(t, req.user, `Counter-offer: ${fmt(input.price, l.currency)}${input.duration ? `, ${input.duration}` : ''}${input.message ? ` — ${input.message}` : ''}`, nid);
      notify(to, 'offer', `Counter-offer on ${l.title}`, `${req.user.name} countered with ${fmt(input.price, l.currency)}`, `#/inbox/${t.id}`);
    } else {
      const status = action === 'accept' ? 'accepted' : 'declined';
      db.prepare('UPDATE offers SET status = ? WHERE id = ?').run(status, o.id);
      post(t, req.user, `${status === 'accepted' ? 'Accepted' : 'Declined'} the offer of ${fmt(o.price, l.currency)}.`, o.id);
      notify(to, 'offer', `Offer ${status}`, `${req.user.name} ${status} your offer on ${l.title}`, `#/inbox/${t.id}`);
    }
  })();
  res.json({ ok: true });
});

module.exports = router;
