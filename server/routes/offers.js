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
const describe = (prefix, input, cur) => `${prefix}: ${fmt(input.price, cur)}${input.duration ? `, ${input.duration}` : ''}${input.message ? ` — ${input.message}` : ''}`;

const createOffer = (q, t, user, input) => q.insert(
  'INSERT INTO offers (thread_id, from_user, price, duration, message) VALUES (?, ?, ?, ?, ?)',
  t.id, user.id, input.price, input.duration, input.message,
);

// Customer makes an offer on a listing (opens the thread if needed).
router.post('/', async (req, res) => {
  const input = offerInput(req.body);
  const t = await resolveThread(req);
  if (req.user.id !== t.customer_id) return res.status(403).json({ error: 'Only the customer can open with an offer. Use counter-offer instead.' });
  if (await db.get("SELECT 1 FROM offers WHERE thread_id = ? AND status = 'offered'", t.id)) {
    return res.status(409).json({ error: 'There is already an open offer in this conversation. Wait for a response.' });
  }
  const l = await db.get('SELECT title, currency FROM listings WHERE id = ?', t.listing_id);
  const id = await db.tx(async (q) => {
    const oid = await createOffer(q, t, req.user, input);
    await post(q, t, req.user, describe('Offer', input, l.currency), oid);
    return oid;
  });
  await notify(t.lender_id, 'offer', `New offer on ${l.title}`, `${req.user.name} offered ${fmt(input.price, l.currency)}`, `#/inbox/${t.id}`);
  res.status(201).json({ offer_id: id, thread_id: t.id });
});

// Accept, decline or counter an open offer. Only the party who did NOT make it can respond.
router.post('/:id/respond', async (req, res) => {
  const o = await db.get('SELECT * FROM offers WHERE id = ?', Number(req.params.id) || 0);
  const t = o && await getThread(o.thread_id);
  if (!o || !isParty(t, req.user)) return res.status(404).json({ error: 'Offer not found.' });
  if (o.from_user === req.user.id) return res.status(400).json({ error: 'You cannot respond to your own offer.' });
  if (o.status !== 'offered') return res.status(400).json({ error: `This offer is already ${o.status}.` });
  const action = v.oneOf(req.body.action, 'Action', ['accept', 'decline', 'counter']);
  const input = action === 'counter' ? offerInput(req.body) : null;
  const l = await db.get('SELECT title, currency FROM listings WHERE id = ?', t.listing_id);
  const to = other(t, req.user);

  await db.tx(async (q) => {
    // Conditional update so two simultaneous responses can't both win.
    const status = action === 'counter' ? 'countered' : action === 'accept' ? 'accepted' : 'declined';
    const { changes } = await q.run("UPDATE offers SET status = ? WHERE id = ? AND status = 'offered'", status, o.id);
    if (!changes) throw Object.assign(new Error('This offer was already answered.'), { status: 409 });
    if (action === 'counter') {
      const nid = await createOffer(q, t, req.user, input);
      await post(q, t, req.user, describe('Counter-offer', input, l.currency), nid);
      await notify(to, 'offer', `Counter-offer on ${l.title}`, `${req.user.name} countered with ${fmt(input.price, l.currency)}`, `#/inbox/${t.id}`, q);
    } else {
      await post(q, t, req.user, `${status === 'accepted' ? 'Accepted' : 'Declined'} the offer of ${fmt(o.price, l.currency)}.`, o.id);
      await notify(to, 'offer', `Offer ${status}`, `${req.user.name} ${status} your offer on ${l.title}`, `#/inbox/${t.id}`, q);
    }
  });
  res.json({ ok: true });
});

module.exports = router;
