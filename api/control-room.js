// Orlix Control Room — Base top-100 trending tokens from DexScreener
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const EXCLUDE_SYMBOLS = new Set([
  'USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB',
  'EURC','CRVUSD','LUSD','FRAX','SUSD','BUSD','GUSD','TUSD',
  'RETH','STETH','WSTETH','ETH',
]);

// Fallback: well-known Base tokens in case screener endpoint is blocked
const BASE_SEARCHES = [
  'BRETT','VIRTUAL','AERO','DEGEN','TOSHI','HIGHER',
  'MOG','WELL','NORMIE','BASED','MOCHI','TURBO',
  'ODOS','CBBTC','ZORA','ENJOY','MFER','PRIME',
  'MIGGLES','KEYCAT','BALD','TYBG','HAM','ANDY',
  'ANON','MOON','WEN','BCT','SEAM','FRENPET',
  'MOXIE','BUILD','CLANKER','TALENT','SMOL',
  'SNX','AAVE','SUSHI','GMX','RDNT','COMP',
  'TAROT','GNS','PERP','YFI','BSWAP',
  'PEPE','BONK','FLOKI','APE','SHIB',
  'BLUR','ENS','LDO','RPL','WAIFU','KNINE',
];

let dataCache = { data: null, ts: 0 };
let commentaryCache = { text: '', ts: 0 };
const DATA_TTL = 30_000;
const COMMENTARY_TTL = 300_000;

// Browser-like headers to avoid DexScreener bot blocks
const BROWSER_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://dexscreener.com',
  'Referer': 'https://dexscreener.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
};

function fmtUsd(n) {
  if (!n && n !== 0) return null;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function dget(url, headers = {}) {
  const r = await fetch(url, {
    headers: { ...BROWSER_HEADERS, ...headers },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function isValidPair(p) {
  if (p.chainId !== 'base') return false;
  if (!p.baseToken?.address) return false;
  const sym = (p.baseToken.symbol || '').toUpperCase();
  if (EXCLUDE_SYMBOLS.has(sym)) return false;
  if ((p.liquidity?.usd || 0) < 10000) return false;
  return true;
}

function mapPair(p, rank) {
  return {
    rank: rank ?? null,
    address: p.baseToken.address,
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
  };
}

// Strategy 1: DexScreener's internal screener — the same API powering dexscreener.com/base
// Pages 1-4 × ~30 results each = up to 120 Base tokens in their exact trending order
async function fetchViaScreener() {
  const pages = await Promise.all(
    [1, 2, 3, 4].map(page =>
      dget(
        `https://io.dexscreener.com/dex/screener/pairs/h24/base${page}?rankBy=volume24hUsd&order=desc`,
        { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'cors' }
      ).catch(() => null)
    )
  );
  const pairs = [];
  for (const r of pages) {
    if (r?.pairs?.length) pairs.push(...r.pairs);
  }
  return pairs;
}

// Strategy 2: keyword searches + profiles/boosts (fallback if screener is blocked)
async function fetchViaKeywords() {
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

  return rawPairs;
}

function deduplicatePairs(rawPairs) {
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
  return Object.values(tokenMap);
}

async function fetchTop100() {
  // Try the real DexScreener screener first
  const screenerPairs = await fetchViaScreener();

  let uniquePairs;
  let source;

  if (screenerPairs.length >= 50) {
    // Got real DexScreener ranking — preserve their order (already sorted by volume24h)
    uniquePairs = deduplicatePairs(screenerPairs);
    source = 'screener';
  } else {
    // Screener blocked — fall back to keyword approach
    const fallbackPairs = await fetchViaKeywords();
    uniquePairs = deduplicatePairs(fallbackPairs);
    uniquePairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
    source = 'fallback';
  }

  // Sort by 24h volume and take top 100
  uniquePairs.sort((a, b) => {
    const bv = b.volume?.h24 || b.volume24h || 0;
    const av = a.volume?.h24 || a.volume24h || 0;
    return bv - av;
  });

  return { pairs: uniquePairs.slice(0, 100), source };
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

  const { pairs: rawTop100, source } = await fetchTop100();

  // Map with rank numbers (1-based)
  const allTokens = rawTop100.map((p, i) => mapPair(p, i + 1));

  const totalVol1h = allTokens.reduce((s, t) => s + (t.volume1h || 0), 0);
  const safeCount = allTokens.filter(t => (t.liquidity || 0) >= 50000).length;

  const stats = {
    total: allTokens.length,
    safeCount,
    totalVol1h,
    source,
    ts: now,
  };

  const liveActivity = allTokens;
  const trending = allTokens.slice(0, 15);

  const commentary = await generateCommentary(allTokens, process.env.ANTHROPIC_API_KEY);

  const data = { liveActivity, trending, stats, commentary };
  dataCache = { data, ts: now };

  res.writeHead(200, CORS);
  res.end(JSON.stringify(data));
};
