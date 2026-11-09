const express = require('express');
const db = require('../db');
const storage = require('../lib/storage');
const { requireAuth, requireRole } = require('../middleware/auth');
const { handleListingUpload, handleSitePhoto, storeFiles, discardFiles } = require('../lib/upload');
const { parseQuery, search, haversineKm } = require('../lib/search');
const notify = require('../lib/notify');
const v = require('../lib/validate');

const router = express.Router();

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// On-site check passes when the phone was this close to the pin, with a usable GPS fix.
const SITE_RADIUS_M = 300;
const SITE_MAX_ACCURACY_M = 100;
const LEVELS = ['Not verified', 'Documents checked', 'Title search confirmed', 'Site visit confirmed'];

// Latest owner site check, judged against the listing's CURRENT pin (moving the pin re-judges it).
async function siteCheckFor(l) {
  const c = await db.get('SELECT * FROM site_checks WHERE listing_id = ? ORDER BY id DESC LIMIT 1', l.id);
  if (!c) return null;
  const distance = l.lat == null ? null : Math.round(haversineKm(c.lat, c.lng, l.lat, l.lng) * 1000);
  return {
    id: c.id, at: c.created_at, distance_m: distance, accuracy_m: Math.round(c.accuracy_m),
    passed: distance != null && distance <= SITE_RADIUS_M && c.accuracy_m <= SITE_MAX_ACCURACY_M,
  };
}

// Card-sized view of a listing; safe for anyone.
function serialize(l, _viewer) {
  const out = {
    id: l.id, title: l.title, land_type: l.land_type,
    size: l.size, size_unit: l.size_unit, size_acres: l.size_acres,
    listing_types: l.listing_types.split(','),
    price: l.price, currency: l.currency, price_unit: l.price_unit, negotiable: !!l.negotiable,
    country: l.country, region: l.region, town: l.town, lat: l.lat, lng: l.lng,
    status: l.status, verified: l.status === 'verified',
    verification_level: l.status === 'verified' ? (l.verification_level || 0) : 0,
    cover: l.cover ? storage.publicUrl(l.cover) : null,
    created_at: l.created_at,
  };
  if (l.distance_km !== undefined) out.distance_km = l.distance_km;
  return out;
}

// The single place that decides which detail fields a viewer may see.
async function serializeFull(l, viewer) {
  const isOwner = !!(viewer && viewer.id === l.owner_id);
  const isAdmin = !!(viewer && viewer.role === 'admin');
  const [photos, owner, site] = await Promise.all([
    db.all('SELECT id, filename FROM photos WHERE listing_id = ? ORDER BY position, id', l.id),
    db.get('SELECT name FROM users WHERE id = ?', l.owner_id),
    siteCheckFor(l),
  ]);
  const out = {
    ...serialize({ ...l, cover: l.cover || (photos[0] && photos[0].filename) }, viewer),
    description: l.description,
    duration_min: l.duration_min, duration_max: l.duration_max, duration_unit: l.duration_unit,
    available_from: l.available_from,
    permitted_uses: json(l.permitted_uses, []), prohibited_uses: json(l.prohibited_uses, []),
    uses_notes: l.uses_notes, features: json(l.features, {}),
    photos: photos.map((p) => ({ id: p.id, url: storage.publicUrl(p.filename) })),
    owner: { name: owner && owner.name },
    show_deed: !!l.show_deed,
    is_owner: isOwner,
    verification_label: LEVELS[l.status === 'verified' ? (l.verification_level || 0) : 0],
    // Public: only whether the owner proved they were on the land, and when.
    site_check: site && site.passed ? { passed: true, at: site.at } : null,
    // Contacts are shown only to logged-in users.
    contacts: viewer ? { phone: l.contact_phone, whatsapp: l.contact_whatsapp, email: l.contact_email } : null,
  };
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
      title_search_ref: l.title_search_ref, site_visit_note: l.site_visit_note,
      // Owner/admin see the full result, including failures, and the private photo.
      site_check: site && { ...site, photo_url: `/api/files/${l.id}/site/${site.id}` },
    });
  }
  return out;
}

const getListing = (id) => db.get('SELECT * FROM listings WHERE id = ?', Number(id) || 0);

