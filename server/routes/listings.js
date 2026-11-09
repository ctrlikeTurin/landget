const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { handleListingUpload, removeFile, PUBLIC_DIR, PRIVATE_DIR } = require('../lib/upload');
const { parseQuery, search } = require('../lib/search');
const notify = require('../lib/notify');
const v = require('../lib/validate');

const router = express.Router();

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const photosFor = db.prepare('SELECT id, filename FROM photos WHERE listing_id = ? ORDER BY position, id');

// The single place that decides which listing fields a viewer may see.
function serialize(l, viewer, { full = false } = {}) {
  const isOwner = viewer && viewer.id === l.owner_id;
  const isAdmin = viewer && viewer.role === 'admin';
  const out = {
    id: l.id, title: l.title, land_type: l.land_type,
    size: l.size, size_unit: l.size_unit, size_acres: l.size_acres,
    listing_types: l.listing_types.split(','),
    price: l.price, currency: l.currency, price_unit: l.price_unit, negotiable: !!l.negotiable,
    country: l.country, region: l.region, town: l.town, lat: l.lat, lng: l.lng,
    status: l.status, verified: l.status === 'verified',
    cover: l.cover ? `/uploads/${l.cover}` : null,
    created_at: l.created_at,
  };
  if (l.distance_km !== undefined) out.distance_km = l.distance_km;
  if (!full) return out;

  Object.assign(out, {
    description: l.description,
    duration_min: l.duration_min, duration_max: l.duration_max, duration_unit: l.duration_unit,
    available_from: l.available_from,
    permitted_uses: json(l.permitted_uses, []), prohibited_uses: json(l.prohibited_uses, []),
    uses_notes: l.uses_notes, features: json(l.features, {}),
    photos: photosFor.all(l.id).map((p) => ({ id: p.id, url: `/uploads/${p.filename}` })),
    owner: { name: db.prepare('SELECT name FROM users WHERE id = ?').get(l.owner_id)?.name },
    show_deed: !!l.show_deed,
    is_owner: !!isOwner,
  });
  // Contacts are shown only to logged-in users.
  out.contacts = viewer
    ? { phone: l.contact_phone, whatsapp: l.contact_whatsapp, email: l.contact_email }
    : null;
  // Deed: public only when the owner opted in; always visible to owner/admin.
  if (l.deed_file && (isOwner || isAdmin || (l.show_deed && l.status === 'verified'))) {
    out.deed_url = `/api/files/${l.id}/deed`;
  }
  // National ID / passport: owner and admins only, never anyone else.
  if (isOwner || isAdmin) {
    Object.assign(out, {
      deed_number: l.deed_number,
      id_url: l.id_file ? `/api/files/${l.id}/id` : null,
      has_deed: !!l.deed_file, has_id: !!l.id_file,
      reject_reason: l.reject_reason, duplicate_deed: !!l.duplicate_deed,
      views: l.views,
    });
  }
  return out;
}

const getListing = (id) => db.prepare('SELECT * FROM listings WHERE id = ?').get(Number(id));

function ownListing(req, res) {
  const l = getListing(req.params.id);
  if (!l) { res.status(404).json({ error: 'Listing not found.' }); return null; }
  if (l.owner_id !== req.user.id && req.user.role !== 'admin') { res.status(403).json({ error: 'Not your listing.' }); return null; }
  return l;
}

// Flags every non-rejected listing that shares this deed number (fraud signal for admins).
function flagDuplicateDeeds(deed) {
  if (!deed) return false;
  const rows = db.prepare("SELECT id FROM listings WHERE deed_number = ? AND status != 'rejected'").all(deed);
  const dup = rows.length > 1;
  db.prepare("UPDATE listings SET duplicate_deed = ? WHERE deed_number = ? AND status != 'rejected'").run(dup ? 1 : 0, deed);
  return dup;
}

function submitForReview(l) {
  if (!l.deed_file || !l.id_file) {
    const e = new Error('Upload both the title deed and your national ID or passport before submitting for verification.');
    e.status = 400; throw e;
  }
  db.prepare("UPDATE listings SET status = 'pending', reject_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(l.id);
  flagDuplicateDeeds(l.deed_number);
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) {
    notify(a.id, 'review', 'New listing to verify', l.title, `#/admin`);
  }
}

