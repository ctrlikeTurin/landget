const crypto = require('crypto');
const multer = require('multer');
const storage = require('./storage');

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const DOC_TYPES = { ...IMAGE_TYPES, 'application/pdf': '.pdf' };
const MB = 1024 * 1024;

// Magic-byte check so a renamed executable can't pass as an image or PDF.
function sniff(file) {
  const b = file.buffer.subarray(0, 12);
  const checks = {
    'image/jpeg': () => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/png': () => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/webp': () => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
    'application/pdf': () => b.subarray(0, 5).toString() === '%PDF-',
  };
  return !!(checks[file.mimetype] && checks[file.mimetype]());
}

// Held in memory (max 12 files x 10MB) until validated, then written to storage.
const listingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * MB, files: 12, fields: 60 },
  fileFilter: (_req, file, cb) => {
    if (!['photos', 'deed', 'id_doc'].includes(file.fieldname)) return cb(new Error('Unexpected file field.'));
    const allowed = file.fieldname === 'photos' ? IMAGE_TYPES : DOC_TYPES;
    if (!allowed[file.mimetype]) return cb(new Error(file.fieldname === 'photos' ? 'Photos must be JPG, PNG or WebP.' : 'Documents must be PDF, JPG, PNG or WebP.'));
    cb(null, true);
  },
}).fields([{ name: 'photos', maxCount: 10 }, { name: 'deed', maxCount: 1 }, { name: 'id_doc', maxCount: 1 }]);

const bucketFor = (f) => (f.fieldname === 'photos' ? 'public' : 'private');

// Validates sizes and content; files get a random `filename` but are NOT stored yet.
// Routes call storeFiles() once the rest of the input is valid.
function handleListingUpload(req, res, next) {
  listingUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files must be 10MB or smaller (photos 5MB).' : err.message });
    for (const f of Object.values(req.files || {}).flat()) {
      if (f.fieldname === 'photos' && f.size > 5 * MB) return res.status(400).json({ error: 'Each photo must be 5MB or smaller.' });
      if (!sniff(f)) return res.status(400).json({ error: 'One of the files is not a valid image or PDF.' });
      // The user-supplied filename is never used.
      f.filename = crypto.randomBytes(16).toString('hex') + (f.fieldname === 'photos' ? IMAGE_TYPES : DOC_TYPES)[f.mimetype];
    }
    next();
  });
}

async function storeFiles(files) {
  const all = Object.values(files || {}).flat();
  await Promise.all(all.map((f) => storage.put(bucketFor(f), f.filename, f.buffer, f.mimetype)));
}
async function discardFiles(files) {
  await Promise.all(Object.values(files || {}).flat().map((f) => storage.remove(bucketFor(f), f.filename)));
}

module.exports = { handleListingUpload, storeFiles, discardFiles };
