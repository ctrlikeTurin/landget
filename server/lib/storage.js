// File storage with two backends:
//   - Supabase Storage when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set (production)
//   - local disk under uploads/ otherwise (dev and tests)
// Two buckets: "public" for listing photos, "private" for title deeds and IDs.
// Private objects are only ever streamed through the authenticated /api/files route.
const path = require('path');
const fs = require('fs');

const SUPA = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKETS = {
  public: process.env.SUPABASE_PUBLIC_BUCKET || 'landlink-public',
  private: process.env.SUPABASE_PRIVATE_BUCKET || 'landlink-private',
};
const safe = (name) => path.basename(String(name)); // object names are random hex; never trust paths

function supabase() {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY };
  const call = async (method, url, { body, headers = {}, ok = [200] } = {}) => {
    const r = await fetch(`${base}/storage/v1${url}`, { method, headers: { ...auth, ...headers }, body });
    if (!ok.includes(r.status)) throw new Error(`Supabase storage ${method} ${url}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r;
  };
  return {
    kind: 'supabase',
    publicOrigin: new URL(base).origin,
    async init() {
      for (const [kind, id] of Object.entries(BUCKETS)) {
        // 409/400 = bucket already exists.
        await call('POST', '/bucket', {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name: id, public: kind === 'public', file_size_limit: kind === 'public' ? 5 * 1024 * 1024 : 10 * 1024 * 1024 }),
          ok: [200, 400, 409],
        });
      }
    },
    async put(bucket, name, buffer, contentType) {
      await call('POST', `/object/${BUCKETS[bucket]}/${safe(name)}`, {
        headers: { 'Content-Type': contentType, 'x-upsert': 'true', 'Cache-Control': bucket === 'public' ? 'max-age=604800' : 'no-store' },
        body: buffer,
      });
    },
    async get(bucket, name) {
      const r = await fetch(`${base}/storage/v1/object/${BUCKETS[bucket]}/${safe(name)}`, { headers: auth });
      if (r.status === 404 || r.status === 400) return null;
      if (!r.ok) throw new Error(`Supabase storage get: ${r.status}`);
      return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || 'application/octet-stream' };
    },
    async remove(bucket, name) {
      if (!name) return;
      await call('DELETE', `/object/${BUCKETS[bucket]}`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: [safe(name)] }), ok: [200, 404],
      }).catch((e) => console.warn(e.message));
    },
    async clear(bucket) {
      const r = await call('POST', `/object/list/${BUCKETS[bucket]}`, {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 1000 }),
      });
      const names = (await r.json()).map((o) => o.name).filter((n) => n && !n.startsWith('.'));
      if (names.length) {
        await call('DELETE', `/object/${BUCKETS[bucket]}`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: names }) });
      }
    },
    publicUrl: (name) => `${base}/storage/v1/object/public/${BUCKETS.public}/${safe(name)}`,
  };
}

function local() {
  const root = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
  const dir = { public: path.join(root, 'public'), private: path.join(root, 'private') };
  const TYPES = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };
  return {
    kind: 'local',
    publicOrigin: null,
    publicDir: dir.public,
    async init() { for (const d of Object.values(dir)) fs.mkdirSync(d, { recursive: true }); },
    async put(bucket, name, buffer) { fs.writeFileSync(path.join(dir[bucket], safe(name)), buffer); },
    async get(bucket, name) {
      const f = path.join(dir[bucket], safe(name));
      if (!fs.existsSync(f)) return null;
      return { buffer: fs.readFileSync(f), contentType: TYPES[path.extname(f)] || 'application/octet-stream' };
    },
    async remove(bucket, name) { if (name) fs.rmSync(path.join(dir[bucket], safe(name)), { force: true }); },
    async clear(bucket) { for (const f of fs.readdirSync(dir[bucket])) if (f !== '.gitkeep') fs.rmSync(path.join(dir[bucket], f), { force: true }); },
    publicUrl: (name) => `/uploads/${safe(name)}`,
  };
}

const storage = SUPA ? supabase() : local();
storage.ready = storage.init();
module.exports = storage;