function saveFiles(listingId, files, prev) {
  const photos = (files && files.photos) || [];
  const start = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM photos WHERE listing_id = ?').get(listingId).n;
  const add = db.prepare('INSERT INTO photos (listing_id, filename, position) VALUES (?, ?, ?)');
  photos.forEach((f, i) => add.run(listingId, f.filename, start + i));
  if (files && files.deed) {
    removeFile(PRIVATE_DIR, prev && prev.deed_file);
    db.prepare('UPDATE listings SET deed_file = ? WHERE id = ?').run(files.deed[0].filename, listingId);
  }
  if (files && files.id_doc) {
    removeFile(PRIVATE_DIR, prev && prev.id_file);
    db.prepare('UPDATE listings SET id_file = ? WHERE id = ?').run(files.id_doc[0].filename, listingId);
  }
}

// ---- Public ----

router.get('/meta', (_req, res) => {
  res.json({
    land_types: v.LAND_TYPES, listing_types: v.LISTING_TYPES, size_units: Object.keys(v.SIZE_UNITS),
    price_units: v.PRICE_UNITS, duration_units: v.DURATION_UNITS, currencies: v.CURRENCIES,
    permitted: v.PERMITTED, prohibited: v.PROHIBITED, features: v.FEATURE_KEYS,
  });
});

router.get('/', (req, res) => {
  const q = req.query;
  // Explicit filters win over anything parsed from the free-text box.
  const parsed = q.q ? parseQuery(q.q) : {};
  const filters = { ...parsed };
  for (const k of ['land_type', 'listing_type', 'country', 'region', 'price_min', 'price_max', 'price_unit', 'currency', 'size_min', 'size_max', 'duration_months', 'sort', 'near_lat', 'near_lng', 'radius_km']) {
    if (q[k] !== undefined && q[k] !== '') filters[k] = q[k];
  }
  // UI sizes are in acres already.
  const limit = Math.min(Number(q.limit) || 100, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const { total, rows } = search(filters, { limit, offset });
  const saved = req.user ? new Set(db.prepare('SELECT listing_id FROM saves WHERE user_id = ?').all(req.user.id).map((r) => r.listing_id)) : new Set();
  res.json({ total, parsed, results: rows.map((r) => ({ ...serialize(r, req.user), saved: saved.has(r.id) })) });
});

// ---- Lender ----

router.get('/mine', requireRole('lender', 'admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT l.*,
      (SELECT filename FROM photos WHERE listing_id = l.id ORDER BY position LIMIT 1) AS cover,
      (SELECT COUNT(*) FROM saves WHERE listing_id = l.id) AS saves,
      (SELECT COUNT(*) FROM threads WHERE listing_id = l.id) AS inquiries
    FROM listings l WHERE owner_id = ? ORDER BY updated_at DESC`).all(req.user.id);
  res.json({ results: rows.map((r) => ({ ...serialize(r, req.user, { full: true }), saves: r.saves, inquiries: r.inquiries })) });
});

router.get('/saved', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, (SELECT filename FROM photos WHERE listing_id = l.id ORDER BY position LIMIT 1) AS cover
    FROM saves s JOIN listings l ON l.id = s.listing_id
    WHERE s.user_id = ? AND l.status = 'verified' ORDER BY s.created_at DESC`).all(req.user.id);
  res.json({ results: rows.map((r) => ({ ...serialize(r, req.user), saved: true })) });
});

