// Serves private verification documents. There is no public URL for the private bucket.
const express = require('express');
const db = require('../db');
const storage = require('../lib/storage');

const router = express.Router();
const notFound = (res) => res.status(404).json({ error: 'Not found.' }); // 404, not 403: don't confirm a file exists

const sendPrivate = (res, obj) => {
  // The page CSP would stop Chrome's built-in PDF viewer; this response is a PDF or image, not HTML.
  res.removeHeader('Content-Security-Policy');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(obj.contentType).send(obj.buffer);
};

// Owner's on-site check photo: owner and admins only.
router.get('/:listingId/site/:checkId', async (req, res) => {
  const c = await db.get(
    'SELECT c.photo, l.owner_id FROM site_checks c JOIN listings l ON l.id = c.listing_id WHERE c.id = ? AND c.listing_id = ?',
    Number(req.params.checkId) || 0, Number(req.params.listingId) || 0,
  );
  const u = req.user;
  if (!c || !u || (u.id !== c.owner_id && u.role !== 'admin')) return notFound(res);
  const obj = await storage.get('private', c.photo);
  if (!obj) return notFound(res);
  sendPrivate(res, obj);
});

router.get('/:listingId/:kind', async (req, res) => {
  const l = await db.get('SELECT * FROM listings WHERE id = ?', Number(req.params.listingId) || 0);
  if (!l) return notFound(res);
  const u = req.user;
  const privileged = u && (u.id === l.owner_id || u.role === 'admin');

  let file;
  if (req.params.kind === 'id') {
    if (!privileged) return notFound(res);
    file = l.id_file;
  } else if (req.params.kind === 'deed') {
    if (!privileged && !(l.show_deed && l.status === 'verified')) return notFound(res);
    file = l.deed_file;
  } else {
    return notFound(res);
  }
  const obj = file && await storage.get('private', file);
  if (!obj) return notFound(res);
  sendPrivate(res, obj);
});

module.exports = router;
