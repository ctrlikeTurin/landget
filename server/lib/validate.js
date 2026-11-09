// Small hand-rolled validators; each throws an error carrying status 400 and a readable message.
class ValidationError extends Error { constructor(m) { super(m); this.status = 400; } }

const LAND_TYPES = ['agricultural', 'residential', 'commercial', 'grazing', 'forest', 'industrial', 'mixed'];
const LISTING_TYPES = ['lease', 'sale', 'partnership'];
const SIZE_UNITS = { acres: 1, hectares: 2.47105, sqm: 0.000247105 };
const PRICE_UNITS = ['month', 'year', 'season', 'total'];
const DURATION_UNITS = ['months', 'years'];
const CURRENCIES = ['KES', 'RWF', 'USD', 'UGX', 'TZS'];
const PERMITTED = ['crop farming', 'livestock', 'building', 'horticulture', 'poultry', 'agroforestry', 'storage', 'commercial use', 'solar farm', 'beekeeping'];
const PROHIBITED = ['mining', 'sub-leasing', 'felling trees', 'dumping', 'quarrying', 'permanent structures', 'chemical spraying', 'hunting'];
const FEATURE_KEYS = ['water_source', 'road_access', 'electricity', 'soil_type', 'fenced', 'borehole', 'irrigation'];

const str = (v, name, { min = 0, max = 2000, required = false } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ValidationError(`${name} is required.`);
    return '';
  }
  const s = String(v).trim();
  if (s.length < min) throw new ValidationError(`${name} must be at least ${min} characters.`);
  if (s.length > max) throw new ValidationError(`${name} must be at most ${max} characters.`);
  return s;
};
const num = (v, name, { min = 0, max = 1e12, required = false } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ValidationError(`${name} is required.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${name} must be a number between ${min} and ${max}.`);
  return n;
};
const oneOf = (v, name, opts, required = true) => {
  if (!v && !required) return null;
  if (!opts.includes(v)) throw new ValidationError(`${name} must be one of: ${opts.join(', ')}.`);
  return v;
};
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
const arr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) { try { return JSON.parse(v); } catch { return []; } }
  if (typeof v === 'string' && v) return v.split(',');
  return [];
};
const email = (v, name = 'Email', required = true) => {
  const s = str(v, name, { max: 200, required }).toLowerCase();
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ValidationError(`${name} is not valid.`);
  return s;
};
const parseObj = (v) => {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}'); } catch { return {}; }
};
const cleanList = (v) => JSON.stringify(arr(v).map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 20));

function listingInput(b) {
  const listingTypes = arr(b.listing_types).map(String).filter((t) => LISTING_TYPES.includes(t));
  if (!listingTypes.length) throw new ValidationError('Choose at least one listing type (lease, sale or partnership).');
  const size = num(b.size, 'Size', { min: 0.0001, required: true });
  const sizeUnit = oneOf(b.size_unit, 'Size unit', Object.keys(SIZE_UNITS));
  const rawF = parseObj(b.features);
  const features = {};
  for (const k of FEATURE_KEYS) {
    if (rawF[k] === undefined || rawF[k] === '' || rawF[k] === false) continue;
    features[k] = rawF[k] === true || rawF[k] === 'true' ? true : String(rawF[k]).slice(0, 100);
  }
  const deed = str(b.deed_number, 'Deed number', { max: 60 }).toUpperCase().replace(/\s+/g, '');
  const dMin = num(b.duration_min, 'Minimum duration', { max: 1200 });
  const dMax = num(b.duration_max, 'Maximum duration', { max: 1200 });
  if (dMin !== null && dMax !== null && dMin > dMax) throw new ValidationError('Minimum duration cannot exceed maximum duration.');
  return {
    title: str(b.title, 'Title', { min: 5, max: 120, required: true }),
    description: str(b.description, 'Description', { max: 5000 }),
    land_type: oneOf(b.land_type, 'Land type', LAND_TYPES),
    size, size_unit: sizeUnit, size_acres: +(size * SIZE_UNITS[sizeUnit]).toFixed(4),
    listing_types: listingTypes.join(','),
    price: num(b.price, 'Price', { min: 0, required: true }),
    currency: oneOf(b.currency || 'KES', 'Currency', CURRENCIES),
    price_unit: oneOf(b.price_unit, 'Price unit', PRICE_UNITS),
    negotiable: bool(b.negotiable) ? 1 : 0,
    duration_min: dMin,
    duration_max: dMax,
    duration_unit: oneOf(b.duration_unit, 'Duration unit', DURATION_UNITS, false),
    available_from: str(b.available_from, 'Available from', { max: 10 }) || null,
    country: str(b.country, 'Country', { min: 2, max: 60, required: true }),
    region: str(b.region, 'Region', { max: 80 }),
    town: str(b.town, 'Town', { max: 80 }),
    lat: num(b.lat, 'Latitude', { min: -90, max: 90 }),
    lng: num(b.lng, 'Longitude', { min: -180, max: 180 }),
    permitted_uses: cleanList(b.permitted_uses),
    prohibited_uses: cleanList(b.prohibited_uses),
    uses_notes: str(b.uses_notes, 'Use notes', { max: 1000 }),
    features: JSON.stringify(features),
    contact_phone: str(b.contact_phone, 'Phone', { max: 30 }) || null,
    contact_whatsapp: str(b.contact_whatsapp, 'WhatsApp', { max: 30 }) || null,
    contact_email: email(b.contact_email, 'Contact email', false) || null,
    deed_number: deed || null,
    show_deed: bool(b.show_deed) ? 1 : 0,
  };
}

module.exports = {
  ValidationError, str, num, oneOf, bool, arr, email, listingInput,
  LAND_TYPES, LISTING_TYPES, SIZE_UNITS, PRICE_UNITS, DURATION_UNITS, CURRENCIES, PERMITTED, PROHIBITED, FEATURE_KEYS,
};
