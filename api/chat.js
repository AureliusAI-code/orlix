// Vercel Serverless Function — /api/chat
// Proxies requests to bankr.bot server-side (no CORS issues)
// Sets x-orlix-proxy header so the frontend knows this function is deployed
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('x-orlix-proxy', '1'); // sentinel — proves this function is running

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

    // If bankr.bot returns non-JSON (e.g. HTML error page), wrap it as JSON error
    let isJson = true;
    try { JSON.parse(text); } catch { isJson = false; }

    if (!isJson) {
      return res.status(upstream.status).json({
        error: {
          message: `bankr.bot error (HTTP ${upstream.status}): ${text.replace(/<[^>]+>/g,'').trim().slice(0,200)}`,
          hint: upstream.status === 404
            ? 'API endpoint not found. Check your bankr.bot API key is valid and not expired.'
            : upstream.status === 401 || upstream.status === 403
            ? 'Invalid or expired API key. Get a new key at bankr.bot.'
            : 'Unexpected response from bankr.bot.'
        }
      });
    }

    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Proxy error: ' + e.message } });
  }
};
