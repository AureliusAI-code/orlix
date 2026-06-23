// Orlix X402 — Web Search
// Brave-powered web search. $ORLIX holders get more results + AI summary.

import { getOrlixTier, withTier } from '../_shared/holder';

export default async function handler(req: Request) {
  const url    = new URL(req.url);
  const q      = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
  const wallet = url.searchParams.get('wallet') || null;

  if (!q) {
    return new Response(JSON.stringify({
      error:   'q parameter required',
      example: '/search?q=ORLIX token Base&wallet=0xYourWallet',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const braveKey = process.env.BRAVE_SEARCH_API_KEY || '';
  if (!braveKey) {
    return new Response(JSON.stringify({ error: 'BRAVE_SEARCH_API_KEY not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  const tier    = await getOrlixTier(wallet);
  const count   = tier.results; // 5 for free, up to 50 for holders

  const r = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(count, 20)}&search_lang=en`,
    { headers: { Accept: 'application/json', 'X-Subscription-Token': braveKey }, signal: AbortSignal.timeout(10000) }
  );
  if (!r.ok) return new Response(JSON.stringify({ error: `Brave Search error: ${r.status}` }), { status: r.status, headers: { 'Content-Type': 'application/json' } });

  const data: any  = await r.json();
  const results    = (data.web?.results || []).slice(0, count).map((item: any) => ({
    title:       item.title,
    url:         item.url,
    description: item.description || '',
    published:   item.age || null,
  }));

  // Holders with LLM key get AI synthesis of results
  let aiSummary = '';
  const llmKey  = process.env.ORLIX_LLM_KEY || process.env.BANKR_LLM_KEY || '';
  if (tier.tier !== 'NONE' && llmKey && results.length > 0) {
    const snippets = results.slice(0, 5).map((r: any, i: number) => `[${i+1}] ${r.title}: ${r.description}`).join('\n');
    const rr = await fetch('https://llm.bankr.bot/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': llmKey, 'anthropic-version': '2023-06-01' },
      body:    JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system:     'You are a research assistant. Synthesize web search results into a concise, accurate answer. No markdown headers.',
        messages:   [{ role: 'user', content: `Query: "${q}"\n\nResults:\n${snippets}\n\nSynthesize a 3-4 sentence answer.` }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const dd: any = await rr.json();
    aiSummary     = dd.content?.[0]?.text || '';
  }

  return withTier({
    query:     q,
    count:     results.length,
    results,
    aiSummary: aiSummary || (tier.tier === 'NONE' ? 'Hold $ORLIX to unlock AI synthesis of search results' : ''),
    timestamp: new Date().toISOString(),
    poweredBy: 'Orlix AI + Brave Search — orlixai.xyz',
  }, tier);
}
