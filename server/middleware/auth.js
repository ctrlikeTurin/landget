const jwt = require('jsonwebtoken');
const db = require('../db');

const COOKIE = 'll_token';
const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'change-me') {
    if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
    return 'dev-only-secret';
  }
  return s;
};

function issue(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, secret(), { expiresIn: '7d' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

// Attaches req.user when a valid cookie is present; never rejects.
function loadUser(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    try {
      const { id } = jwt.verify(token, secret());
      const u = db.prepare('SELECT id, name, email, phone, role, suspended FROM users WHERE id = ?').get(id);
      if (u && !u.suspended) req.user = u;
    } catch { /* invalid or expired token: treat as anonymous */ }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have access to this.' });
  next();
};

module.exports = { COOKIE, issue, loadUser, requireAuth, requireRole };
