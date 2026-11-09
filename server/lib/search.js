// Free-text query parsing + listing search, shared by /api/listings and the chatbot.
const db = require('../db');
const { SIZE_UNITS } = require('./validate');

const TYPE_WORDS = {
  agricultural: ['farm', 'farmland', 'farming', 'agricultural', 'agriculture', 'crop', 'crops', 'shamba', 'arable'],
  residential: ['residential', 'house', 'home', 'housing', 'plot'],
  commercial: ['commercial', 'shop', 'office', 'retail', 'business'],
  grazing: ['grazing', 'ranch', 'pasture', 'livestock', 'cattle'],
  forest: ['forest', 'woodland', 'trees', 'timber'],
  industrial: ['industrial', 'factory', 'warehouse'],
  mixed: ['mixed'],
};
const LISTING_WORDS = {
  lease: ['lease', 'rent', 'rental', 'leasing', 'hire'],
  sale: ['sale', 'buy', 'purchase', 'sell', 'freehold'],
  partnership: ['partnership', 'partner', 'profit-sharing', 'profit', 'joint', 'sharing'],
};
const STOP = new Set(['i', 'a', 'an', 'the', 'for', 'of', 'in', 'to', 'and', 'or', 'with', 'want', 'need', 'looking', 'land', 'near', 'around', 'under', 'below', 'less', 'than', 'over', 'above', 'more', 'per', 'year', 'month', 'season', 'acre', 'acres', 'hectare', 'hectares', 'ha', 'sqm', 'max', 'min', 'at', 'least', 'most', 'me', 'some', 'any', 'cheap', 'about', 'is', 'there', 'find', 'show', 'please', 'can', 'you', 'up', 'budget', 'my', 'kes', 'ksh', 'rwf', 'usd', 'yearly', 'monthly', 'annually', 'from', 'on', 'between']);

const money = (n, suffix) => {
  let v = parseFloat(String(n).replace(/,/g, ''));
  const s = (suffix || '').toLowerCase();
  if (s === 'k') v *= 1e3; else if (s === 'm' || s === 'million') v *= 1e6;
  return v;
};

// "2 acres farmland near Nakuru under 50k per year" → structured filters + leftover words.
function parseQuery(q) {
  const out = {};
  let text = ` ${String(q || '').toLowerCase()} `;

  const size = text.match(/(\d+(?:\.\d+)?)\s*(acres?|hectares?|ha|sqm|m2)\b/);
  if (size) {
    const unit = /^ha|hect/.test(size[2]) ? 'hectares' : /sqm|m2/.test(size[2]) ? 'sqm' : 'acres';
    const acres = parseFloat(size[1]) * SIZE_UNITS[unit];
    const before = text.slice(0, size.index);
    if (/(at least|min(imum)?|over|above|more than)\s*$/.test(before)) out.size_min = acres;
    else if (/(up to|max(imum)?|under|below|less than)\s*$/.test(before)) out.size_max = acres;
    else out.size_min = acres * 0.8; // "2 acres" means "about 2 or more"
    text = text.replace(size[0], ' ');
  }

  const max = text.match(/(?:under|below|less than|max(?:imum)?|up to|budget(?: of)?|within)\s*(?:kes|ksh|rwf|usd|\$)?\s*([\d,.]+)\s*(k|m|million)?\b/);
  if (max) { out.price_max = money(max[1], max[2]); text = text.replace(max[0], ' '); }
  const min = text.match(/(?:over|above|more than|at least|from)\s*(?:kes|ksh|rwf|usd|\$)?\s*([\d,.]+)\s*(k|m|million)?\b/);
  if (min) { out.price_min = money(min[1], min[2]); text = text.replace(min[0], ' '); }

  const pu = text.match(/\b(per|a|\/)\s*(year|month|season)\b|\b(yearly|annually|monthly)\b/);
  if (pu) out.price_unit = pu[2] || (pu[3] === 'monthly' ? 'month' : 'year');

  const words = text.split(/[^a-z0-9-]+/).filter(Boolean);
  const rest = [];
  for (const w of words) {
    const lt = Object.keys(TYPE_WORDS).find((k) => TYPE_WORDS[k].includes(w));
    const ls = Object.keys(LISTING_WORDS).find((k) => LISTING_WORDS[k].includes(w));
    if (lt && !out.land_type) out.land_type = lt;
    else if (ls && !out.listing_type) out.listing_type = ls;
    else if (w === 'kenya' || w === 'rwanda') out.country = w[0].toUpperCase() + w.slice(1);
    else if (!lt && !ls && !STOP.has(w) && !/^\d/.test(w) && w.length > 2) rest.push(w);
  }
  if (rest.length) out.text = rest.join(' ');
  return out;
}

