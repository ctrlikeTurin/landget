const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { issue, COOKIE, requireAuth } = require('../middleware/auth');
const v = require('../lib/validate');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

router.post('/register', loginLimiter, (req, res) => {
  const b = req.body || {};
  const name = v.str(b.name, 'Name', { min: 2, max: 80, required: true });
  const email = v.email(b.email);
  const phone = v.str(b.phone, 'Phone', { max: 30 }) || null;
  const role = v.oneOf(b.role, 'Role', ['lender', 'customer']); // admins are created only by the seed
  const password = String(b.password || '');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and include a letter and a number.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const { lastInsertRowid } = db.prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, phone, hash, role);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  issue(res, user);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', loginLimiter, (req, res) => {
  const email = v.email(req.body && req.body.email);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Compare even when the user is missing so response time doesn't reveal which emails exist.
  const ok = bcrypt.compareSync(String((req.body && req.body.password) || ''), user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!user || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (user.suspended) return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
  issue(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

router.patch('/me', requireAuth, (req, res) => {
  const name = v.str(req.body.name, 'Name', { min: 2, max: 80, required: true });
  const phone = v.str(req.body.phone, 'Phone', { max: 30 }) || null;
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, req.user.id);
  res.json({ user: publicUser({ ...req.user, name, phone }) });
});

module.exports = router;
