# LandLink

A marketplace where landowners list land for **lease, sale or partnership** and customers search, view and negotiate for it. It is built for Kenya and Rwanda and works mobile-first, so it can be wrapped as a mobile app later (Capacitor, or a PWA wrapper).

- **Backend:** Node.js + Express 5, PostgreSQL/Supabase in production or SQLite locally (better-sqlite3), bcryptjs, JWT in an httpOnly cookie, multer, helmet, express-rate-limit
- **Frontend:** plain HTML/CSS/JS single-page app (no build step), Leaflet + OpenStreetMap, Esri World Imagery satellite toggle, marker clustering
- **Assistant:** server-side proxy to OpenRouter (free model), with a rule-based fallback when no key is set

## Quick start

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env      # then set JWT_SECRET (and optionally OPENROUTER_API_KEY)
npm run seed              # resets the DB: admin + 4 users + 10 verified listings
npm start                 # http://localhost:3000
npm test                  # 21 API tests (in-memory DB, temp uploads)
```

Generate a JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Demo accounts (after `npm run seed`)

| Role     | Email                    | Password       |
|----------|--------------------------|----------------|
| Admin    | admin@landlink.local     | Admin#12345 (from `.env`) |
| Lender   | wanjiru@example.com      | Lender#123     |
| Lender   | mugisha@example.com      | Lender#123     |
| Lender   | otieno@example.com       | Lender#123     |
| Customer | customer@example.com     | Customer#123   |

Change `ADMIN_PASSWORD` before deploying. Keep it quoted in `.env`, because `#` starts a comment.

## The AI assistant

Set `OPENROUTER_API_KEY` in `.env` (get a free key at openrouter.ai). `OPENROUTER_MODEL` is a comma-separated fallback list, defaulting to `google/gemma-4-31b-it:free,nvidia/nemotron-3.5-lightning:free`. Free models get retired; check https://openrouter.ai/models?q=free and update the list if the assistant drops to basic mode.

How it works, and why it can't invent listings:
1. The server extracts search intent from the message (land type, size, budget, place, lease/sale/partnership) with the same parser that powers the search bar.
2. It queries the database for **verified** listings only.
3. The model gets those real rows as context and writes a short reply. The listing cards shown under the reply come straight from the database, not from the model's text.
4. Every reply ends with a reminder to inspect the land in person, do an official title search and consult a lawyer. The server appends it if the model leaves it out.

If there's no key, or the model fails or hits a rate limit, a rule-based assistant answers instead. It still searches listings and explains lease vs sale vs partnership, due diligence, and title deed verification (Ardhisasa in Kenya, NLA/Irembo in Rwanda). The browser keeps the chat history in `sessionStorage`. The chat is rate-limited to 20 messages per 5 minutes per user, or per IP for anonymous visitors.

## Security and privacy

- Passwords are hashed with bcrypt. Sessions use a JWT in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production).
- Login and registration are rate-limited to 10 per 15 minutes. All API routes have a general rate limit. Non-GET API calls from other origins are rejected.
- Routes are protected by role (`requireRole`). Only the seed script creates admins; you can't sign up as one.
- Uploads are limited to 5MB per photo and 10MB per document. Files are type-checked by MIME **and** magic bytes, and stored under random filenames (user filenames are never used on disk).
- `uploads/public/` holds listing photos and is served statically.
- `uploads/private/` holds title deeds and IDs. It has **no static route** and is served only by `GET /api/files/:id/(deed|id)`:
  - **ID / passport:** owner and admins only. Everyone else gets a 404.
  - **Title deed:** owner and admins, plus the public **only** if the owner turned on "Show title deed to customers" and the listing is verified.
- Owner contacts are only returned to logged-in users.
- Fraud checks: deed numbers are normalised. Listings that share a deed number are flagged for admins, and a database unique index stops two verified listings from using the same deed number.
- Any edit to a live listing sends it back to verification.
- Helmet sets a strict CSP (no inline scripts).

## API

