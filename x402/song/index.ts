// Orlix X402 — Crypto Song Generator
// Paid endpoint: generate song lyrics for any crypto token
// Payment handled by Bankr — no x402 imports needed here

const GENRES = ['trap', 'phonk', 'pop', 'drill', 'hype', 'ballad'] as const;
type Genre = typeof GENRES[number];

async function fetchTokenData(query: string) {
  const isAddress = /^0x[0-9a-f]{40}$/i.test(query);
  const url = isAddress
    ? `https://api.dexscreener.com/latest/dex/tokens/${query}`
    : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
  const r = await fetch(url);
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
    marketCap:     best.marketCap || 0,
    buys24h:       best.txns?.h24?.buys  || 0,
    sells24h:      best.txns?.h24?.sells || 0,
  };
}

function buildPrompt(token: any, genre: Genre): string {
  const priceStr = token.priceUsd
    ? `$${token.priceUsd < 0.001 ? token.priceUsd.toFixed(8) : token.priceUsd.toFixed(4)}`
    : 'not listed';
  const changeStr = token.priceChange24h != null
    ? `${token.priceChange24h > 0 ? '+' : ''}${token.priceChange24h.toFixed(1)}% in 24h`
    : 'unknown movement';

  return `Write ${genre} lyrics about the crypto token $${token.symbol} (${token.name}) on Base.
Current price: ${priceStr}, ${changeStr}.
Volume 24h: $${Number(token.volume24h).toLocaleString()}.
${token.buys24h > token.sells24h ? `${token.buys24h} buys vs ${token.sells24h} sells — bullish momentum.` : `${token.sells24h} sells vs ${token.buys24h} buys — bearish pressure.`}

Guidelines:
- 3 verses + 1 hook (bridge optional)
- Make the numbers and token name feel natural in the flow — not forced
- ${genre === 'trap' ? 'Hard 808s energy, money flex, Base network slang' : ''}
- ${genre === 'phonk' ? 'Dark, aggressive, Romanian phonk vibes, drift energy' : ''}
- ${genre === 'drill' ? 'UK/NY drill flow, cold delivery, street credibility' : ''}
- ${genre === 'hype' ? 'High energy, crowd pump-up, festival anthem feel' : ''}
- ${genre === 'ballad' ? 'Emotional, reflective, the bag journey told as a story' : ''}
- ${genre === 'pop' ? 'Catchy hook, radio-ready, relatable crypto feelings' : ''}
- No filler. No generic crypto clichés unless subverted cleverly.`;
}

export default async function handler(req: Request) {
  const url   = new URL(req.url);
  const query = (url.searchParams.get('token') || url.searchParams.get('q') || '').trim();
  const genre = (GENRES.includes(url.searchParams.get('genre') as Genre)
    ? url.searchParams.get('genre') as Genre
    : 'trap');

  if (!query) {
    return new Response(JSON.stringify({
      error: 'token parameter required',
      usage: { params: { token: 'symbol or contract address (e.g. ORLIX or 0x...)', genre: GENRES.join(' | ') } },
      example: '?token=ORLIX&genre=trap',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const key = process.env.BANKR_LLM_KEY || '';
  if (!key) return new Response(JSON.stringify({ error: 'BANKR_LLM_KEY not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });

  let token = null;
  try { token = await fetchTokenData(query); } catch {}
  if (!token) {
    token = { symbol: query.toUpperCase().replace('$', ''), name: query, priceUsd: null, priceChange24h: null, volume24h: 0, liquidity: 0, marketCap: 0, buys24h: 0, sells24h: 0 };
  }

  const prompt = buildPrompt(token, genre);

  const r = await fetch('https://llm.bankr.bot/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: 'You are a world-class songwriter fluent in trap, phonk, pop, drill, hype, and ballad. English only. Real flow, real emotion. Token data is creative fuel — never recite it, feel it.',
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  const d: any = await r.json();
  const lyrics = d.content?.[0]?.text || '';

  return {
    token: { symbol: token.symbol, name: token.name, priceUsd: token.priceUsd, priceChange24h: token.priceChange24h },
    genre,
    lyrics,
    timestamp: new Date().toISOString(),
    poweredBy: 'Orlix AI — orlixai.xyz',
  };
}
