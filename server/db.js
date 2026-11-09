// SQLite connection + schema. Kept to portable SQL (TEXT/INTEGER/REAL, no SQLite-only
// features beyond AUTOINCREMENT) so it can move to PostgreSQL with minimal changes.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'landlink.db');
if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('lender','customer','admin')),
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  land_type TEXT NOT NULL,
  size REAL NOT NULL,
  size_unit TEXT NOT NULL,
  size_acres REAL NOT NULL,              -- normalised for filtering/sorting
  listing_types TEXT NOT NULL,           -- comma list: lease,sale,partnership
  price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KES',
  price_unit TEXT NOT NULL,              -- month, year, season, total
  negotiable INTEGER NOT NULL DEFAULT 0,
  duration_min REAL,
  duration_max REAL,
  duration_unit TEXT,                    -- months, years
  available_from TEXT,
  country TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  town TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  permitted_uses TEXT NOT NULL DEFAULT '[]',   -- JSON array
  prohibited_uses TEXT NOT NULL DEFAULT '[]',  -- JSON array
  uses_notes TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '{}',         -- JSON object
  contact_phone TEXT, contact_whatsapp TEXT, contact_email TEXT,
  deed_number TEXT,
  deed_file TEXT,                        -- private filename
  id_file TEXT,                          -- private filename, never public
  show_deed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','verified','rejected','paused')),
  reject_reason TEXT,
  duplicate_deed INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
-- Deed numbers must be unique among listings that reached verification.
CREATE UNIQUE INDEX IF NOT EXISTS idx_verified_deed ON listings(deed_number)
  WHERE status = 'verified' AND deed_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS saves (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, listing_id)
);

-- One negotiation thread per (listing, customer).
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (listing_id, customer_id)
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  from_user INTEGER NOT NULL REFERENCES users(id),
  price REAL NOT NULL,
  duration TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','countered','accepted','declined')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  from_user INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  offer_id INTEGER REFERENCES offers(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

module.exports = db;
