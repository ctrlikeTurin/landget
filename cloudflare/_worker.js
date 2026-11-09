// Cloudflare Pages front door: serves the app at <project>.pages.dev by forwarding
// every request to the Render service. Cookies, headers and bodies pass through unchanged.
// Deploy: npx wrangler pages deploy cloudflare --project-name farm-answer
const ORIGIN = 'https://landlink-tzt7.onrender.com';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = ORIGIN + url.pathname + url.search;
    // The Origin header stays the pages.dev address; the app trusts it via APP_URL.
    return fetch(new Request(target, request), { redirect: 'manual' });
  },
};
