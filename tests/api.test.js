// Integration tests: isolated in-memory DB and temp upload dir.
const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'landlink-test-'));
process.env.JWT_SECRET = 'test-secret';
process.env.OPENROUTER_API_KEY = ''; // force rule-based chat
process.env.DATABASE_URL = ''; // tests always use SQLite + local storage; '' stops dotenv refilling it from .env
process.env.SUPABASE_URL = '';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const app = require('../server/app');
const db = require('../server/db');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%%EOF');

const agent = () => request.agent(app);
async function register(role, email) {
  const a = agent();
  const r = await a.post('/api/auth/register').send({ name: `${role} user`, email, password: 'Passw0rd!', role });
  assert.equal(r.status, 201, r.text);
  return a;
}
function listingForm(req, extra = {}) {
  const fields = {
    title: 'Test farm near Eldoret', description: 'Good maize land', land_type: 'agricultural', size: 4, size_unit: 'acres',
    listing_types: 'lease', price: 40000, currency: 'KES', price_unit: 'year', country: 'Kenya', region: 'Uasin Gishu', town: 'Eldoret',
    lat: 0.52, lng: 35.27, deed_number: 'ELDORET/MUNICIPALITY/42', ...extra,
  };
  for (const [k, v] of Object.entries(fields)) req.field(k, String(v));
  return req.attach('photos', PNG, { filename: 'farm.png', contentType: 'image/png' })
    .attach('deed', PDF, { filename: 'deed.pdf', contentType: 'application/pdf' })
    .attach('id_doc', PDF, { filename: 'my id.pdf', contentType: 'application/pdf' });
}

let admin, lender, customer, listingId;

before(async () => {
  await db.ready;
  await db.run("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'admin@t.test', ?, 'admin')", bcrypt.hashSync('Admin#1234', 4));
  admin = agent();
  await admin.post('/api/auth/login').send({ email: 'admin@t.test', password: 'Admin#1234' }).expect(200);
  lender = await register('lender', 'lender@t.test');
  customer = await register('customer', 'customer@t.test');
});
after(() => fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }));

describe('auth', () => {
  test('rejects weak passwords and duplicate emails', async () => {
    await request(app).post('/api/auth/register').send({ name: 'X Y', email: 'weak@t.test', password: 'short', role: 'customer' }).expect(400);
    await request(app).post('/api/auth/register').send({ name: 'X Y', email: 'lender@t.test', password: 'Passw0rd!', role: 'customer' }).expect(409);
  });
  test('cannot self-register as admin', async () => {
    await request(app).post('/api/auth/register').send({ name: 'Sneaky', email: 'sneak@t.test', password: 'Passw0rd!', role: 'admin' }).expect(400);
  });
  test('wrong password is rejected; cookie is httpOnly', async () => {
    await request(app).post('/api/auth/login').send({ email: 'lender@t.test', password: 'nope' }).expect(401);
    const r = await request(app).post('/api/auth/login').send({ email: 'lender@t.test', password: 'Passw0rd!' }).expect(200);
    assert.match(r.headers['set-cookie'][0], /HttpOnly/i);
    assert.equal(r.body.user.password_hash, undefined);
  });
  test('/me reflects the session', async () => {
    const r = await customer.get('/api/auth/me').expect(200);
    assert.equal(r.body.user.role, 'customer');
    assert.equal((await request(app).get('/api/auth/me')).body.user, null);
  });
});

