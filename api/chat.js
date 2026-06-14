// Vercel Serverless Function — /api/chat
// Proxies requests to bankr.bot server-side (no CORS issues)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = req.headers['x-api-key'] || '';
  const bodyObj = typeof req.body === 'object' && req.body !== null
    ? req.body
    : JSON.parse(req.body || '{}');

  if (!apiKey) {
    return res.status(401).json({
      error: { message: 'API key required. Add your bankr.bot API key in Settings → API Key.' }
    });
  }

  try {
    const upstream = await fetch('https://api.bankr.bot/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body:    JSON.stringify(bodyObj),
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
};
