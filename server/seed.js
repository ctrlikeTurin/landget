// Resets the database and fills it with demo users + listings in Kenya and Rwanda.
require('dotenv').config({ quiet: true });
const zlib = require('zlib');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const storage = require('./lib/storage');
const { SIZE_UNITS } = require('./lib/validate');

// ---- tiny PNG writer for placeholder landscape photos (no external downloads) ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function landscapePng(seed, palette) {
  const W = 640, H = 400;
  const rnd = (i) => { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); };
  const horizon = 150 + Math.floor(rnd(1) * 70);
  const hills = [rnd(2) * 6 + 2, rnd(3) * 40 + 20, rnd(4) * 6];
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const hill = horizon - Math.sin(x / (W / hills[0]) + hills[2]) * hills[1];
      let r, g, b;
      if (y < hill) { // sky
        const t = y / hill;
        [r, g, b] = [120 + 80 * t, 170 + 60 * t, 230 - 10 * t];
      } else { // field with crop rows
        const t = (y - hill) / (H - hill);
        const row = Math.sin((x + y * 0.6) / (6 + 10 * (1 - t))) > 0.3 ? 1 : 0.86;
        [r, g, b] = palette.map((c) => c * (0.75 + 0.35 * t) * row);
      }
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = Math.min(255, r); raw[o + 1] = Math.min(255, g); raw[o + 2] = Math.min(255, b);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const samplePdf = (label) => Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${44 + label.length}>>stream
BT /F1 16 Tf 30 100 Td (SAMPLE - ${label}) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`);
async function writeFile(bucket, ext, buf, type) {
  const n = crypto.randomBytes(16).toString('hex') + ext;
  await storage.put(bucket, n, buf, type);
  return n;
}

const L = [
  { owner: 'wanjiru', title: '5 acres of red-soil farmland near Nakuru', land_type: 'agricultural', size: 5, size_unit: 'acres', listing_types: 'lease', price: 45000, currency: 'KES', price_unit: 'year', negotiable: 1, duration_min: 1, duration_max: 5, duration_unit: 'years', country: 'Kenya', region: 'Nakuru County', town: 'Bahati', lat: -0.1489, lng: 36.1520, permitted: ['crop farming', 'horticulture', 'poultry'], prohibited: ['mining', 'sub-leasing', 'felling trees'], features: { water_source: 'Seasonal river + water tank', road_access: '300m from murram road', electricity: true, soil_type: 'Red volcanic loam', fenced: true }, desc: 'Fertile, gently sloping farmland ideal for maize, beans and potatoes. Previously farmed for 6 years with good yields. Fenced with live hedge and barbed wire. The owner lives nearby and can help arrange casual labour.', deed: 'NAKURU/BAHATI/1123', show_deed: 1, palette: [150, 110, 60] },
  { owner: 'wanjiru', title: '2 acre irrigated plot for horticulture, Naivasha', land_type: 'agricultural', size: 2, size_unit: 'acres', listing_types: 'lease,partnership', price: 30000, currency: 'KES', price_unit: 'season', negotiable: 1, duration_min: 6, duration_max: 36, duration_unit: 'months', country: 'Kenya', region: 'Nakuru County', town: 'Naivasha', lat: -0.7167, lng: 36.4333, permitted: ['crop farming', 'horticulture'], prohibited: ['chemical spraying', 'sub-leasing', 'permanent structures'], features: { water_source: 'Borehole with drip lines', road_access: 'Tarmac frontage', electricity: true, soil_type: 'Sandy loam', fenced: true, irrigation: true }, desc: 'Ready-to-plant plot with an existing drip irrigation system off a private borehole. Suited to French beans, tomatoes, onions or herbs for export. Partnership on a 60/40 produce split is possible for a serious grower.', deed: 'NAIVASHA/MWICHIRINGIRI/887', show_deed: 0, palette: [70, 140, 60] },
  { owner: 'otieno', title: '20 acres of grazing land, Kajiado', land_type: 'grazing', size: 20, size_unit: 'acres', listing_types: 'lease', price: 120000, currency: 'KES', price_unit: 'year', negotiable: 0, duration_min: 1, duration_max: 10, duration_unit: 'years', country: 'Kenya', region: 'Kajiado County', town: 'Isinya', lat: -1.6700, lng: 36.8400, permitted: ['livestock', 'beekeeping'], prohibited: ['quarrying', 'felling trees', 'dumping'], features: { water_source: 'Dam (holds water 8 months)', road_access: 'Earth road, 4x4 in rains', soil_type: 'Black cotton', fenced: false }, desc: 'Open rangeland with good grass cover after the long rains. Suitable for cattle, goats or a dairy-heifer project. A watering dam is on the property. Close to Isinya town and the Kajiado–Nairobi highway.', deed: 'KAJIADO/KITENGELA/4410', show_deed: 1, palette: [170, 160, 80] },
  { owner: 'otieno', title: 'Quarter-acre residential plot for sale, Kisumu', land_type: 'residential', size: 0.25, size_unit: 'acres', listing_types: 'sale', price: 1800000, currency: 'KES', price_unit: 'total', negotiable: 1, country: 'Kenya', region: 'Kisumu County', town: 'Riat', lat: -0.0700, lng: 34.8200, permitted: ['building'], prohibited: ['dumping', 'mining'], features: { water_source: 'County water line', road_access: 'Murram road, 50m', electricity: true, soil_type: 'Murram', fenced: false }, desc: 'Ready title, quiet residential area on Riat Hills with views of Lake Victoria. Power and water are at the boundary. Ideal for a family home or rental units.', deed: 'KISUMU/KOGONY/2215', show_deed: 0, palette: [140, 120, 80] },
  { owner: 'wanjiru', title: '1 hectare commercial site on the Thika Road corridor', land_type: 'commercial', size: 1, size_unit: 'hectares', listing_types: 'lease,sale', price: 350000, currency: 'KES', price_unit: 'month', negotiable: 1, duration_min: 3, duration_max: 15, duration_unit: 'years', country: 'Kenya', region: 'Kiambu County', town: 'Ruiru', lat: -1.1500, lng: 36.9600, permitted: ['commercial use', 'storage', 'building'], prohibited: ['dumping', 'quarrying'], features: { water_source: 'Borehole', road_access: 'Tarmac, near the Thika superhighway', electricity: true, soil_type: 'Murram', fenced: true }, desc: 'Flat, fenced site 800m off the Thika superhighway. Good for a warehouse, showroom, petrol station or logistics yard. Three-phase power is available. Long lease preferred; sale also considered.', deed: 'RUIRU/RUIRU EAST/9031', show_deed: 1, palette: [150, 140, 110] },
  { owner: 'otieno', title: '10 acres of avocado land for partnership, Murang\'a', land_type: 'agricultural', size: 10, size_unit: 'acres', listing_types: 'partnership', price: 0, currency: 'KES', price_unit: 'year', negotiable: 1, duration_min: 5, duration_max: 15, duration_unit: 'years', country: 'Kenya', region: 'Murang\'a County', town: 'Kandara', lat: -0.9000, lng: 37.0000, permitted: ['crop farming', 'agroforestry', 'beekeeping'], prohibited: ['felling trees', 'sub-leasing', 'mining'], features: { water_source: 'Stream along the boundary', road_access: 'Murram road', electricity: false, soil_type: 'Deep red loam', fenced: false }, desc: 'Highland land at 1,600m, well suited to Hass avocado or macadamia. Seeking a partner to provide seedlings, irrigation and management in exchange for a 50/50 profit share over a long term.', deed: 'LOC.4/KANDARA/1876', show_deed: 0, palette: [60, 120, 50] },
  { owner: 'mugisha', title: '3 hectares of farmland near Musanze', land_type: 'agricultural', size: 3, size_unit: 'hectares', listing_types: 'lease', price: 900000, currency: 'RWF', price_unit: 'year', negotiable: 1, duration_min: 1, duration_max: 5, duration_unit: 'years', country: 'Rwanda', region: 'Northern Province', town: 'Musanze', lat: -1.4990, lng: 29.6340, permitted: ['crop farming', 'livestock'], prohibited: ['mining', 'sub-leasing', 'chemical spraying'], features: { water_source: 'Spring + rainwater harvesting', road_access: 'Feeder road', electricity: true, soil_type: 'Volcanic, very fertile', fenced: false }, desc: 'Rich volcanic soil at the foot of the Virunga mountains, excellent for Irish potatoes, wheat and pyrethrum. Terraced, with a natural spring. Available from the next season.', deed: 'UPI-4/03/06/02/1144', show_deed: 1, palette: [90, 110, 50] },
  { owner: 'mugisha', title: '600 sqm residential plot in Kigali, Kicukiro', land_type: 'residential', size: 600, size_unit: 'sqm', listing_types: 'sale', price: 45000000, currency: 'RWF', price_unit: 'total', negotiable: 0, country: 'Rwanda', region: 'Kigali City', town: 'Kicukiro', lat: -1.9900, lng: 30.1000, permitted: ['building'], prohibited: ['dumping'], features: { water_source: 'WASAC water line', road_access: 'Paved road', electricity: true, soil_type: 'Clay', fenced: true }, desc: 'Serviced plot in a planned residential zone with an approved master plan for R1 housing. Water, power and paved access are in place. The title is ready for transfer through Irembo.', deed: 'UPI-1/03/10/04/5521', show_deed: 1, palette: [150, 115, 90] },
  { owner: 'mugisha', title: '5 ha mixed-use land on the Nyabarongo, Bugesera', land_type: 'mixed', size: 5, size_unit: 'hectares', listing_types: 'lease,partnership', price: 1500000, currency: 'RWF', price_unit: 'year', negotiable: 1, duration_min: 2, duration_max: 10, duration_unit: 'years', country: 'Rwanda', region: 'Eastern Province', town: 'Nyamata', lat: -2.1500, lng: 30.0900, permitted: ['crop farming', 'livestock', 'poultry', 'solar farm'], prohibited: ['mining', 'dumping', 'hunting'], features: { water_source: 'Nyabarongo river frontage', road_access: 'Murram road', electricity: true, soil_type: 'Alluvial', fenced: false, irrigation: false }, desc: 'Flat land near the new Bugesera airport with river frontage. Suits rice, vegetables, a poultry unit or a small solar project. Open to a profit-sharing partnership with an agribusiness.', deed: 'UPI-5/07/02/01/0332', show_deed: 0, palette: [110, 140, 70] },
  { owner: 'otieno', title: '50 acres of ranch land, Laikipia', land_type: 'grazing', size: 50, size_unit: 'acres', listing_types: 'lease,sale', price: 350000, currency: 'KES', price_unit: 'year', negotiable: 1, duration_min: 2, duration_max: 20, duration_unit: 'years', country: 'Kenya', region: 'Laikipia County', town: 'Nanyuki', lat: 0.0167, lng: 37.0700, permitted: ['livestock', 'beekeeping', 'agroforestry'], prohibited: ['hunting', 'felling trees', 'quarrying', 'sub-leasing'], features: { water_source: 'Borehole + troughs', road_access: '6km from the Nanyuki tarmac', electricity: false, soil_type: 'Black cotton / loam', fenced: true, borehole: true }, desc: 'Fully fenced ranch with views of Mt Kenya. A borehole with solar pump feeds three troughs. Good for cattle, sheep or camels. Wildlife-friendly fencing.', deed: 'LAIKIPIA/NANYUKI/7765', show_deed: 1, palette: [160, 150, 90] },
];

async function main() {
  await Promise.all([db.ready, storage.ready]);

  // ---- reset ----
  await Promise.all([storage.clear('public'), storage.clear('private')]);
  for (const t of ['notifications', 'reports', 'messages', 'offers', 'threads', 'saves', 'photos', 'listings', 'users']) {
    await db.run(`DELETE FROM ${t}`);
  }

  const hash = (p) => bcrypt.hashSync(p, 10);
  const addUser = (name, email, password, role, phone) =>
    db.insert('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)', name, email, phone, hash(password), role);

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@landlink.local';
  const adminPass = process.env.ADMIN_PASSWORD || 'Admin#12345';
  await addUser('LandLink Admin', adminEmail, adminPass, 'admin', null);
  const ids = {
    wanjiru: await addUser('Wanjiru Kamau', 'wanjiru@example.com', 'Lender#123', 'lender', '+254712000111'),
    mugisha: await addUser('Jean Mugisha', 'mugisha@example.com', 'Lender#123', 'lender', '+250788000222'),
    otieno: await addUser('Otieno Ouma', 'otieno@example.com', 'Lender#123', 'lender', '+254722000333'),
  };
  await addUser('Amina Hassan', 'customer@example.com', 'Customer#123', 'customer', '+254733000444');
  const owners = Object.fromEntries((await db.all('SELECT id, phone, email FROM users')).map((u) => [u.id, u]));

  for (const [i, l] of L.entries()) {
    const ownerId = ids[l.owner];
    const o = owners[ownerId];
    const created = new Date(Date.now() - (L.length - i) * 86400000 * 2).toISOString().replace('T', ' ').slice(0, 19);
    const row = {
      owner_id: ownerId, title: l.title, description: l.desc, land_type: l.land_type, size: l.size, size_unit: l.size_unit,
      size_acres: +(l.size * SIZE_UNITS[l.size_unit]).toFixed(4), listing_types: l.listing_types, price: l.price, currency: l.currency,
      price_unit: l.price_unit, negotiable: l.negotiable, duration_min: l.duration_min ?? null, duration_max: l.duration_max ?? null,
      duration_unit: l.duration_unit ?? null, available_from: new Date().toISOString().slice(0, 10), country: l.country, region: l.region,
      town: l.town, lat: l.lat, lng: l.lng, permitted_uses: JSON.stringify(l.permitted), prohibited_uses: JSON.stringify(l.prohibited),
      features: JSON.stringify(l.features), contact_phone: o.phone, contact_whatsapp: o.phone, contact_email: o.email,
      deed_number: l.deed.toUpperCase().replace(/s+/g, ''),
      deed_file: await writeFile('private', '.pdf', samplePdf(`TITLE DEED ${l.deed}`), 'application/pdf'),
      id_file: await writeFile('private', '.pdf', samplePdf('NATIONAL ID - DEMO'), 'application/pdf'),
      show_deed: l.show_deed, status: 'verified', created_at: created, updated_at: created,
    };
    const cols = Object.keys(row);
    const id = await db.insert(`INSERT INTO listings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]));
    for (let p = 0; p < 3; p++) {
      const shade = l.palette.map((c) => c * (0.85 + p * 0.12));
      const name = await writeFile('public', '.png', landscapePng(i * 7 + p, shade), 'image/png');
      await db.run('INSERT INTO photos (listing_id, filename, position) VALUES (?, ?, ?)', id, name, p);
    }
    process.stdout.write('.');
  }

  console.log(`
Seeded ${L.length} verified listings (db: ${db.kind}, storage: ${storage.kind}).`);
  console.log('Accounts:');
  console.log(`  admin     ${adminEmail} / ${adminPass}`);
  console.log('  lender    wanjiru@example.com / Lender#123  (also mugisha@, otieno@)');
  console.log('  customer  customer@example.com / Customer#123');
  await db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