describe('listing permissions', () => {
  test('customers cannot create listings', async () => {
    await listingForm(customer.post('/api/listings')).expect(403);
  });
  test('lender creates and submits; it is hidden until approved', async () => {
    const r = await listingForm(lender.post('/api/listings'), { submit: 'true' }).expect(201);
    listingId = r.body.listing.id;
    assert.equal(r.body.listing.status, 'pending');
    await customer.get(`/api/listings/${listingId}`).expect(404);
    const s = await request(app).get('/api/listings?q=Eldoret').expect(200);
    assert.equal(s.body.total, 0);
  });
  test('rejects a non-image disguised as a photo', async () => {
    const r = await lender.post('/api/listings').field('title', 'Bad upload test')
      .attach('photos', Buffer.from('MZ not an image'), { filename: 'x.png', contentType: 'image/png' });
    assert.equal(r.status, 400);
  });
  test('only admins can approve', async () => {
    await customer.post(`/api/admin/listings/${listingId}/approve`).expect(403);
    await lender.post(`/api/admin/listings/${listingId}/approve`).expect(403);
    await admin.post(`/api/admin/listings/${listingId}/approve`).expect(200);
  });
  test('customer never sees the private ID document', async () => {
    const r = await customer.get(`/api/listings/${listingId}`).expect(200);
    assert.equal(r.body.listing.id_url, undefined);
    assert.equal(r.body.listing.deed_number, undefined);
    assert.equal(r.body.listing.deed_url, undefined); // show_deed defaults to off
    await customer.get(`/api/files/${listingId}/id`).expect(404);
    await request(app).get(`/api/files/${listingId}/id`).expect(404);
    await customer.get(`/api/files/${listingId}/deed`).expect(404);
  });
  test('owner and admin can open the private documents', async () => {
    await lender.get(`/api/files/${listingId}/id`).expect(200);
    await admin.get(`/api/files/${listingId}/id`).expect(200);
    await admin.get(`/api/files/${listingId}/deed`).expect(200);
  });
  test('uploads/private is not reachable statically', async () => {
    const file = (await db.get('SELECT id_file FROM listings WHERE id = ?', listingId)).id_file;
    await request(app).get(`/uploads/${file}`).expect(404);
    await request(app).get(`/uploads/../private/${file}`).expect(404);
  });
  test('contacts are only shown to logged-in users', async () => {
    assert.equal((await request(app).get(`/api/listings/${listingId}`)).body.listing.contacts, null);
    assert.ok((await customer.get(`/api/listings/${listingId}`)).body.listing.contacts);
  });
  test('another lender cannot edit or delete the listing', async () => {
    const other = await register('lender', 'other@t.test');
    await other.delete(`/api/listings/${listingId}`).expect(403);
    await other.post(`/api/listings/${listingId}/pause`).expect(403);
  });
  test('duplicate deed numbers are flagged and cannot both be verified', async () => {
    const other = agent();
    await other.post('/api/auth/login').send({ email: 'other@t.test', password: 'Passw0rd!' }).expect(200);
    const r = await listingForm(other.post('/api/listings'), { title: 'Copycat farm listing', deed_number: 'eldoret/municipality/42', submit: 'true' }).expect(201);
    assert.equal(r.body.listing.duplicate_deed, true);
    await admin.post(`/api/admin/listings/${r.body.listing.id}/approve`).expect(409);
  });
});

describe('search', () => {
  test('free-text query is parsed into filters', async () => {
    const r = await request(app).get('/api/listings').query({ q: '3 acres farmland near Eldoret under 50k per year' }).expect(200);
    assert.equal(r.body.parsed.land_type, 'agricultural');
    assert.equal(r.body.parsed.price_max, 50000);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.results[0].id, listingId);
  });
  test('filters exclude non-matching listings', async () => {
    assert.equal((await request(app).get('/api/listings').query({ price_max: 1000 })).body.total, 0);
    assert.equal((await request(app).get('/api/listings').query({ land_type: 'residential' })).body.total, 0);
    assert.equal((await request(app).get('/api/listings').query({ listing_type: 'lease', country: 'Kenya' })).body.total, 1);
  });
  test('near-me filter uses distance', async () => {
    const near = await request(app).get('/api/listings').query({ near_lat: 0.5, near_lng: 35.3, radius_km: 20 });
    assert.equal(near.body.total, 1);
    const far = await request(app).get('/api/listings').query({ near_lat: -1.95, near_lng: 30.06, radius_km: 20 });
    assert.equal(far.body.total, 0);
  });
  test('paused listings drop out of search', async () => {
    await lender.post(`/api/listings/${listingId}/pause`).expect(200);
    assert.equal((await request(app).get('/api/listings')).body.total, 0);
    await lender.post(`/api/listings/${listingId}/resume`).expect(200);
  });
});

describe('negotiation + chat', () => {
  test('offer → counter → accept, with notifications', async () => {
    const o = await customer.post('/api/offers').send({ listing_id: listingId, price: 35000, duration: '2 years' }).expect(201);
    const inbox = await lender.get('/api/messages/threads').expect(200);
    assert.equal(inbox.body.results.length, 1);
    await customer.post(`/api/offers/${o.body.offer_id}/respond`).send({ action: 'accept' }).expect(400); // own offer
    await lender.post(`/api/offers/${o.body.offer_id}/respond`).send({ action: 'counter', price: 38000 }).expect(200);
    const t = await customer.get(`/api/messages/threads/${o.body.thread_id}`).expect(200);
    const open = t.body.offers.find((x) => x.status === 'offered');
    await customer.post(`/api/offers/${open.id}/respond`).send({ action: 'accept' }).expect(200);
    const n = await customer.get('/api/notifications').expect(200);
    assert.ok(n.body.results.some((x) => x.kind === 'offer'));
  });
  test('outsiders cannot read a thread', async () => {
    const t = (await lender.get('/api/messages/threads')).body.results[0];
    const other = agent();
    await other.post('/api/auth/login').send({ email: 'other@t.test', password: 'Passw0rd!' });
    await other.get(`/api/messages/threads/${t.id}`).expect(404);
  });
  test('rule-based chatbot returns real listings only, with a reminder', async () => {
    const r = await request(app).post('/api/chat').send({ message: 'I need farmland for lease near Eldoret' }).expect(200);
    assert.equal(r.body.source, 'rules');
    assert.deepEqual(r.body.listings.map((l) => l.id), [listingId]);
    assert.match(r.body.reply, /in person/);
    const k = await request(app).post('/api/chat').send({ message: 'How do I verify a title deed?' }).expect(200);
    assert.equal(k.body.listings.length, 0);
    assert.match(k.body.reply, /Ardhisasa/);
  });
});
