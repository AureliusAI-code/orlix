// Orlix Control Room — Base top-100 via DexScreener public search API
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const EXCLUDE_SYMBOLS = new Set([
  'USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB',
  'EURC','CRVUSD','LUSD','FRAX','SUSD','BUSD','GUSD','TUSD',
  'RETH','STETH','WSTETH','ETH','USDPLUS','USD+','WSTETH',
]);

// Token addresses that are always included regardless of liquidity filter
const PINNED_ADDRESSES = [
  '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b', // BNKR
];

// 80+ well-known Base ecosystem tokens — no random promoted tokens
const BASE_SEARCHES = [
  // Tier 1 — core Base native (always top 20)
  'BRETT','VIRTUAL','AERO','DEGEN','TOSHI','HIGHER',
  'MOG','WELL','NORMIE','BASED','MOCHI','TURBO',
  'ODOS','CBBTC','ZORA','ENJOY','MFER','PRIME',
  // Tier 2 — established Base memes
  'MIGGLES','KEYCAT','BALD','TYBG','HAM','ANDY',
  'ANON','MOON','WEN','BCT','SEAM','FRENPET',
  'MOXIE','BUILD','CLANKER','TALENT','SMOL',
  // DeFi on Base
  'SNX','AAVE','SUSHI','GMX','RDNT','COMP',
  'TAROT','GNS','PERP','YFI','BSWAP','MORPHO','EXTRA',
  // Cross-chain tokens active on Base
  'PEPE','BONK','FLOKI','APE','SHIB','WAIFU','KNINE',
  'BLUR','ENS','LDO','RPL',
  // AI/Agent tokens on Base
  'AIXBT','VADER','LUNA','AGNT',
  // More Base memes
  'BILLY','PURR','DOOMER','BASENJI','CHOMP','GIGA',
  'COPE','WOJAK','PONKE','POPCAT','WIF','BOME',
  'BRIUN','SMURFCAT','CRASH','LEET','POKE',
  // Additional ecosystem
  'CYBER','TAO','GODS','PIXEL','FARM','DARK',
  'MORPHO','COIN','DEGEN','TOSHI',
  // Bankr ecosystem
  'BNKR','BANKR',
];

let dataCache = { data: null, ts: 0 };
let commentaryCache = { text: '', ts: 0 };
const DATA_TTL = 30_000;
const COMMENTARY_TTL = 300_000;

