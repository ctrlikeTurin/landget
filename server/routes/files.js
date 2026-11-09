// Serves private verification documents. There is no static route to uploads/private.
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { PRIVATE_DIR } = require('../lib/upload');

const router = express.Router();

router.get('/:listingId/:kind', (req, res) => {
  const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(req.params.listingId));
  if (!l) return res.status(404).json({ error: 'Not found.' });
  const u = req.user;
  const privileged = u && (u.id === l.owner_id || u.role === 'admin');

  let file;
  if (req.params.kind === 'id') {
    if (!privileged) return res.status(404).json({ error: 'Not found.' }); // 404, not 403: don't confirm it exists
    file = l.id_file;
  } else if (req.params.kind === 'deed') {
    if (!privileged && !(l.show_deed && l.status === 'verified')) return res.status(404).json({ error: 'Not found.' });
    file = l.deed_file;
  } else {
    return res.status(404).json({ error: 'Not found.' });
  }
  const full = file && path.join(PRIVATE_DIR, path.basename(file));
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'Not found.' });
  // The page CSP would stop Chrome's built-in PDF viewer; this response is a PDF or image, not HTML.
  res.removeHeader('Content-Security-Policy');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(full);
});

module.exports = router;
