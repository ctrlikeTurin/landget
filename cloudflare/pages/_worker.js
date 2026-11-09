// Cloudflare Pages front door: serves the app at farm-answer.pages.dev by forwarding
// every request to the Render service. Cookies and bodies pass through unchanged.
// Deploy: npx wrangler pages deploy cloudflare/pages --project-name farm-answer --branch main
const ORIGIN = 'https://landlink-tzt7.onrender.com';
// Only these request headers are forwarded. Render also sits behind Cloudflare, and passing
// Cloudflare's own headers (cdn-loop, cf-*, host) makes its edge answer 502.
const KEEP = ['accept', 'accept-language', 'cache-control', 'content-type', 'cookie', 'if-modified-since', 'if-none-match', 'origin', 'range', 'referer', 'user-agent'];
// While a free Render instance wakes from sleep (~30-60s), its edge answers 502/503 at once.
const WAKING = [502, 503, 504];
const WAKE_DEADLINE_MS = 55000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers();
    for (const h of KEEP) {
      const v = request.headers.get(h);
      if (v !== null) headers.set(h, v);
    }
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    // Bodies can only be sent once, so buffer them to allow retries while Render wakes.
    const body = hasBody ? await request.arrayBuffer() : undefined;
    const send = () => fetch(ORIGIN + url.pathname + url.search, { method: request.method, headers, body, redirect: 'manual' });

    const start = Date.now();
    let res = await send();
    for (let wait = 2000; WAKING.includes(res.status) && Date.now() - start < WAKE_DEADLINE_MS; wait = Math.min(wait * 1.5, 8000)) {
      await sleep(wait);
      res = await send();
    }
    return res;
  },
};
