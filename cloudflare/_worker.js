// Cloudflare Pages front door: serves the app at farm-answer.pages.dev by forwarding
// every request to the Render service. Cookies and bodies pass through unchanged.
// Deploy: npx wrangler pages deploy cloudflare --project-name farm-answer --branch main
const ORIGIN = 'https://landlink-tzt7.onrender.com';
// Only these request headers are forwarded. Render also sits behind Cloudflare, and passing
// Cloudflare's own headers (cdn-loop, cf-*, host) makes its edge answer 502.
const KEEP = ['accept', 'accept-language', 'cache-control', 'content-type', 'cookie', 'if-modified-since', 'if-none-match', 'origin', 'range', 'referer', 'user-agent'];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers();
    for (const h of KEEP) {
      const v = request.headers.get(h);
      if (v !== null) headers.set(h, v);
    }
    // The Origin header stays the pages.dev address; the app trusts it via APP_URL.
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    return fetch(ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    });
  },
};
