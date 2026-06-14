// Vercel Serverless Function — /api/chat
// Routes model requests to the right provider:
//   grok-*  → api.x.ai  (uses XAI_API_KEY env var — no user key needed)
//   others  → api.bankr.bot (uses x-api-key header from user settings)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('x-orlix-proxy', '1');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const bodyObj = typeof req.body === 'object' && req.body !== null
    ? req.body
    : JSON.parse(req.body || '{}');

  const model = (bodyObj.model || '').toLowerCase();
  const isGrok = model.startsWith('grok');

  // ── Grok / xAI path ──────────────────────────────────────────────────────
  if (isGrok) {
    const xaiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY || process.env.GROK_KEY || '';
    if (!xaiKey) {
      return res.status(401).json({
        error: { message: 'XAI_API_KEY not set in Vercel environment variables. Add it in Vercel → Settings → Environment Variables.' }
      });
    }

    // xAI uses OpenAI-compatible /v1/chat/completions
    const xaiBody = {
      model:      bodyObj.model,
      messages:   bodyObj.messages || [],
      max_tokens: bodyObj.max_tokens || 2048,
    };
    if (bodyObj.temperature !== undefined) xaiBody.temperature = bodyObj.temperature;

    try {
      const upstream = await fetch('https://api.x.ai/v1/chat/completions', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': 'Bearer ' + xaiKey,
        },
        body: JSON.stringify(xaiBody),
      });
      const text = await upstream.text();
      return res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
    } catch (e) {
      return res.status(502).json({ error: { message: 'xAI error: ' + e.message } });
    }
  }

  // ── bankr.bot path (all other models) ────────────────────────────────────
  const apiKey = req.headers['x-api-key'] || '';
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

    let isJson = true;
    try { JSON.parse(text); } catch { isJson = false; }

    if (!isJson) {
      return res.status(upstream.status).json({
        error: {
          message: `bankr.bot error (HTTP ${upstream.status}): ${text.replace(/<[^>]+>/g, '').trim().slice(0, 200)}`,
          hint: 'Your bankr.bot API key may be invalid or expired. Get a new one at bankr.bot.'
        }
      });
    }
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Proxy error: ' + e.message } });
  }
};
