// Vercel Serverless Function — /api/chat
// Routes:
//   • x-api-key present  → api.bankr.bot/v1/messages  (Anthropic-compatible, API key auth)
//   • no API key         → x402.bankr.bot              (pay-per-use $0.01 USDC, bankr SDK)
import { wrapFetchWithPayment } from '@bankr-bot/sdk';

const BANKR_API   = 'https://api.bankr.bot/v1/messages';
const BANKR_X402  = 'https://x402.bankr.bot';

// Build a payment-enabled fetch if BANKR_PRIVATE_KEY env var is set
function getPayingFetch() {
  const key = process.env.BANKR_PRIVATE_KEY;
  if (!key) return null;
  try { return wrapFetchWithPayment(fetch, { privateKey: key }); }
  catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = req.headers['x-api-key'] || '';
  const bodyObj = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

  // ── Path A: API key provided → Anthropic-compatible endpoint ──────────────
  if (apiKey) {
    try {
      const upstream = await fetch(BANKR_API, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body:    JSON.stringify(bodyObj),
      });
      const text = await upstream.text();
      return res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
    } catch (e) {
      return res.status(502).json({ error: { message: e.message } });
    }
  }

  // ── Path B: No API key → x402 pay-per-use ($0.01 USDC) ──────────────────
  const payingFetch = getPayingFetch();
  if (!payingFetch) {
    return res.status(402).json({
      error: {
        message: 'No API key provided. To use pay-per-use mode, set BANKR_PRIVATE_KEY in Vercel environment variables.',
        hint:    'Add your API key in Settings → API Key, or set BANKR_PRIVATE_KEY on Vercel for wallet payments.',
      }
    });
  }

  // Convert Anthropic messages format → x402 prompt string
  const messages = bodyObj.messages || [];
  const prompt = messages.map(m => {
    const content = Array.isArray(m.content) ? m.content.map(b => b.text || '').join('') : (m.content || '');
    return `${m.role}: ${content}`;
  }).join('\n\n');
  const model = bodyObj.model || 'gpt-4o-mini';

  try {
    const upstream = await payingFetch(BANKR_X402, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt, model }),
    });
    const text = await upstream.text();
    // Normalise to Anthropic-like format so the frontend parseReply works
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    // x402 response may use {text} or {content} or {choices[]}
    const reply = data.text || data.content || data.choices?.[0]?.message?.content || data.response || text;
    const normalised = { content: [{ type: 'text', text: reply }], usage: data.usage || {} };
    return res.status(upstream.status).setHeader('Content-Type', 'application/json').json(normalised);
  } catch (e) {
    return res.status(502).json({ error: { message: `x402 error: ${e.message}` } });
  }
}
