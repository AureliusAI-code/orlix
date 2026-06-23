// Orlix X402 — Multi-Model AI Chat
// Access 19 frontier models via single endpoint. $ORLIX holders get premium models + more tokens.

import { getOrlixTier, withTier } from '../_shared/holder';

const ALL_MODELS = [
  'claude-sonnet-4-6','claude-haiku-4-5-20251001','claude-opus-4-8',
  'gpt-5.4','gpt-5-nano','gpt-5.2-codex',
  'gemini-3.1-pro','gemini-3-flash',
  'grok-4.20','grok-4.1-fast',
  'deepseek-v3.2',
  'kimi-k2.7-code','kimi-k2.6',
  'qwen3-coder','qwen3.7-plus','qwen3.6-flash',
  'glm-5.1','glm-5-turbo',
  'mimo-v2.5-pro-ultraspeed',
] as const;

// Free tier only gets fast/small models — holders unlock all
const FREE_MODELS = ['claude-haiku-4-5-20251001','gpt-5-nano','gemini-3-flash','grok-4.1-fast','qwen3.6-flash','glm-5-turbo'];

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      error:   'POST required',
      models:  ALL_MODELS,
      usage:   { method: 'POST', body: { message: 'string', model: 'string (optional)', system: 'string (optional)', wallet: 'string (optional — $ORLIX holder wallet for better access)' } },
    }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  let body: any;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const message = (body.message || '').trim();
  if (!message) {
    return new Response(JSON.stringify({ error: 'message is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const wallet = body.wallet || null;
  const tier   = await getOrlixTier(wallet);

  // Free tier: restrict to fast models only
  const requested   = (body.model || 'claude-haiku-4-5-20251001') as string;
  const isHolder    = tier.tier !== 'NONE';
  const allowedModels = isHolder ? ALL_MODELS : FREE_MODELS;
  const model       = allowedModels.includes(requested as any) ? requested : (isHolder ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001');

  const system      = body.system || 'You are Orlix AI — a helpful, intelligent assistant with deep knowledge of crypto, Base network, and DeFi. Be concise and accurate.';
  const isClaude    = model.startsWith('claude');
  const isMimo      = model.startsWith('mimo');
  const maxTokens   = tier.maxTokens;

  const bankrKey = process.env.ORLIX_LLM_KEY || process.env.BANKR_LLM_KEY || '';
  if (!bankrKey) {
    return new Response(JSON.stringify({ error: 'BANKR_LLM_KEY not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  const bankrHeaders = {
    'Content-Type': 'application/json',
    'X-API-Key': bankrKey,
    'anthropic-version': '2023-06-01',
  };

  let responseText = '';
  try {
    if (isMimo) {
      const mimoKey = process.env.MIMO_API_KEY || '';
      if (!mimoKey) return new Response(JSON.stringify({ error: 'MIMO_API_KEY not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      const r   = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mimoKey}` },
        body:    JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: message }], max_tokens: maxTokens }),
        signal:  AbortSignal.timeout(30000),
      });
      const d: any = await r.json();
      responseText  = d.choices?.[0]?.message?.content || '';
    } else if (isClaude) {
      const r   = await fetch('https://llm.bankr.bot/v1/messages', {
        method: 'POST',
        headers: bankrHeaders,
        body:    JSON.stringify({ model, system, messages: [{ role: 'user', content: message }], max_tokens: maxTokens }),
        signal:  AbortSignal.timeout(30000),
      });
      const d: any = await r.json();
      responseText  = d.content?.[0]?.text || (d.error?.message ? `Error: ${d.error.message}` : '');
    } else {
      const r   = await fetch('https://llm.bankr.bot/v1/chat/completions', {
        method: 'POST',
        headers: bankrHeaders,
        body:    JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: message }], max_tokens: maxTokens }),
        signal:  AbortSignal.timeout(30000),
      });
      const d: any = await r.json();
      responseText  = d.choices?.[0]?.message?.content || (d.error?.message ? `Error: ${d.error.message}` : '');
    }

    return withTier({
      model,
      message,
      response:  responseText,
      maxTokens,
      timestamp: new Date().toISOString(),
      poweredBy: 'Orlix AI — orlixai.xyz',
    }, tier);
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
