// Orlix Control Room — Base top-100 via GeckoTerminal trending
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const EXCLUDE_SYMBOLS = new Set([
  'USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB',
  'EURC','CRVUSD','LUSD','FRAX','SUSD','BUSD','GUSD','TUSD',
  'RETH','STETH','WSTETH','ETH','USDPLUS','USD+',
]);

// DexScreener fallback keyword list
const BASE_SEARCHES = [
  'BRETT','VIRTUAL','AERO','DEGEN','TOSHI','HIGHER',
  'MOG','WELL','NORMIE','BASED','MOCHI','TURBO',
  'ODOS','CBBTC','ZORA','ENJOY','MFER','PRIME',
  'MIGGLES','KEYCAT','BALD','TYBG','HAM','ANDY',
  'ANON','MOON','WEN','BCT','SEAM','FRENPET',
  'MOXIE','BUILD','CLANKER','TALENT','SMOL',
  'SNX','AAVE','SUSHI','GMX','RDNT','COMP',
  'PEPE','BONK','FLOKI','APE','SHIB',
  'BLUR','ENS','LDO','RPL','WAIFU','KNINE',
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

async function dget(url, extraHeaders = {}) {
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── GeckoTerminal (primary) ──────────────────────────────────────────────────
// Public API by CoinGecko — real trending pools on Base, no key required

function mapGeckoPool(pool, tokenMap, rank) {
  const attrs = pool.attributes || {};
  const baseTokenId = pool.relationships?.base_token?.data?.id;
  const baseToken = tokenMap[baseTokenId];
  const bta = baseToken?.attributes || {};

  const sym = (bta.symbol || '').toUpperCase();
  if (EXCLUDE_SYMBOLS.has(sym)) return null;
  if (!bta.address) return null;
  const liq = parseFloat(attrs.reserve_in_usd || 0);
  if (liq < 10000) return null;

  return {
    rank,
    address: bta.address.toLowerCase(),
    name: bta.name || 'Unknown',
    symbol: bta.symbol || '???',
    priceUsd: attrs.base_token_price_usd || null,
    priceChange5m: parseFloat(attrs.price_change_percentage?.m5) || null,
    priceChange1h: parseFloat(attrs.price_change_percentage?.h1) || null,
    priceChange6h: parseFloat(attrs.price_change_percentage?.h6) || null,
    priceChange24h: parseFloat(attrs.price_change_percentage?.h24) || null,
    volume1h: parseFloat(attrs.volume_usd?.h1 || 0),
    volume6h: parseFloat(attrs.volume_usd?.h6 || 0),
    volume24h: parseFloat(attrs.volume_usd?.h24 || 0),
    liquidity: liq,
    marketCap: parseFloat(attrs.market_cap_usd || attrs.fdv_usd || 0),
    fdv: parseFloat(attrs.fdv_usd || 0),
    buys1h: attrs.transactions?.h1?.buys || 0,
    sells1h: attrs.transactions?.h1?.sells || 0,
    buys24h: attrs.transactions?.h24?.buys || 0,
    sells24h: attrs.transactions?.h24?.sells || 0,
    pairAddress: attrs.address || null,
    pairCreatedAt: attrs.pool_created_at ? new Date(attrs.pool_created_at).getTime() : null,
    pairUrl: `https://dexscreener.com/base/${bta.address}`,
    dexId: pool.relationships?.dex?.data?.id || 'unknown',
    pairName: attrs.name || `${bta.symbol}/WETH`,
    _logo: bta.image_url || null,
  };
}

async function fetchGeckoTerminal() {
  // trending_pools: what's actually trending on Base right now (similar to DexScreener /base page)
  // new_pools: freshly launched tokens
  // Each page = 20 pools; fetch 5 pages trending + 2 pages top-volume to fill 100
  const GT = 'https://api.geckoterminal.com/api/v2/networks/base';
  const inc = 'include=base_token,quote_token';

  const tasks = [
    dget(`${GT}/trending_pools?${inc}&page=1`).catch(() => null),
    dget(`${GT}/trending_pools?${inc}&page=2`).catch(() => null),
    dget(`${GT}/trending_pools?${inc}&page=3`).catch(() => null),
    dget(`${GT}/trending_pools?${inc}&page=4`).catch(() => null),
    dget(`${GT}/trending_pools?${inc}&page=5`).catch(() => null),
    // Also grab top-volume pools to supplement
    dget(`${GT}/pools?${inc}&sort=h24_volume_usd_desc&page=1`).catch(() => null),
    dget(`${GT}/pools?${inc}&sort=h24_volume_usd_desc&page=2`).catch(() => null),
    dget(`${GT}/pools?${inc}&sort=h24_volume_usd_desc&page=3`).catch(() => null),
  ];

  const results = await Promise.all(tasks);

  const pools = [];
  const tokenMap = {};

  for (const r of results) {
    if (r?.data?.length) pools.push(...r.data);
    if (r?.included?.length) {
      for (const t of r.included) tokenMap[t.id] = t;
    }
  }

  return { pools, tokenMap };
}

// ── DexScreener fallback ─────────────────────────────────────────────────────

function isValidDexPair(p) {
  if (p.chainId !== 'base') return false;
  if (!p.baseToken?.address) return false;
  const sym = (p.baseToken.symbol || '').toUpperCase();
  if (EXCLUDE_SYMBOLS.has(sym)) return false;
  if ((p.liquidity?.usd || 0) < 10000) return false;
  return true;
}

function mapDexPair(p, rank) {
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

async function fetchDexScreenerFallback() {
  const tasks = [
    dget('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => null),
    dget('https://api.dexscreener.com/token-boosts/top/v1').catch(() => null),
    dget('https://api.dexscreener.com/token-boosts/latest/v1').catch(() => null),
    ...BASE_SEARCHES.map(q =>
      dget(`https://api.dexscreener.com/latest/dex/search?q=${q}`).catch(() => null)
    ),
  ];
  const results = await Promise.all(tasks);
  const [profilesRes, boostsTopRes, boostsLatestRes, ...searchResults] = results;

  const rawPairs = [];
  for (const r of searchResults) {
    if (r?.pairs) rawPairs.push(...r.pairs);
  }

  const addrSet = new Set();
  if (Array.isArray(profilesRes)) {
    for (const t of profilesRes) {
      if (t.chainId === 'base' && t.tokenAddress) addrSet.add(t.tokenAddress.toLowerCase());
    }
  }
  for (const boosts of [boostsTopRes, boostsLatestRes]) {
    if (Array.isArray(boosts)) {
      for (const t of boosts) {
        if (t.chainId === 'base' && t.tokenAddress) addrSet.add(t.tokenAddress.toLowerCase());
      }
    }
  }

  const addrList = [...addrSet].slice(0, 120);
  const chunks = [];
  for (let i = 0; i < addrList.length; i += 30) chunks.push(addrList.slice(i, i + 30).join(','));
  const batchResults = await Promise.all(
    chunks.map(c => dget(`https://api.dexscreener.com/latest/dex/tokens/${c}`).catch(() => null))
  );
  for (const r of batchResults) {
    if (r?.pairs) rawPairs.push(...r.pairs);
  }

  // Dedup by address — prefer highest liquidity with priceUsd
  const tokenMap = {};
  for (const p of rawPairs) {
    if (!isValidDexPair(p)) continue;
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

  return Object.values(tokenMap).sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
}

// ── Main fetch ───────────────────────────────────────────────────────────────

async function fetchTop100() {
  const { pools, tokenMap } = await fetchGeckoTerminal();

  // Dedup by token address — keep first (highest-ranked) pool per token
  const seen = new Set();
  const geckoTokens = [];
  let rank = 1;

  for (const pool of pools) {
    const baseTokenId = pool.relationships?.base_token?.data?.id;
    const baseToken = tokenMap[baseTokenId];
    const addr = baseToken?.attributes?.address?.toLowerCase();
    if (!addr || seen.has(addr)) continue;

    const mapped = mapGeckoPool(pool, tokenMap, rank);
    if (!mapped) continue;

    seen.add(addr);
    geckoTokens.push(mapped);
    rank++;
    if (rank > 100) break;
  }

  if (geckoTokens.length >= 10) {
    return { tokens: geckoTokens.slice(0, 100), source: 'geckoterminal', _debug: { rawPools: pools.length, mapped: geckoTokens.length } };
  }

  // Fallback to DexScreener keyword search
  const pairs = await fetchDexScreenerFallback();
  const tokens = pairs.slice(0, 100).map((p, i) => mapDexPair(p, i + 1));
  return { tokens, source: 'dexscreener-fallback', _debug: { rawPools: pools.length, geckMapped: geckoTokens.length } };
}

// ── Commentary ───────────────────────────────────────────────────────────────

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

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  const now = Date.now();
  if (dataCache.data && now - dataCache.ts < DATA_TTL) {
    res.writeHead(200, CORS);
    return res.end(JSON.stringify(dataCache.data));
  }

  const result = await fetchTop100();
  const allTokens = result.tokens;
  const source = result.source;

  const totalVol1h = allTokens.reduce((s, t) => s + (t.volume1h || 0), 0);
  const safeCount = allTokens.filter(t => (t.liquidity || 0) >= 50000).length;

  const stats = { total: allTokens.length, safeCount, totalVol1h, source, _debug: result._debug, ts: now };
  const liveActivity = allTokens;
  const trending = allTokens.slice(0, 15);
  const commentary = await generateCommentary(allTokens, process.env.ANTHROPIC_API_KEY);

  const data = { liveActivity, trending, stats, commentary };
  dataCache = { data, ts: now };

  res.writeHead(200, CORS);
  res.end(JSON.stringify(data));
};