| Route | Purpose |
|---|---|
| `POST /api/auth/register` · `login` · `logout` · `GET /api/auth/me` | Auth |
| `GET /api/listings?q=&land_type=&listing_type=&price_min=&price_max=&size_min=&size_max=&region=&duration_months=&near_lat=&near_lng=&radius_km=&sort=` | Search verified listings (`q` is parsed as free text) |
| `GET /api/listings/:id` · `POST /api/listings` · `PUT /api/listings/:id` · `DELETE /api/listings/:id` | Detail / create / edit / delete (multipart: `photos[]`, `deed`, `id_doc`) |
| `POST /api/listings/:id/(submit\|pause\|resume\|save\|report)` | Status changes, favourites, fraud reports |
| `GET /api/listings/mine` · `/saved` | Lender dashboard with stats · customer favourites |
| `POST /api/offers` · `POST /api/offers/:id/respond {action: accept\|decline\|counter}` | Negotiation |
| `GET /api/messages/threads` · `/threads/:id` · `POST /api/messages` | Inbox |
| `GET /api/admin/queue` · `POST /api/admin/listings/:id/(approve\|reject)` · `/admin/users` · `/admin/reports` | Admin |
| `POST /api/chat` | Assistant |
| `GET /api/notifications` · `POST /api/notifications/read` | In-app notifications |

## Project layout

```
server/
  app.js            Express app (exported for tests)
  index.js          starts the server
  db.js             schema (portable SQL)
  seed.js           demo data + generated placeholder photos/PDFs
  middleware/auth.js
  lib/              validate, upload, search (free-text parser), notify
  routes/           auth, listings, offers, messages, admin, chat, files, notifications
public/             index.html, app.js, styles.css, i18n.js
tests/api.test.js   node:test + supertest
uploads/public|private
```

## Translations

UI strings live in `public/i18n.js`. Add `sw` (Swahili) and `rw` (Kinyarwanda) objects with the same keys; any missing key falls back to English. The language comes from `localStorage.ll_lang`, so a language picker only needs to set that and reload.

## Deploying for free (Render + Supabase)

The app picks its backends from the environment:

| Setting | Unset (local dev, tests) | Set (production) |
|---|---|---|
| `DATABASE_URL` | SQLite file at `DB_PATH` | Supabase Postgres |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | `./uploads` on disk | Supabase Storage |

Tests always use SQLite and local disk, even if `.env` has Supabase values.

### 1. Supabase (database + file storage)
1. Create a project at supabase.com (free tier, no card). Pick a region near your users, e.g. Frankfurt or Mumbai. Save the database password.
2. Go to **Project Settings → Database → Connection string → Transaction pooler** (port **6543**) and copy the URI. Replace `[YOUR-PASSWORD]` with your password, URL-encoding special characters (`#` → `%23`, `@` → `%40`). This is `DATABASE_URL`. Use the pooler URI, not the "direct" one: Render's free tier only has IPv4, and Supabase's direct host is IPv6-only.
3. Go to **Project Settings → API**: the **Project URL** is `SUPABASE_URL`, and the **service_role** secret is `SUPABASE_SERVICE_ROLE_KEY`. The service role key bypasses all security, so keep it on the server only.
4. Nothing else to configure. On first start the app creates the tables, turns on Row Level Security (which blocks Supabase's public REST API from reading them), and creates two buckets: `landlink-public` for photos and `landlink-private` for deeds and IDs.
5. Seed it once from your machine: put the three values in `.env` and run `npm run seed`. **This wipes all data in that project.**

### 2. Render (web app)
1. In Render, choose **New → Blueprint** and pick this GitHub repo. It reads `render.yaml`: free web service, `npm ci`, `npm start`, and a health check on `/api/health`.
2. Fill in the secret variables it asks for: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `APP_URL` (your `https://….onrender.com` URL), and optionally `OPENROUTER_API_KEY`. `JWT_SECRET` is generated automatically.
3. Deploy. `https://<app>.onrender.com/api/health` should return `{"ok":true,"db":"postgres","storage":"supabase"}`.

Free Render instances sleep after 15 minutes of no traffic, and the first request then takes about 30 to 60 seconds. Your data is safe in Supabase. Free Supabase projects pause after a week of inactivity; you can restore them from the dashboard.

### 3. Cloudflare (optional)
For a custom domain, add the domain to Cloudflare, create a `CNAME` to `<app>.onrender.com`, and add the domain under the Render service's **Settings → Custom Domains**.

### Scaling later
- "Near me" runs in JS over verified listings; with PostGIS it can move into SQL.
- `server/lib/notify.js` is the single hook for adding an email provider.

## Disclaimer

LandLink connects people; it does not process payments or guarantee titles. Users should always visit the land, do an official search, and use a lawyer.
