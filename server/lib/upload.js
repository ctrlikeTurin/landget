const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const ROOT = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PRIVATE_DIR = path.join(ROOT, 'private');
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const DOC_TYPES = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };
const MB = 1024 * 1024;

// Filenames on disk are random; the user-supplied name is never used.
const safeName = (mime, types) => crypto.randomBytes(16).toString('hex') + types[mime];

// Magic-byte check so a renamed executable can't pass as an image or PDF.
function sniff(file) {
  const fd = fs.openSync(file.path, 'r');
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  const checks = {
    'image/jpeg': () => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/png': () => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/webp': () => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
    'application/pdf': () => b.subarray(0, 5).toString() === '%PDF-',
  };
  return !!(checks[file.mimetype] && checks[file.mimetype]());
}

// Photos go to the public dir; the deed and ID go to the private dir.
const storage = multer.diskStorage({
  destination: (_req, file, cb) => cb(null, file.fieldname === 'photos' ? PUBLIC_DIR : PRIVATE_DIR),
  filename: (_req, file, cb) => cb(null, safeName(file.mimetype, file.fieldname === 'photos' ? IMAGE_TYPES : DOC_TYPES)),
});
const listingUpload = multer({
  storage,
  limits: { fileSize: 10 * MB, files: 12, fields: 60 },
  fileFilter: (_req, file, cb) => {
    if (!['photos', 'deed', 'id_doc'].includes(file.fieldname)) return cb(new Error('Unexpected file field.'));
    const allowed = file.fieldname === 'photos' ? IMAGE_TYPES : DOC_TYPES;
    if (!allowed[file.mimetype]) return cb(new Error(file.fieldname === 'photos' ? 'Photos must be JPG, PNG or WebP.' : 'Documents must be PDF, JPG, PNG or WebP.'));
    cb(null, true);
  },
}).fields([{ name: 'photos', maxCount: 10 }, { name: 'deed', maxCount: 1 }, { name: 'id_doc', maxCount: 1 }]);

// Wraps multer, then enforces the 5MB photo limit and content sniffing.
function handleListingUpload(req, res, next) {
  listingUpload(req, res, (err) => {
    const all = Object.values(req.files || {}).flat();
    const fail = (msg) => { all.forEach((f) => fs.rmSync(f.path, { force: true })); res.status(400).json({ error: msg }); };
    if (err) return fail(err.code === 'LIMIT_FILE_SIZE' ? 'Files must be 10MB or smaller (photos 5MB).' : err.message);
    for (const f of all) {
      if (f.fieldname === 'photos' && f.size > 5 * MB) return fail('Each photo must be 5MB or smaller.');
      if (!sniff(f)) return fail('One of the files is not a valid image or PDF.');
    }
    next();
  });
}

const removeFile = (dir, name) => { if (name) fs.rmSync(path.join(dir, path.basename(name)), { force: true }); };

module.exports = { handleListingUpload, removeFile, PUBLIC_DIR, PRIVATE_DIR };
