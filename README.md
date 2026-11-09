# LandLink

A marketplace where landowners list land for **lease, sale or partnership** and customers search, view and negotiate for it. It is built for Kenya and Rwanda and works mobile-first, so it can be wrapped as a mobile app later (Capacitor, or a PWA wrapper).

- **Backend:** Node.js + Express 5, SQLite (better-sqlite3), bcryptjs, JWT in an httpOnly cookie, multer, helmet, express-rate-limit
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

Set `OPENROUTER_API_KEY` in `.env` (get a free key at openrouter.ai). `OPENROUTER_MODEL` defaults to `meta-llama/llama-3.3-70b-instruct:free`.

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

## Deploying for free

The app is one Node process with a SQLite file and an uploads folder, so it needs **persistent disk**.

### Render
1. Push the repo to GitHub. `.env`, the DB and `uploads/private` are already git-ignored.
2. In Render, choose **New → Web Service**, then pick the repo.
   - Build command: `npm install`
   - Start command: `npm run seed && npm start` for the first deploy only, then change it to `npm start`
3. Set the environment variables `NODE_ENV=production`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and optionally `OPENROUTER_API_KEY` and `APP_URL=https://<your-app>.onrender.com`.
4. **Persistence:** Render's free instances have an ephemeral disk, so the DB and uploads reset on every deploy or restart. Fine for a demo. For real use, add a Render Disk (paid) mounted at `/var/data`, then set `DB_PATH=/var/data/landlink.db` and `UPLOAD_DIR=/var/data/uploads`.

### Railway
1. Create a **New Project** and deploy from the GitHub repo. It detects Node and runs `npm start`.
2. Add the same variables.
3. Add a **Volume** mounted at `/data` and set `DB_PATH=/data/landlink.db` and `UPLOAD_DIR=/data/uploads`. Volumes persist across deploys.
4. Run the seed once from the Railway shell: `npm run seed`.

### Scaling later
- **PostgreSQL:** the schema uses portable types. Swap `db.js` for `pg`, change `?` placeholders to `$1`, and replace `INTEGER PRIMARY KEY AUTOINCREMENT` with `SERIAL`/`IDENTITY`. With PostGIS, "near me" can move into SQL.
- **Files:** move `uploads/` to S3 or Cloudflare R2. Keep the private bucket private and serve it through the same authenticated route, or with short-lived signed URLs.
- **Email:** `server/lib/notify.js` is the single hook for adding a mail provider.

## Disclaimer

LandLink connects people; it does not process payments or guarantee titles. Users should always visit the land, do an official search, and use a lawyer.