async function ownListing(req, res) {
  const l = await getListing(req.params.id);
  if (!l) { res.status(404).json({ error: 'Listing not found.' }); return null; }
  if (l.owner_id !== req.user.id && req.user.role !== 'admin') { res.status(403).json({ error: 'Not your listing.' }); return null; }
  return l;
}

// Flags every non-rejected listing that shares this deed number (fraud signal for admins).
async function flagDuplicateDeeds(deed) {
  if (!deed) return;
  const rows = await db.all("SELECT id FROM listings WHERE deed_number = ? AND status != 'rejected'", deed);
  await db.run("UPDATE listings SET duplicate_deed = ? WHERE deed_number = ? AND status != 'rejected'", rows.length > 1 ? 1 : 0, deed);
}

async function submitForReview(l) {
  if (!l.deed_file || !l.id_file) {
    throw new v.ValidationError('Upload both the title deed and your national ID or passport before submitting for verification.');
  }
  // Re-review starts the levels over: an edited deed or location needs checking again.
  await db.run("UPDATE listings SET status = 'pending', reject_reason = NULL, verification_level = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", l.id);
  await flagDuplicateDeeds(l.deed_number);
  for (const a of await db.all("SELECT id FROM users WHERE role = 'admin'")) {
    await notify(a.id, 'review', 'New listing to verify', l.title, '#/admin');
  }
}

// Records uploaded files on the listing; replaced documents are deleted from storage afterwards.
async function attachFiles(q, listingId, files) {
  const replaced = [];
  const photos = (files && files.photos) || [];
  const { n } = await q.get('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM photos WHERE listing_id = ?', listingId);
  for (const [i, f] of photos.entries()) {
    await q.run('INSERT INTO photos (listing_id, filename, position) VALUES (?, ?, ?)', listingId, f.filename, n + i);
  }
  for (const [field, col] of [['deed', 'deed_file'], ['id_doc', 'id_file']]) {
    if (!files || !files[field]) continue;
    const prev = await q.get(`SELECT ${col} AS f FROM listings WHERE id = ?`, listingId);
    if (prev && prev.f) replaced.push(prev.f);
    await q.run(`UPDATE listings SET ${col} = ? WHERE id = ?`, files[field][0].filename, listingId);
  }
  return replaced;
}

// ---- Public ----

router.get('/meta', (_req, res) => {
  res.json({
    land_types: v.LAND_TYPES, listing_types: v.LISTING_TYPES, size_units: Object.keys(v.SIZE_UNITS),
    price_units: v.PRICE_UNITS, duration_units: v.DURATION_UNITS, currencies: v.CURRENCIES,
    permitted: v.PERMITTED, prohibited: v.PROHIBITED, features: v.FEATURE_KEYS,
  });
});

