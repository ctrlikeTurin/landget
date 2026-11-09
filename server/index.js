const app = require('./app');

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`LandLink running on http://localhost:${port}`);
  console.log(process.env.OPENROUTER_API_KEY ? `AI assistant: ${process.env.OPENROUTER_MODEL}` : 'AI assistant: rule-based (no OPENROUTER_API_KEY set)');
});
