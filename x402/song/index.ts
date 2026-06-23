// Orlix X402 — Crypto Song Generator
// AI-written lyrics for any token. $ORLIX holders get extended songs + extra verses.

import { getOrlixTier, withTier } from '../_shared/holder';

const GENRES = ['trap','phonk','pop','drill','hype','ballad'] as const;
type Genre = typeof GENRES[number];

async function fetchTokenData(query: string) {
  const isAddress = /^0x[0-9a-f]{40}$/i.test(query);
  const url = isAddress
    ? `https://api.dexscreener.com/latest/dex/tokens/${query}`
    : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const r    = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const data: any = await r.json();
  const pairs = (data.pairs || []).filter((p: any) => p.chainId === 'base');
  const best  = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!best) return null;
  return {
    symbol:        best.baseToken?.symbol || query.toUpperCase(),
    name:          best.baseToken?.name   || query,
    priceUsd:      best.priceUsd ? Number(best.priceUsd) : null,
    priceChange24h:best.priceChange?.h24 ?? null,
    volume24h:     best.volume?.h24 || 0,
    liquidity:     best.liquidity?.usd || 0,
    buys24h:       best.txns?.h24?.buys  || 0,
    sells24h:      best.txns?.h24?.sells || 0,
  };
}

export default async function handler(req: Request) {
  const url    = new URL(req.url);
  const query  = (url.searchParams.get('token') || url.searchParams.get('q') || '').trim();
  const genre  = (GENRES.includes(url.searchParams.get('genre') as Genre) ? url.searchParams.get('genre') : 'trap') as Genre;
  const wallet = url.searchParams.get('wallet') || null;

  if (!query) {
    return new Response(JSON.stringify({
      error:   'token parameter required',
      example: '?token=ORLIX&genre=trap&wallet=0xYourWallet',
      genres:  GENRES,
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const key = process.env.ORLIX_LLM_KEY || process.env.BANKR_LLM_KEY || '';
  if (!key) return new Response(JSON.stringify({ error: 'BANKR_LLM_KEY not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

  const tier     = await getOrlixTier(wallet);
  const isHolder = tier.tier !== 'NONE';

  let token: any = null;
  try { token = await fetchTokenData(query); } catch {}
  if (!token) token = { symbol: query.toUpperCase().replace('$',''), name: query, priceUsd: null, priceChange24h: null, volume24h: 0, liquidity: 0, buys24h: 0, sells24h: 0 };

  const priceStr  = token.priceUsd ? `$${token.priceUsd < 0.001 ? token.priceUsd.toFixed(8) : token.priceUsd.toFixed(4)}` : 'not listed';
  const changeStr = token.priceChange24h != null ? `${token.priceChange24h > 0 ? '+' : ''}${token.priceChange24h.toFixed(1)}% in 24h` : 'unknown movement';
  const momentum  = token.buys24h > token.sells24h ? `${token.buys24h} buys vs ${token.sells24h} sells — bulls winning.` : `${token.sells24h} sells vs ${token.buys24h} buys — bears in control.`;

  // Holders get extended songs with bridge + outro
  const structure = isHolder
    ? '4 verses + 1 hook + 1 bridge + 1 outro'
    : '3 verses + 1 hook';

  const genreGuide: Record<Genre, string> = {
    trap:   'Hard 808s, money flex, Base network slang, ad-libs',
    phonk:  'Dark Memphis vibes, drift energy, deep cowbell rhythm, distorted flow',
    drill:  'Cold UK/NY delivery, dark piano chops, gritty street credibility',
    hype:   'Stadium energy, crowd pump-up, bass drops, rally anthem',
    ballad: 'Emotional storytelling, the bag journey, melancholic reflection on losses and gains',
    pop:    'Catchy hook, radio-ready, relatable crypto feelings everyone knows',
  };

  const prompt = `Write ${genre} song lyrics about the crypto token $${token.symbol} (${token.name}) on Base network.
Structure: ${structure}.
Price: ${priceStr}, ${changeStr}.
Volume 24h: $${Number(token.volume24h).toLocaleString()}.
${momentum}
Genre guide: ${genreGuide[genre]}
Rules: Make numbers and token name feel natural — never forced. No generic crypto filler. Real emotion.`;

  const r = await fetch('https://llm.bankr.bot/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: tier.maxTokens,
      system:     'You are a world-class songwriter fluent in trap, phonk, pop, drill, hype, and ballad. English only. Real artists, real flow. Token data is creative fuel — feel it, don\'t recite it.',
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const d: any = await r.json();
  const lyrics  = d.content?.[0]?.text || '';

  return withTier({
    token:     { symbol: token.symbol, name: token.name, priceUsd: token.priceUsd, priceChange24h: token.priceChange24h, volume24h: token.volume24h },
    genre,
    structure,
    lyrics,
    timestamp: new Date().toISOString(),
    poweredBy: 'Orlix AI — orlixai.xyz',
  }, tier);
}
