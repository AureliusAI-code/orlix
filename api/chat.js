// Vercel Serverless Function — /api/chat
// Routes to the right provider based on model name:
//   grok-*        → api.x.ai          (XAI_API_KEY env var)
//   gpt-* / o1/o3/o4 → api.openai.com (OPENAI_API_KEY env var)
//   others        → api.bankr.bot     (x-api-key header from user settings)
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
  const isGrok   = model.startsWith('grok');
  const isOpenAI = model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('codex') || model === 'gpt-mini' || model === 'gpt-nano';

  // ── Helper: call an OpenAI-compatible endpoint ────────────────────────────
  async function callOpenAICompat(url, bearerKey) {
    const body = {
      model:      bodyObj.model,
      messages:   bodyObj.messages || [],
      max_tokens: bodyObj.max_tokens || 2048,
    };
    if (bodyObj.temperature !== undefined) body.temperature = bodyObj.temperature;

    const upstream = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + bearerKey },
      body:    JSON.stringify(body),
    });
    return upstream;
  }

  // ── Grok / xAI ───────────────────────────────────────────────────────────
  if (isGrok) {
    const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY || process.env.GROK_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'XAI_API_KEY not set in Vercel Environment Variables.' } });
    try {
      const r = await callOpenAICompat('https://api.x.ai/v1/chat/completions', key);
      const text = await r.text();
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(text);
    } catch (e) { return res.status(502).json({ error: { message: 'xAI error: ' + e.message } }); }
  }

  // ── OpenAI ────────────────────────────────────────────────────────────────
  if (isOpenAI) {
    const key = process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY || process.env.OPENAI_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'OPENAI_API_KEY not set in Vercel Environment Variables.' } });
    try {
      const r = await callOpenAICompat('https://api.openai.com/v1/chat/completions', key);
      const text = await r.text();
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(text);
    } catch (e) { return res.status(502).json({ error: { message: 'OpenAI error: ' + e.message } }); }
  }

  // ── bankr.bot (all other models — Anthropic, Google, etc.) ───────────────
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
          hint: 'Your bankr.bot API key may be invalid or expired.'
        }
      });
    }
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Proxy error: ' + e.message } });
  }
};
