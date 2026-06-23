// Orlix X402 — Base Market Data
// Live top-100 tokens on Base with price, volume, liquidity. Holders get AI commentary.

import { getOrlixTier, withTier } from '../_shared/holder';

const EXCLUDE = new Set(['USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB','EURC','RETH','STETH','WSTETH','ETH','FRAX']);

const BASE_SEARCHES = [
  'BRETT','VIRTUAL','AERO','DEGEN','TOSHI','HIGHER','MOG','WELL','NORMIE','BASED',
  'MOCHI','TURBO','ODOS','ZORA','ENJOY','MFER','PRIME','MIGGLES','KEYCAT','BALD',
  'TYBG','HAM','ANDY','ANON','MOON','WEN','SEAM','FRENPET','MOXIE','BUILD',
  'CLANKER','TALENT','SMOL','PEPE','BONK','FLOKI','APE','WAIFU','BLUR','ENS',
  'AIXBT','VADER','LUNA','AGNT','BILLY','PURR','DOOMER','BASENJI','CHOMP','GIGA',
  'COPE','WOJAK','PONKE','POPCAT','WIF','BOME','BNKR','BANKR','ORLIX',
];

function isValid(p: any): boolean {
  return p.chainId === 'base' && !!p.baseToken?.address
    && !EXCLUDE.has((p.baseToken.symbol || '').toUpperCase())
    && (p.liquidity?.usd || 0) >= 5000;
}

function mapPair(p: any, rank: number) {
  return {
    rank,
    address:       p.baseToken.address.toLowerCase(),
    symbol:        p.baseToken.symbol,
    name:          p.baseToken.name,
    priceUsd:      p.priceUsd || null,
    priceChange1h: p.priceChange?.h1  ?? null,
    priceChange24h:p.priceChange?.h24 ?? null,
    volume1h:      p.volume?.h1  || 0,
    volume24h:     p.volume?.h24 || 0,
    liquidity:     p.liquidity?.usd || 0,
    marketCap:     p.marketCap || p.fdv || 0,
    buys24h:       p.txns?.h24?.buys  || 0,
    sells24h:      p.txns?.h24?.sells || 0,
    dexId:         p.dexId || 'unknown',
    pairUrl:       p.url || `https://dexscreener.com/base/${p.baseToken.address}`,
  };
}

async function fetchTop(limit: number) {
  const results = await Promise.all(
    BASE_SEARCHES.slice(0, 30).map(q =>
      fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    )
  );
  const seen: Record<string, any> = {};
  for (const r of results as any[]) {
    for (const p of (r?.pairs || [])) {
      if (!isValid(p)) continue;
      const key = p.baseToken.address.toLowerCase();
      if (!seen[key] || (p.liquidity?.usd || 0) > (seen[key].liquidity?.usd || 0)) seen[key] = p;
    }
  }
  return Object.values(seen)
    .sort((a: any, b: any) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
    .slice(0, limit)
    .map((p, i) => mapPair(p, i + 1));
}

async function aiCommentary(tokens: any[], key: string): Promise<string> {
  const top3 = tokens.slice(0, 3);
  const totalVol = tokens.reduce((s, t) => s + t.volume24h, 0);
  const prompt = `${tokens.length} active tokens on Base. Total 24h volume: $${(totalVol / 1e6).toFixed(1)}M. Top: ${top3.map(t => `$${t.symbol} (${t.priceChange24h != null ? (t.priceChange24h >= 0 ? '+' : '') + t.priceChange24h.toFixed(1) + '%' : '?'} 24h, $${(t.volume24h / 1e3).toFixed(0)}K vol)`).join(', ')}. Write 2-3 sentences of live market commentary. Be specific. No emojis. No markdown.`;
  const r = await fetch('https://llm.bankr.bot/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: 'You are a live crypto market analyst. Be concise, specific, and data-driven.', messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(12000),
  });
  const d: any = await r.json();
  return d.content?.[0]?.text || '';
}

export default async function handler(req: Request) {
  const url    = new URL(req.url);
  const wallet = url.searchParams.get('wallet') || null;
  const tier   = await getOrlixTier(wallet);

  // Holders see more tokens
  const limit  = Math.min(tier.results, 100);
  const tokens = await fetchTop(limit);

  const stats = {
    total:      tokens.length,
    totalVol24h:tokens.reduce((s, t) => s + t.volume24h, 0),
    gainers:    tokens.filter(t => (t.priceChange24h ?? 0) > 0).length,
    losers:     tokens.filter(t => (t.priceChange24h ?? 0) < 0).length,
  };

  // Only holders get AI commentary
  let commentary = '';
  const llmKey = process.env.ORLIX_LLM_KEY || process.env.BANKR_LLM_KEY || '';
  if (tier.tier !== 'NONE' && llmKey && tokens.length > 0) {
    commentary = await aiCommentary(tokens, llmKey).catch(() => '');
  }

  return withTier({
    tokens,
    stats,
    commentary: commentary || (tier.tier === 'NONE' ? 'Hold $ORLIX to unlock live AI market commentary' : ''),
    timestamp:  new Date().toISOString(),
    poweredBy:  'Orlix AI — orlixai.xyz',
  }, tier);
}
