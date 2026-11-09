// AI assistant. The browser only ever talks to this route; the OpenRouter key stays on the server.
// Flow: extract search intent locally → query the DB → hand the real matches to the model as context.
// Listing cards in the response always come from the DB, so the bot cannot invent listings.
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { parseQuery, search } = require('../lib/search');
const { serialize } = require('./listings');
const v = require('../lib/validate');

const router = express.Router();

// Surfaced on /api/health so a misconfigured key or retired model is visible without server logs.
const status = { lastError: null };

const MODELS = (process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free,nvidia/nemotron-3.5-lightning:free').split(',').map((s) => s.trim()).filter(Boolean);

const DISCLAIMER = 'Always visit the land in person, confirm the title at the land registry, and have a lawyer review any agreement before you pay or sign.';

router.use(rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 20,
  keyGenerator: (req) => (req.user ? `u${req.user.id}` : ipKeyGenerator(req.ip)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'You are sending messages too quickly. Please wait a few minutes.' },
}));

const KNOWLEDGE = [
  {
    match: /(lease|rent).*(vs|versus|or|differ|compare).*(sale|buy|partner)|difference|which is better|lease vs|what is (a )?(lease|partnership)/,
    text: '**Lease**: you pay the owner for the right to use the land for a fixed period; ownership stays with them. It is cheaper up front and suits farming seasons or trial use.\n**Sale**: ownership (the title) transfers to you for a one-off price. Highest cost, but the land is yours and can be developed or used as collateral.\n**Partnership (profit-sharing)**: the owner provides the land and you provide labour, capital or expertise; you split the produce or profit by an agreed ratio. Low cash outlay, but you need a very clear written agreement on costs, shares and exit terms.',
  },
  {
    match: /verify|verification|title deed|fake|genuine|authentic|search (at|the) (land|registry)|ardhisasa|irembo/,
    text: 'To verify a title deed:\n1. Get a copy of the title and the owner\'s ID, and check the names match.\n2. **Kenya**: do an official search on Ardhisasa (ardhisasa.lands.go.ke) or at the county land registry; it shows the registered owner and any charges or cautions.\n3. **Rwanda**: request a land title search through Irembo or the National Land Authority (NLA) using the UPI number.\n4. Hire a licensed surveyor to confirm the beacons on the ground match the map.\n5. Ask neighbours and the local chief or sector office about disputes.',
  },
  {
    match: /before (signing|i sign|paying|i pay)|what (should|to) (i )?check|due diligence|checklist|tips|advice|agreement|contract/,
    text: 'Before signing, check:\n- The title search result matches the seller or lessor and shows no charges, cautions or disputes.\n- A surveyor has confirmed boundaries and size on site.\n- Zoning and permitted use fit your plans (e.g. farming vs building).\n- Water, road access and soil, ideally with a soil test for farming.\n- For a lease: duration, renewal, rent review, who pays rates, sub-letting and exit terms are written down.\n- For a partnership: cost-sharing, profit split, record-keeping and dispute resolution.\n- Pay only through traceable channels (bank or escrow via your lawyer), never cash to an agent.',
  },
];

const SEARCH_HINT = /\b(find|looking|look for|need|want|show|search|available|any|land|plot|acre|acres|hectare|farm|shamba|lease|rent|buy|sale|partnership|near|in)\b/;

function wantsSearch(msg, parsed) {
  // "lease" alone in "what's the difference between lease and sale?" is not a search.
  const strong = ['land_type', 'size_min', 'size_max', 'price_max', 'price_min', 'country'].some((k) => parsed[k] != null);
  if (strong) return true;
  if (KNOWLEDGE.some((k) => k.match.test(msg))) return false;
  return parsed.listing_type != null || (SEARCH_HINT.test(msg) && !!parsed.text);
}

// Every free-text word must match, which is strict. If nothing matches, try each word
// as a place name ("cheap plot Nakuru" → Nakuru), but never drop the place entirely.
async function runSearch(parsed) {
  const r = await search(parsed, { limit: 6 });
  if (r.total || !parsed.text) return r;
  for (const w of parsed.text.split(' ')) {
    const alt = await search({ ...parsed, text: undefined, region: w }, { limit: 6 });
    if (alt.total) return { ...alt, relaxed: true };
  }
  return r;
}