const haversineKm = (a, b, c, d) => {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// Converts duration bounds to months so "years" and "months" listings compare.
const MONTHS = "(CASE WHEN l.duration_unit = 'years' THEN 12 ELSE 1 END)";

function search(f = {}, { limit = 50, offset = 0 } = {}) {
  const where = ["l.status = 'verified'"];
  const p = {};
  if (f.text) {
    // Every remaining word must appear somewhere in title/description/location.
    String(f.text).split(/\s+/).filter(Boolean).slice(0, 6).forEach((w, i) => {
      where.push(`(LOWER(l.title || ' ' || l.description || ' ' || l.town || ' ' || l.region || ' ' || l.country) LIKE @w${i})`);
      p[`w${i}`] = `%${w.toLowerCase()}%`;
    });
  }
  if (f.land_type) { where.push('l.land_type = @land_type'); p.land_type = f.land_type; }
  if (f.listing_type) { where.push("(',' || l.listing_types || ',') LIKE @lt"); p.lt = `%,${f.listing_type},%`; }
  if (f.country) { where.push('LOWER(l.country) = LOWER(@country)'); p.country = f.country; }
  if (f.region) { where.push("LOWER(l.region || ' ' || l.town) LIKE @region"); p.region = `%${String(f.region).toLowerCase()}%`; }
  if (f.price_min != null && f.price_min !== '') { where.push('l.price >= @pmin'); p.pmin = Number(f.price_min); }
  if (f.price_max != null && f.price_max !== '') { where.push('l.price <= @pmax'); p.pmax = Number(f.price_max); }
  if (f.price_unit) { where.push('l.price_unit = @pu'); p.pu = f.price_unit; }
  if (f.currency) { where.push('l.currency = @cur'); p.cur = f.currency; }
  if (f.size_min != null && f.size_min !== '') { where.push('l.size_acres >= @smin'); p.smin = Number(f.size_min); }
  if (f.size_max != null && f.size_max !== '') { where.push('l.size_acres <= @smax'); p.smax = Number(f.size_max); }
  if (f.duration_months) {
    // Listing's allowed range must include the requested duration.
    where.push(`(l.duration_min IS NULL OR l.duration_min * ${MONTHS} <= @dm) AND (l.duration_max IS NULL OR l.duration_max * ${MONTHS} >= @dm)`);
    p.dm = Number(f.duration_months);
  }

  const order = {
    newest: 'l.created_at DESC, l.id DESC',
    price_asc: 'l.price ASC', price_desc: 'l.price DESC',
    size_asc: 'l.size_acres ASC', size_desc: 'l.size_acres DESC',
  }[f.sort] || 'l.created_at DESC, l.id DESC';

  let rows = db.prepare(`
    SELECT l.*, (SELECT filename FROM photos WHERE listing_id = l.id ORDER BY position LIMIT 1) AS cover
    FROM listings l WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(p);

  // "Near me": distance filter in JS (SQLite has no trig; PostGIS would do this in SQL).
  const lat = Number(f.near_lat), lng = Number(f.near_lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && f.near_lat !== undefined && f.near_lat !== '') {
    const radius = Number(f.radius_km) || 50;
    rows = rows
      .filter((r) => r.lat != null)
      .map((r) => ({ ...r, distance_km: +haversineKm(lat, lng, r.lat, r.lng).toFixed(1) }))
      .filter((r) => r.distance_km <= radius);
    if (!f.sort) rows.sort((a, b) => a.distance_km - b.distance_km);
  }
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

module.exports = { parseQuery, search, haversineKm };