router.post('/', requireRole('lender'), handleListingUpload, (req, res) => {
  const files = req.files || {};
  const discard = () => Object.values(files).flat().forEach((f) => removeFile(f.fieldname === 'photos' ? PUBLIC_DIR : PRIVATE_DIR, f.filename));
  let data;
  try {
    data = v.listingInput(req.body);
    if (v.bool(req.body.submit) && (!files.deed || !files.id_doc)) {
      throw new v.ValidationError('Upload both the title deed and your national ID or passport before submitting for verification, or save as a draft.');
    }
  } catch (e) { discard(); throw e; }
  const cols = Object.keys(data);
  const id = db.transaction(() => {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO listings (owner_id, ${cols.join(', ')}) VALUES (@owner_id, ${cols.map((c) => '@' + c).join(', ')})`,
    ).run({ owner_id: req.user.id, ...data });
    saveFiles(lastInsertRowid, req.files);
    return lastInsertRowid;
  })();
  if (v.bool(req.body.submit)) submitForReview(getListing(id));
  res.status(201).json({ listing: serialize(getListing(id), req.user, { full: true }) });
});

router.put('/:id', requireRole('lender', 'admin'), handleListingUpload, (req, res) => {
  const l = ownListing(req, res); if (!l) return;
  const data = v.listingInput(req.body);
  db.transaction(() => {
    db.prepare(`UPDATE listings SET ${Object.keys(data).map((c) => `${c} = @${c}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`)
      .run({ ...data, id: l.id });
    saveFiles(l.id, req.files, l);
  })();
  if (data.deed_number !== l.deed_number) { flagDuplicateDeeds(l.deed_number); flagDuplicateDeeds(data.deed_number); }
  const fresh = getListing(l.id);
  // Any edit to a published or rejected listing goes back through verification.
  if (v.bool(req.body.submit) || ['verified', 'rejected'].includes(l.status)) submitForReview(fresh);
  res.json({ listing: serialize(getListing(l.id), req.user, { full: true }) });
});

router.post('/:id/submit', requireRole('lender'), (req, res) => {
  const l = ownListing(req, res); if (!l) return;
  submitForReview(l);
  res.json({ listing: serialize(getListing(l.id), req.user, { full: true }) });
});

router.post('/:id/pause', requireRole('lender'), (req, res) => {
  const l = ownListing(req, res); if (!l) return;
  if (l.status !== 'verified') return res.status(400).json({ error: 'Only live (verified) listings can be paused.' });
  db.prepare("UPDATE listings SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(l.id);
  res.json({ ok: true });
});

router.post('/:id/resume', requireRole('lender'), (req, res) => {
  const l = ownListing(req, res); if (!l) return;
  if (l.status !== 'paused') return res.status(400).json({ error: 'Listing is not paused.' });
  db.prepare("UPDATE listings SET status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(l.id);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('lender', 'admin'), (req, res) => {
  const l = ownListing(req, res); if (!l) return;
  for (const p of photosFor.all(l.id)) removeFile(PUBLIC_DIR, p.filename);
  removeFile(PRIVATE_DIR, l.deed_file);
  removeFile(PRIVATE_DIR, l.id_file);
  db.prepare('DELETE FROM listings WHERE id = ?').run(l.id);
  flagDuplicateDeeds(l.deed_number);
  res.json({ ok: true });
});

router.delete('/:id/photos/:photoId', requireRole('lender'), (req, res) => {
  const l = ownListing(req, res); if (!l) return;
  const p = db.prepare('SELECT * FROM photos WHERE id = ? AND listing_id = ?').get(Number(req.params.photoId), l.id);
  if (!p) return res.status(404).json({ error: 'Photo not found.' });
  removeFile(PUBLIC_DIR, p.filename);
  db.prepare('DELETE FROM photos WHERE id = ?').run(p.id);
  res.json({ ok: true });
});

// ---- Detail, saves, reports ----

router.get('/:id', (req, res) => {
  const l = getListing(req.params.id);
  const canSeeUnpublished = req.user && l && (req.user.id === l.owner_id || req.user.role === 'admin');
  if (!l || (l.status !== 'verified' && !canSeeUnpublished)) return res.status(404).json({ error: 'Listing not found.' });
  if (!req.user || req.user.id !== l.owner_id) db.prepare('UPDATE listings SET views = views + 1 WHERE id = ?').run(l.id);
  const out = serialize(l, req.user, { full: true });
  out.saved = !!(req.user && db.prepare('SELECT 1 FROM saves WHERE user_id = ? AND listing_id = ?').get(req.user.id, l.id));
  res.json({ listing: out });
});

router.post('/:id/save', requireAuth, (req, res) => {
  const l = getListing(req.params.id);
  if (!l || l.status !== 'verified') return res.status(404).json({ error: 'Listing not found.' });
  const exists = db.prepare('SELECT 1 FROM saves WHERE user_id = ? AND listing_id = ?').get(req.user.id, l.id);
  if (exists) db.prepare('DELETE FROM saves WHERE user_id = ? AND listing_id = ?').run(req.user.id, l.id);
  else db.prepare('INSERT INTO saves (user_id, listing_id) VALUES (?, ?)').run(req.user.id, l.id);
  res.json({ saved: !exists });
});

router.post('/:id/report', requireAuth, (req, res) => {
  const l = getListing(req.params.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  const reason = v.str(req.body.reason, 'Reason', { min: 5, max: 1000, required: true });
  db.prepare('INSERT INTO reports (listing_id, reporter_id, reason) VALUES (?, ?, ?)').run(l.id, req.user.id, reason);
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'admin'").all()) {
    notify(a.id, 'report', 'Listing reported', `${l.title}: ${reason.slice(0, 120)}`, '#/admin');
  }
  res.status(201).json({ ok: true });
});

module.exports = { router, serialize, getListing };