const describe = (l) => `#${l.id} "${l.title}": ${l.land_type}, ${l.size} ${l.size_unit}, ${l.listing_types.replace(/,/g, '/')}, ${l.currency} ${l.price.toLocaleString('en-US')} per ${l.price_unit}${l.negotiable ? ' (negotiable)' : ''}, in ${[l.town, l.region, l.country].filter(Boolean).join(', ')}`;

function ruleBased(msg, results, searched, relaxed) {
  const parts = [];
  const k = KNOWLEDGE.find((x) => x.match.test(msg));
  if (k) parts.push(k.text);
  if (searched) {
    if (results.length) parts.push(`${relaxed ? 'I couldn\'t find an exact match, but these' : 'These'} verified listings ${relaxed ? 'are close' : 'match'}:`);
    else parts.push('I couldn\'t find any verified listings matching that. Try a wider budget, a different region or fewer filters, or check back later.');
  }
  if (!parts.length) {
    parts.push('I can help you find land. Describe what you need, e.g. "5 acres farmland for lease near Nakuru under 60k per year". I can also explain **lease vs sale vs partnership**, **what to check before signing**, and **how to verify a title deed**.');
  }
  return parts.join('\n\n');
}

async function askModel(history, msg, results, searched, relaxed) {
  const context = searched
    ? (results.length
      ? `Database search ${relaxed ? '(relaxed, no exact match)' : ''} returned these verified listings. These are the ONLY listings that exist for this query:\n${results.map(describe).join('\n')}`
      : 'Database search returned NO matching listings. Do not suggest or describe any specific listing.')
    : 'No database search was run for this message.';
  const system = [
    'You are the LandLink assistant, helping people in Kenya and Rwanda find land to lease, buy or farm in partnership.',
    'Rules: Only mention listings that appear in the DATABASE CONTEXT; never invent listings, prices, owners or locations.',
    'The app shows the matching listings as clickable cards under your reply, so summarise them briefly and refer to them by title.',
    'You may explain lease vs sale vs partnership, due diligence before signing, and how to verify a title deed (Kenya: Ardhisasa / county land registry official search; Rwanda: NLA / Irembo title search with the UPI).',
    'LandLink does not process payments. Be concise (under 150 words), friendly and practical. Use plain text with short bullet points if helpful.',
    `End every reply by reminding the user: "${DISCLAIMER}"`,
    `DATABASE CONTEXT:\n${context}`,
  ].join('\n');

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': (process.env.APP_URL || 'http://localhost:3000').split(',')[0].trim(),
      'X-Title': 'LandLink',
    },
    body: JSON.stringify({
      // A comma list becomes OpenRouter's fallback chain: if the first model is busy or retired, it tries the next.
      models: MODELS,
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: msg }],
      temperature: 0.3,
      // Current free models reason before answering; keep that short and out of the reply,
      // or the token budget is spent thinking and the answer comes back empty.
      max_tokens: 1500,
      reasoning: { effort: 'low', exclude: true },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('Empty model response');
  return text.trim();
}

router.post('/', async (req, res) => {
  const msg = v.str(req.body.message, 'Message', { min: 1, max: 1000, required: true });
  // History lives in the browser session; accept only well-formed recent turns.
  const history = (Array.isArray(req.body.history) ? req.body.history : [])
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

  const parsed = parseQuery(msg);
  const searched = wantsSearch(msg.toLowerCase(), parsed);
  const found = searched ? await runSearch(parsed) : { rows: [] };
  const results = found.rows;

  let reply; let source = 'rules';
  if (process.env.OPENROUTER_API_KEY) {
    try {
      reply = await askModel(history, msg, results, searched, found.relaxed);
      source = 'ai';
      status.lastError = null;
    } catch (e) {
      console.warn('[chat] model failed, using rule-based reply:', e.message);
      status.lastError = { at: new Date().toISOString(), message: e.message.slice(0, 200) };
    }
  }
  if (!reply) reply = ruleBased(msg.toLowerCase(), results, searched, found.relaxed);
  if (!reply.includes('in person')) reply += `\n\n_${DISCLAIMER}_`;

  res.json({ reply, source, listings: results.map((r) => serialize(r, req.user)) });
});

module.exports = router;
module.exports.aiStatus = () => ({
  ai: process.env.OPENROUTER_API_KEY ? 'configured' : 'off',
  models: MODELS,
  ai_last_error: status.lastError,
});
