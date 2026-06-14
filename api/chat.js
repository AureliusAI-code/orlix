// Vercel Serverless Function — /api/chat
// Routes to the right provider based on model name:
//   claude-*          → api.anthropic.com   (ANTHROPIC_API_KEY env var)
//   grok-*            → api.x.ai            (XAI_API_KEY env var)
//   gpt-* / o1/o3/o4  → api.openai.com      (OPENAI_API_KEY env var)
//   others            → api.bankr.bot        (x-api-key header from user settings)
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('x-orlix-proxy', '1');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const bodyObj = typeof req.body === 'object' && req.body !== null
    ? req.body : JSON.parse(req.body || '{}');

  const model       = (bodyObj.model || '').toLowerCase();
  const isClaude    = model.startsWith('claude');
  const isGrok      = model.startsWith('grok');
  const isOpenAI    = model.startsWith('gpt-') || /^o[134]/.test(model);

  // helper: call OpenAI-compatible endpoint with Bearer key
  async function callCompat(url, key) {
    const body = { model: bodyObj.model, messages: bodyObj.messages || [], max_tokens: bodyObj.max_tokens || 2048 };
    if (bodyObj.temperature != null) body.temperature = bodyObj.temperature;
    return fetch(url, { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+key}, body: JSON.stringify(body) });
  }

  // ── Anthropic / Claude ────────────────────────────────────────────────────
  if (isClaude) {
    const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.ANT_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'ANTHROPIC_API_KEY not set in Vercel Environment Variables. Add it and redeploy.' } });
    try {
      const body = {
        model:      bodyObj.model,
        messages:   bodyObj.messages || [],
        max_tokens: bodyObj.max_tokens || 2048,
      };
      if (bodyObj.system)      body.system      = bodyObj.system;
      if (bodyObj.temperature) body.temperature = bodyObj.temperature;
      // Strip system role from messages array (Anthropic uses top-level system param)
      body.messages = body.messages.filter(m => m.role !== 'system');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) {
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch {}
        return res.status(r.status).json({ error: { message: 'Anthropic: ' + msg } });
      }
      return res.status(r.status).setHeader('Content-Type','application/json').send(text);
    } catch(e) { return res.status(502).json({ error:{ message:'Anthropic error: '+e.message } }); }
  }

  // ── Grok / xAI ────────────────────────────────────────────────────────────
  if (isGrok) {
    const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'XAI_API_KEY not set in Vercel Environment Variables.' } });
    try {
      const r = await callCompat('https://api.x.ai/v1/chat/completions', key);
      return res.status(r.status).setHeader('Content-Type','application/json').send(await r.text());
    } catch(e) { return res.status(502).json({ error:{ message:'xAI error: '+e.message } }); }
  }

  // ── OpenAI ────────────────────────────────────────────────────────────────
  if (isOpenAI) {
    const key = process.env.OPENAI_API_KEY || process.env.OPEN_AI_API_KEY || process.env.OPENAI_KEY || process.env.OPEN_AI_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'OpenAI API key not found. Add OPENAI_API_KEY in Vercel → Settings → Environment Variables, then redeploy.' } });
    try {
      const r = await callCompat('https://api.openai.com/v1/chat/completions', key);
      const text = await r.text();
      if (!r.ok) {
        // Return OpenAI's own error message so user can see what's wrong
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch {}
        return res.status(r.status).json({ error: { message: 'OpenAI: ' + msg } });
      }
      return res.status(r.status).setHeader('Content-Type','application/json').send(text);
    } catch(e) { return res.status(502).json({ error:{ message:'OpenAI error: '+e.message } }); }
  }

  const apiKey = req.headers['x-api-key'] || '';

  // ── x402.bankr.bot (pay-per-use, $0.01 USDC) — when no user API key ──────
  if (!apiKey) {
    const privKey = process.env.BANKR_PRIVATE_KEY || '';
    if (!privKey) {
      return res.status(401).json({
        error: { message: 'No API key. Add your bankr.bot key in Settings, or set BANKR_PRIVATE_KEY in Vercel for $0.01 USDC/request mode.' }
      });
    }

    // Convert Anthropic messages format → simple prompt string for x402
    const messages = bodyObj.messages || [];
    const prompt = messages.map(m => {
      const c = Array.isArray(m.content) ? m.content.map(b=>b.text||'').join('') : (m.content||'');
      return `${m.role}: ${c}`;
    }).join('\n\n');
    const x402Model = bodyObj.model || 'gpt-4o-mini';

    // Step 1 — initial request (expect 402)
    let r1;
    try {
      r1 = await fetch('https://x402.bankr.bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
    } catch(e) { return res.status(502).json({ error:{ message:'x402 fetch error: '+e.message } }); }

    if (r1.status !== 402) {
      // Already got a response (maybe dev/free tier)
      const text = await r1.text();
      try {
        const data = JSON.parse(text);
        const reply = data.response || data.content || data.text || data.choices?.[0]?.message?.content || text;
        return res.json({ content:[{ type:'text', text: String(reply) }], usage: data.usage||{} });
      } catch { return res.status(r1.status).json({ error:{ message: text.slice(0,200) } }); }
    }

    // Step 2 — parse payment details from 402
    let paymentDetails;
    try { paymentDetails = await r1.json(); } catch { paymentDetails = {}; }

    // Build x402-payment header (nonce-signed with private key for bankr.bot)
    // bankr.bot uses a simple HMAC-based payment proof when SDK is not available
    const nonce     = paymentDetails.nonce || crypto.randomUUID();
    const timestamp = Date.now();
    const payload   = JSON.stringify({ nonce, timestamp, model: x402Model, amount: '0.01', currency: 'USDC' });
    const sig       = crypto.createHmac('sha256', privKey).update(payload).digest('hex');
    const paymentHeader = Buffer.from(JSON.stringify({ payload, sig, version:'1' })).toString('base64');

    // Step 3 — retry with payment header
    let r2;
    try {
      r2 = await fetch('https://x402.bankr.bot', {
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'x402-payment':   paymentHeader,
        },
        body: JSON.stringify({ prompt }),
      });
    } catch(e) { return res.status(502).json({ error:{ message:'x402 payment retry error: '+e.message } }); }

    const text2 = await r2.text();
    if (!r2.ok) return res.status(r2.status).json({ error:{ message:`x402 payment failed (${r2.status}): ${text2.slice(0,200)}` } });

    try {
      const data = JSON.parse(text2);
      const reply = data.response || data.content || data.text || data.choices?.[0]?.message?.content || text2;
      return res.json({ content:[{ type:'text', text: String(reply) }], usage: data.usage||{} });
    } catch { return res.json({ content:[{ type:'text', text: text2 }], usage:{} }); }
  }

  // ── api.bankr.bot (user API key, all other models) ────────────────────────
  // Try both endpoints: /v1/messages (Anthropic) then /v1/chat/completions (OpenAI)
  const bankrHeaders = { 'Content-Type': 'application/json', 'x-api-key': apiKey };

  async function tryBankr(path) {
    const r = await fetch('https://api.bankr.bot' + path, {
      method: 'POST', headers: bankrHeaders, body: JSON.stringify(bodyObj),
    });
    const text = await r.text();
    return { status: r.status, text };
  }

  try {
    let { status, text } = await tryBankr('/v1/messages');

    // If /v1/messages returns 404, bankr.bot may have changed to OpenAI-compatible endpoint
    if (status === 404) {
      const r2 = await tryBankr('/v1/chat/completions');
      if (r2.status !== 404) { status = r2.status; text = r2.text; }
    }

    let isJson = true;
    try { JSON.parse(text); } catch { isJson = false; }

    if (!isJson || status === 404) {
      return res.status(status).json({
        error: {
          message: `bankr.bot error (HTTP ${status}): ${text.replace(/<[^>]+>/g,'').trim().slice(0,300)}`,
          hint: status === 404
            ? 'bankr.bot API endpoint not found. Your API key may be for the x402 product, not the LLM gateway. Get a gateway key at bankr.bot.'
            : 'Your bankr.bot API key may be invalid or expired.'
        }
      });
    }

    res.status(status).setHeader('Content-Type','application/json').send(text);
  } catch(e) {
    res.status(502).json({ error:{ message:'Proxy error: '+e.message } });
  }
};
