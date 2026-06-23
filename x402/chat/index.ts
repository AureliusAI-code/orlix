// Orlix X402 — AI Chat with 19 frontier models
// Paid endpoint: send a message, get a response from any Orlix-supported model
// Payment handled by Bankr — no x402 imports needed here

const BANKR_MODELS = [
  'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-8',
  'gpt-5.4', 'gpt-5-nano', 'gpt-5.2-codex',
  'gemini-3.1-pro', 'gemini-3-flash',
  'grok-4.20', 'grok-4.1-fast',
  'deepseek-v3.2',
  'kimi-k2.7-code', 'kimi-k2.6',
  'qwen3-coder', 'qwen3.7-plus', 'qwen3.6-flash',
  'glm-5.1', 'glm-5-turbo',
  'mimo-v2.5-pro-ultraspeed',
] as const;

type Model = typeof BANKR_MODELS[number];

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({
      error: 'POST required',
      usage: { method: 'POST', body: { message: 'string', model: 'string (optional)', system: 'string (optional)' } },
      availableModels: BANKR_MODELS,
    }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const message: string = (body.message || '').trim();
  if (!message) {
    return new Response(JSON.stringify({ error: 'message is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const model: Model   = BANKR_MODELS.includes(body.model) ? body.model : 'claude-sonnet-4-6';
  const system: string = body.system || 'You are Orlix AI — a helpful, intelligent assistant. Be concise and accurate.';
  const isClaude = model.startsWith('claude');
  const isMimo   = model.startsWith('mimo');

  const key = process.env.BANKR_LLM_KEY || '';
  if (!key) {
    return new Response(JSON.stringify({ error: 'BANKR_LLM_KEY not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  const bankrHeaders = {
    'Content-Type': 'application/json',
    'X-API-Key': key,
    'anthropic-version': '2023-06-01',
  };

  try {
    let responseText = '';

    if (isMimo) {
      const mimoKey = process.env.MIMO_API_KEY || '';
      if (!mimoKey) return new Response(JSON.stringify({ error: 'MIMO_API_KEY not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      const r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mimoKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: message }], max_tokens: 2048 }),
      });
      const d: any = await r.json();
      responseText = d.choices?.[0]?.message?.content || '';
    } else if (isClaude) {
      const r = await fetch('https://llm.bankr.bot/v1/messages', {
        method: 'POST',
        headers: bankrHeaders,
        body: JSON.stringify({ model, system, messages: [{ role: 'user', content: message }], max_tokens: 2048 }),
      });
      const d: any = await r.json();
      responseText = d.content?.[0]?.text || '';
    } else {
      const r = await fetch('https://llm.bankr.bot/v1/chat/completions', {
        method: 'POST',
        headers: bankrHeaders,
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: message }], max_tokens: 2048 }),
      });
      const d: any = await r.json();
      responseText = d.choices?.[0]?.message?.content || '';
    }

    return {
      model,
      message,
      response: responseText,
      timestamp: new Date().toISOString(),
      poweredBy: 'Orlix AI — orlixai.xyz',
    };
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