function fmtUsd(n) {
  if (!n && n !== 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function dget(url) {
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function isValidPair(p) {
  if (p.chainId !== 'base') return false;
  if (!p.baseToken?.address) return false;
  const sym = (p.baseToken.symbol || '').toUpperCase();
  if (EXCLUDE_SYMBOLS.has(sym)) return false;
  // Only require $5k liquidity — generous enough to catch all real tokens
  if ((p.liquidity?.usd || 0) < 5000) return false;
  return true;
}

function mapPair(p, rank) {
  return {
    rank,
    address: p.baseToken.address.toLowerCase(),
    name: p.baseToken.name || 'Unknown',
    symbol: p.baseToken.symbol || '???',
    priceUsd: p.priceUsd || null,
    priceChange5m: p.priceChange?.m5 ?? null,
    priceChange1h: p.priceChange?.h1 ?? null,
    priceChange6h: p.priceChange?.h6 ?? null,
    priceChange24h: p.priceChange?.h24 ?? null,
    volume1h: p.volume?.h1 || 0,
    volume6h: p.volume?.h6 || 0,
    volume24h: p.volume?.h24 || 0,
    liquidity: p.liquidity?.usd || 0,
    marketCap: p.marketCap || p.fdv || 0,
    fdv: p.fdv || 0,
    buys1h: p.txns?.h1?.buys || 0,
    sells1h: p.txns?.h1?.sells || 0,
    buys24h: p.txns?.h24?.buys || 0,
    sells24h: p.txns?.h24?.sells || 0,
    pairAddress: p.pairAddress || null,
    pairCreatedAt: p.pairCreatedAt || null,
    pairUrl: p.url || `https://dexscreener.com/base/${p.baseToken.address}`,
    dexId: p.dexId || 'unknown',
    pairName: `${p.baseToken.symbol}/${p.quoteToken?.symbol || '?'}`,
    _logo: null,
  };
}

async function fetchTop100() {
  // Run all keyword searches in parallel
  const searchResults = await Promise.all(
    BASE_SEARCHES.map(q =>
      dget(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`)
        .catch(() => null)
    )
  );

  // Collect all valid Base pairs
  const rawPairs = [];
  for (const r of searchResults) {
    if (r?.pairs) rawPairs.push(...r.pairs);
  }

  // Deduplicate by token address — keep pair with priceUsd + highest liquidity
  const tokenMap = {};
  for (const p of rawPairs) {
    if (!isValidPair(p)) continue;
    const key = p.baseToken.address.toLowerCase();
    const cur = tokenMap[key];
    if (!cur) { tokenMap[key] = p; continue; }
    const newLiq = p.liquidity?.usd || 0;
    const curLiq = cur.liquidity?.usd || 0;
    const newHasPrice = !!p.priceUsd;
    const curHasPrice = !!cur.priceUsd;
    if ((!curHasPrice && newHasPrice) || (newHasPrice && newLiq > curLiq)) {
      tokenMap[key] = p;
    }
  }

  // Secondary dedup by symbol — if two tokens share a symbol, keep the one
  // with highest volume24h (fake/scam tokens have near-zero real volume)
  const symMap = {};
  for (const p of Object.values(tokenMap)) {
    const sym = (p.baseToken.symbol || '').toUpperCase();
    const cur = symMap[sym];
    if (!cur || (p.volume?.h24 || 0) > (cur.volume?.h24 || 0)) {
      symMap[sym] = p;
    }
  }

  // Fetch pinned addresses by exact address — always included
  const pinnedRes = await dget(
    `https://api.dexscreener.com/latest/dex/tokens/${PINNED_ADDRESSES.join(',')}`
  ).catch(() => null);
  if (pinnedRes?.pairs) {
    for (const p of pinnedRes.pairs) {
      if (p.chainId !== 'base' || !p.baseToken?.address) continue;
      const addrKey = p.baseToken.address.toLowerCase();
      const isPinned = PINNED_ADDRESSES.some(a => a.toLowerCase() === addrKey);
      if (!isPinned) continue;
      const sym = (p.baseToken.symbol || '').toUpperCase();
      // Add to symMap if not already present, or replace if this pair has higher liquidity
      const cur = symMap[sym];
      if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) {
        symMap[sym] = p;
      }
    }
  }

  // Sort by 24h volume — closest public proxy to DexScreener trending rank
  const sorted = Object.values(symMap)
    .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));

  return sorted.slice(0, 100).map((p, i) => mapPair(p, i + 1));
}

async function generateCommentary(tokens, apiKey) {
  if (!apiKey) return '';
  const now = Date.now();
  if (commentaryCache.text && now - commentaryCache.ts < COMMENTARY_TTL) {
    return commentaryCache.text;
  }
  const top = tokens.filter(t => (t.volume1h || 0) > 0).slice(0, 3);
  const totalVol = tokens.reduce((s, t) => s + (t.volume1h || 0), 0);
  const prompt = `${tokens.length} active tokens on Base. Total 1h volume: ${fmtUsd(totalVol)}. ` +
    (top.length ? `Top: ${top.map(t => `$${t.symbol} (${t.priceChange1h != null ? (t.priceChange1h >= 0 ? '+' : '') + t.priceChange1h.toFixed(1) + '%' : '?'} 1h)`).join(', ')}.` : '') +
    ' Give a 1-2 sentence live market commentary on Base. Be specific. No emojis. No markdown.';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 120,
        system: 'You are a live crypto analyst monitoring Base network. 1-2 sentences, direct, no emojis.',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('upstream');
    const resp = await r.json();
    const text = resp.content?.[0]?.text || '';
    if (text) commentaryCache = { text, ts: now };
    return text;
  } catch { return commentaryCache.text || ''; }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  const now = Date.now();
  if (dataCache.data && now - dataCache.ts < DATA_TTL) {
    res.writeHead(200, CORS);
    return res.end(JSON.stringify(dataCache.data));
  }

  const allTokens = await fetchTop100();

  const totalVol1h = allTokens.reduce((s, t) => s + (t.volume1h || 0), 0);
  const safeCount = allTokens.filter(t => (t.liquidity || 0) >= 50000).length;
  const stats = { total: allTokens.length, safeCount, totalVol1h, ts: now };

  const liveActivity = allTokens;
  const trending = allTokens.slice(0, 15);
  const commentary = await generateCommentary(allTokens, process.env.ANTHROPIC_API_KEY);

  const data = { liveActivity, trending, stats, commentary };
  dataCache = { data, ts: now };

  res.writeHead(200, CORS);
  res.end(JSON.stringify(data));
};