router.get('/', async (req, res) => {
  const q = req.query;
  // Explicit filters win over anything parsed from the free-text box.
  const parsed = q.q ? parseQuery(q.q) : {};
  const filters = { ...parsed };
  for (const k of ['land_type', 'listing_type', 'country', 'region', 'price_min', 'price_max', 'price_unit', 'currency', 'size_min', 'size_max', 'duration_months', 'sort', 'near_lat', 'near_lng', 'radius_km']) {
    if (q[k] !== undefined && q[k] !== '') filters[k] = q[k];
  }
  const limit = Math.min(Number(q.limit) || 100, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const { total, rows } = await search(filters, { limit, offset });
  const saved = req.user ? new Set((await db.all('SELECT listing_id FROM saves WHERE user_id = ?', req.user.id)).map((r) => r.listing_id)) : new Set();
  res.json({ total, parsed, results: rows.map((r) => ({ ...serialize(r, req.user), saved: saved.has(r.id) })) });
});

// ---- Lender ----

router.get('/mine', requireRole('lender', 'admin'), async (req, res) => {
  const rows = await db.all(`
    SELECT l.*,
      (SELECT COUNT(*) FROM saves WHERE listing_id = l.id) AS saves,
      (SELECT COUNT(*) FROM threads WHERE listing_id = l.id) AS inquiries
    FROM listings l WHERE owner_id = ? ORDER BY updated_at DESC`, req.user.id);
  const results = [];
  for (const r of rows) results.push({ ...(await serializeFull(r, req.user)), saves: r.saves, inquiries: r.inquiries });
  res.json({ results });
});

router.get('/saved', requireAuth, async (req, res) => {
  const rows = await db.all(`
    SELECT l.*, (SELECT filename FROM photos WHERE listing_id = l.id ORDER BY position LIMIT 1) AS cover
    FROM saves s JOIN listings l ON l.id = s.listing_id
    WHERE s.user_id = ? AND l.status = 'verified' ORDER BY s.created_at DESC`, req.user.id);
  res.json({ results: rows.map((r) => ({ ...serialize(r, req.user), saved: true })) });
});

router.post('/', requireRole('lender'), handleListingUpload, async (req, res) => {
  const files = req.files || {};
  const data = v.listingInput(req.body);
  const submit = v.bool(req.body.submit);
  if (submit && (!files.deed || !files.id_doc)) {
    throw new v.ValidationError('Upload both the title deed and your national ID or passport before submitting for verification, or save as a draft.');
  }
  await storeFiles(files);
  let id;
  try {
    const cols = Object.keys(data);
    id = await db.tx(async (q) => {
      const newId = await q.insert(
        `INSERT INTO listings (owner_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
        req.user.id, ...cols.map((c) => data[c]),
      );
      await attachFiles(q, newId, files);
      return newId;
    });
  } catch (e) { await discardFiles(files); throw e; }
  if (submit) await submitForReview(await getListing(id));
  res.status(201).json({ listing: await serializeFull(await getListing(id), req.user) });
});

router.put('/:id', requireRole('lender', 'admin'), handleListingUpload, async (req, res) => {
  const l = await ownListing(req, res); if (!l) return;
  const data = v.listingInput(req.body);
  await storeFiles(req.files);
  let replaced;
  try {
    replaced = await db.tx(async (q) => {
      const cols = Object.keys(data);
      await q.run(`UPDATE listings SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, ...cols.map((c) => data[c]), l.id);
      return attachFiles(q, l.id, req.files);
    });
  } catch (e) { await discardFiles(req.files); throw e; }
  for (const f of replaced) await storage.remove('private', f);
  if (data.deed_number !== l.deed_number) { await flagDuplicateDeeds(l.deed_number); await flagDuplicateDeeds(data.deed_number); }
  // Any edit to a published or rejected listing goes back through verification.
  if (v.bool(req.body.submit) || ['verified', 'rejected'].includes(l.status)) await submitForReview(await getListing(l.id));
  res.json({ listing: await serializeFull(await getListing(l.id), req.user) });
});

router.post('/:id/submit', requireRole('lender'), async (req, res) => {
  const l = await ownListing(req, res); if (!l) return;
  await submitForReview(l);
  res.json({ listing: await serializeFull(await getListing(l.id), req.user) });
});

router.post('/:id/pause', requireRole('lender'), async (req, res) => {
  const l = await ownListing(req, res); if (!l) return;
  if (l.status !== 'verified') return res.status(400).json({ error: 'Only live (verified) listings can be paused.' });
  await db.run("UPDATE listings SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE id = ?", l.id);
  res.json({ ok: true });
});

router.post('/:id/resume', requireRole('lender'), async (req, res) => {
  const l = await ownListing(req, res); if (!l) return;
  if (l.status !== 'paused') return res.status(400).json({ error: 'Listing is not paused.' });
  await db.run("UPDATE listings SET status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ?", l.id);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('lender', 'admin'), async (req, res) => {
  const l = await ownListing(req, res); if (!l) return;
  const photos = await db.all('SELECT filename FROM photos WHERE listing_id = ?', l.id);
  const sitePhotos = await db.all('SELECT photo FROM site_checks WHERE listing_id = ?', l.id);
  await db.run('DELETE FROM listings WHERE id = ?', l.id);
  await Promise.all([
    ...photos.map((p) => storage.remove('public', p.filename)),
    ...sitePhotos.map((p) => storage.remove('private', p.photo)),
    storage.remove('private', l.deed_file),
    storage.remove('private', l.id_file),
  ]);
  await flagDuplicateDeeds(l.deed_number);
  res.json({ ok: true });
});

router.delete('/:id/photos/:photoId', requireRole('lender'), async (req, res) => {
  const l = await ownListing(req, res); if (!l) return;
  const p = await db.get('SELECT * FROM photos WHERE id = ? AND listing_id = ?', Number(req.params.photoId) || 0, l.id);
  if (!p) return res.status(404).json({ error: 'Photo not found.' });
  await db.run('DELETE FROM photos WHERE id = ?', p.id);
  await storage.remove('public', p.filename);
  res.json({ ok: true });
});

// Owner's on-site check: photo taken on the land plus the phone's GPS fix at that moment.
// Browser GPS can be spoofed, so this is evidence for the admin and a badge, not proof on its own.
router.post('/:id/site-check', requireRole('lender'), handleSitePhoto, async (req, res) => {
  const l = await ownListing(req, res); if (!l) return;
  if (l.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can do the on-site check.' });
  if (l.lat == null) return res.status(400).json({ error: 'Place the land on the map first, then do the on-site check.' });
  const lat = v.num(req.body.lat, 'Latitude', { min: -90, max: 90, required: true });
  const lng = v.num(req.body.lng, 'Longitude', { min: -180, max: 180, required: true });
  const accuracy = v.num(req.body.accuracy, 'GPS accuracy', { min: 0, max: 100000, required: true });
  await storage.put('private', req.file.filename, req.file.buffer, req.file.mimetype);
  await db.insert('INSERT INTO site_checks (listing_id, user_id, photo, lat, lng, accuracy_m) VALUES (?, ?, ?, ?, ?, ?)',
    l.id, req.user.id, req.file.filename, lat, lng, accuracy);
  const site = await siteCheckFor(l);
  let message;
  if (site.passed) message = `On-site check passed: you were ${site.distance_m} m from the pin.`;
  else if (accuracy > SITE_MAX_ACCURACY_M) message = `Your GPS was too imprecise (±${Math.round(accuracy)} m). Go outside, wait a minute for a better signal, and try again.`;
  else message = `You were ${site.distance_m} m from the pin; it must be within ${SITE_RADIUS_M} m. Stand on the land, or fix the pin, and try again.`;
  res.status(201).json({ site_check: site, message });
});

// ---- Detail, saves, reports ----

router.get('/:id', async (req, res) => {
  const l = await getListing(req.params.id);
  const canSeeUnpublished = req.user && l && (req.user.id === l.owner_id || req.user.role === 'admin');
  if (!l || (l.status !== 'verified' && !canSeeUnpublished)) return res.status(404).json({ error: 'Listing not found.' });
  const [, out, saved] = await Promise.all([
    !req.user || req.user.id !== l.owner_id ? db.run('UPDATE listings SET views = views + 1 WHERE id = ?', l.id) : null,
    serializeFull(l, req.user),
    req.user ? db.get('SELECT 1 FROM saves WHERE user_id = ? AND listing_id = ?', req.user.id, l.id) : null,
  ]);
  out.saved = !!saved;
  res.json({ listing: out });
});

router.post('/:id/save', requireAuth, async (req, res) => {
  const l = await getListing(req.params.id);
  if (!l || l.status !== 'verified') return res.status(404).json({ error: 'Listing not found.' });
  const exists = await db.get('SELECT 1 FROM saves WHERE user_id = ? AND listing_id = ?', req.user.id, l.id);
  if (exists) await db.run('DELETE FROM saves WHERE user_id = ? AND listing_id = ?', req.user.id, l.id);
  else await db.run('INSERT INTO saves (user_id, listing_id) VALUES (?, ?)', req.user.id, l.id);
  res.json({ saved: !exists });
});

router.post('/:id/report', requireAuth, async (req, res) => {
  const l = await getListing(req.params.id);
  if (!l) return res.status(404).json({ error: 'Listing not found.' });
  const reason = v.str(req.body.reason, 'Reason', { min: 5, max: 1000, required: true });
  await db.run('INSERT INTO reports (listing_id, reporter_id, reason) VALUES (?, ?, ?)', l.id, req.user.id, reason);
  for (const a of await db.all("SELECT id FROM users WHERE role = 'admin'")) {
    await notify(a.id, 'report', 'Listing reported', `${l.title}: ${reason.slice(0, 120)}`, '#/admin');
  }
  res.status(201).json({ ok: true });
});

module.exports = { router, serialize, serializeFull, getListing, LEVELS };
