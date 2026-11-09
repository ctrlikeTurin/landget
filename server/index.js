const app = require('./app');
const db = require('./db');
const storage = require('./lib/storage');

const port = Number(process.env.PORT) || 3000;

Promise.all([db.ready, storage.ready]).then(() => {
  app.listen(port, () => {
    console.log(`LandLink running on http://localhost:${port} (db: ${db.kind}, storage: ${storage.kind})`);
    console.log(process.env.OPENROUTER_API_KEY ? `AI assistant: ${process.env.OPENROUTER_MODEL}` : 'AI assistant: rule-based (no OPENROUTER_API_KEY set)');
  });
}).catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
