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

  // A named currency narrows results, so "1 million RWF" doesn't match KES listings.
  const cur = text.match(/\b(kes|kshs|ksh|rwf|frw|usd|ugx|tzs)\b|\$/);
  if (cur) out.currency = cur[1] ? ({ ksh: 'KES', kshs: 'KES', frw: 'RWF' }[cur[1]] || cur[1].toUpperCase()) : 'USD';

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

async function search(f = {}, { limit = 50, offset = 0 } = {}) {
  const where = ["l.status = 'verified'"];
  const p = [];
  const add = (sql, ...vals) => { where.push(sql); p.push(...vals); };
  const has = (v) => v != null && v !== '';
  if (f.text) {
    // Every remaining word must appear somewhere in title/description/location.
    for (const w of String(f.text).split(/s+/).filter(Boolean).slice(0, 6)) {
      add("LOWER(l.title || ' ' || l.description || ' ' || l.town || ' ' || l.region || ' ' || l.country) LIKE ?", `%${w.toLowerCase()}%`);
    }
  }
  if (f.land_type) add('l.land_type = ?', f.land_type);
  if (f.listing_type) add("(',' || l.listing_types || ',') LIKE ?", `%,${f.listing_type},%`);
  if (f.country) add('LOWER(l.country) = LOWER(?)', f.country);
  if (f.region) add("LOWER(l.region || ' ' || l.town) LIKE ?", `%${String(f.region).toLowerCase()}%`);
  if (has(f.price_min)) add('l.price >= ?', Number(f.price_min));
  if (has(f.price_max)) add('l.price <= ?', Number(f.price_max));
  if (f.price_unit) add('l.price_unit = ?', f.price_unit);
  if (f.currency) add('l.currency = ?', f.currency);
  if (has(f.size_min)) add('l.size_acres >= ?', Number(f.size_min));
  if (has(f.size_max)) add('l.size_acres <= ?', Number(f.size_max));
  if (f.duration_months) {
    // Listing's allowed range must include the requested duration.
    const dm = Number(f.duration_months);
    add(`(l.duration_min IS NULL OR l.duration_min * ${MONTHS} <= ?) AND (l.duration_max IS NULL OR l.duration_max * ${MONTHS} >= ?)`, dm, dm);
  }

  const order = {
    newest: 'l.created_at DESC, l.id DESC',
    price_asc: 'l.price ASC', price_desc: 'l.price DESC',
    size_asc: 'l.size_acres ASC', size_desc: 'l.size_acres DESC',
  }[f.sort] || 'l.created_at DESC, l.id DESC';

  let rows = await db.all(`
    SELECT l.*, (SELECT filename FROM photos WHERE listing_id = l.id ORDER BY position LIMIT 1) AS cover
    FROM listings l WHERE ${where.join(' AND ')} ORDER BY ${order}`, ...p);

  // "Near me": distance filter in JS (portable across SQLite/Postgres; PostGIS could do this in SQL).
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
