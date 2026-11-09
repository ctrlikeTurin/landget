// Pings the Render service every 10 minutes so the free instance never sleeps.
// Deploy: npx wrangler deploy --config cloudflare/keepalive/wrangler.toml
export default {
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(fetch('https://landlink-tzt7.onrender.com/api/health').then((r) => console.log('ping', r.status)));
  },
};
