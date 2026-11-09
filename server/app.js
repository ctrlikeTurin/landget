require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const { loadUser } = require('./middleware/auth');
const db = require('./db');
const storage = require('./lib/storage');

const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy

// Don't serve requests until the schema and storage buckets exist.
const ready = Promise.all([db.ready, storage.ready]);
app.use((_req, _res, next) => { ready.then(() => next(), next); });

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", 'https://unpkg.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://server.arcgisonline.com', 'https://unpkg.com', ...(storage.publicOrigin ? [storage.publicOrigin] : [])],
      'connect-src': ["'self'", 'https://nominatim.openstreetmap.org'],
      'frame-src': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  // OpenStreetMap's tile servers reject requests without a Referer; send just our origin.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(compression());
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use((req, _res, next) => { if (!req.body) req.body = {}; next(); }); // Express 5 leaves it undefined
app.use(cookieParser());
app.use(loadUser);

// Public addresses that proxy to this server (e.g. the Cloudflare Pages front door), from APP_URL.
const PUBLIC_ORIGINS = String(process.env.APP_URL || '').split(',').map((u) => {
  try { return new URL(u.trim()).origin; } catch { return null; }
}).filter(Boolean);

// Simple CSRF guard: state-changing API calls must come from our own origin.
// The cookie is SameSite=Lax too; this blocks cross-site form posts in older browsers.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}` && !PUBLIC_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  next();
});

app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 10000 : 300, standardHeaders: 'draft-7', legacyHeaders: false }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/listings', require('./routes/listings').router);
app.use('/api/offers', require('./routes/offers'));
app.use('/api/messages', require('./routes/messages').router);
app.use('/api/admin', require('./routes/admin'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/files', require('./routes/files'));
app.get('/api/health', async (_req, res) => {
  await db.get('SELECT 1 AS ok');
  res.json({ ok: true, db: db.kind, storage: storage.kind, ...require('./routes/chat').aiStatus() });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Local storage only: listing photos are public; uploads/private has no static route at all.
// With Supabase, photos are served from the public bucket's own URL.
if (storage.publicDir) app.use('/uploads', express.static(storage.publicDir, { maxAge: '7d', index: false }));
// index.html must always revalidate so new deploys show up; JS/CSS can be cached for an hour.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, file) => res.set('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600'),
}));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
});

module.exports = app;
