// Orlix Control Room — live Base network intelligence
// Stablecoins and wrapped assets to exclude from all panels
const EXCLUDE_SYMBOLS = new Set([
  'USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB',
  'EURC','CRVUSD','LUSD','FRAX','SUSD','BUSD','GUSD','TUSD',
  'RETH','STETH','WSTETH',
  // AERO intentionally NOT excluded — it's a real Base-native token
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

let dataCache = { data: null, ts: 0 };
let commentaryCache = { text: '', ts: 0 };
const DATA_TTL = 20_000;
const COMMENTARY_TTL = 300_000;

function shortenAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?';
}

function fmtUsd(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function dget(url) {
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Orlix/1.0' },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Well-known active Base token addresses (always fetched directly)
const BASE_TOKENS = [
  '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
  '0x532f27101965dd16442E59d40670FaF5eBB142E',  // BRETT
  '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', // DEGEN
  '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', // VIRTUAL
  '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B3',  // TOSHI
  '0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe',  // HIGHER
  '0xF6e932Ca12afa26665dC4dDE7e27be02A6C1284e',  // MOCHI
  '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3',  // ORLIX
];

// Fetch a large pool of Base pairs
async function fetchBasePairPool() {
  // Run in parallel: known token addresses + Base-native token name searches
  const [knownRes, s1, s2, s3, s4, s5, boostsRes] = await Promise.allSettled([
    dget(`https://api.dexscreener.com/latest/dex/tokens/${BASE_TOKENS.join(',')}`),
    dget('https://api.dexscreener.com/latest/dex/search?q=AERO'),
    dget('https://api.dexscreener.com/latest/dex/search?q=BRETT'),
    dget('https://api.dexscreener.com/latest/dex/search?q=DEGEN'),
    dget('https://api.dexscreener.com/latest/dex/search?q=VIRTUAL'),
    dget('https://api.dexscreener.com/latest/dex/search?q=TOSHI'),
    dget('https://api.dexscreener.com/token-boosts/top/v1'),
  ]);

  // Collect all pairs from search results
  const rawPairs = [];
  for (const r of [s1, s2, s3, s4, s5]) {
    if (r.status === 'fulfilled') rawPairs.push(...(r.value.pairs || []));
  }
  if (knownRes.status === 'fulfilled') rawPairs.push(...(knownRes.value.pairs || []));

  // For boosts: batch-fetch their pair data
  if (boostsRes.status === 'fulfilled') {
    const boostAddrs = (Array.isArray(boostsRes.value) ? boostsRes.value : [])
      .filter(t => t.chainId === 'base')
      .slice(0, 20)
      .map(t => t.tokenAddress)
      .filter(Boolean)
      .join(',');
    if (boostAddrs) {
      try {
        const bd = await dget(`https://api.dexscreener.com/latest/dex/tokens/${boostAddrs}`);
        rawPairs.push(...(bd.pairs || []));
      } catch { /* ignore */ }
    }
  }

  // Deduplicate, filter for Base, exclude stablecoins
  const seen = new Set();
  const pairs = [];
  for (const p of rawPairs) {
    const sym = (p.baseToken?.symbol || '').toUpperCase();
    if (
      p.chainId === 'base' &&
      p.baseToken?.address &&
      !seen.has(p.pairAddress) &&
      !EXCLUDE_SYMBOLS.has(sym)
    ) {
      seen.add(p.pairAddress);
      pairs.push(p);
    }
  }
  return pairs;
}

function mapPair(p) {
  return {
    address: p.baseToken?.address,
    name: p.baseToken?.name || 'Unknown',
    symbol: p.baseToken?.symbol || '???',
    priceUsd: p.priceUsd || null,
    priceChange1h: p.priceChange?.h1 ?? null,
    priceChange24h: p.priceChange?.h24 ?? null,
    volume1h: p.volume?.h1 || 0,
    volume24h: p.volume?.h24 || 0,
    liquidity: p.liquidity?.usd || 0,
    buys1h: p.txns?.h1?.buys || 0,
    sells1h: p.txns?.h1?.sells || 0,
    pairCreatedAt: p.pairCreatedAt || null,
    pairUrl: p.url || `https://dexscreener.com/base/${p.baseToken?.address}`,
    dexId: p.dexId || 'unknown',
  };
}

function quickRisk(liq) {
  if (liq <= 0)      return 'UNKNOWN';
  if (liq < 10000)   return 'HIGH RISK';
  if (liq < 50000)   return 'CAUTION';
  return 'SAFE';
}

function deriveNewTokens(pairs) {
  const now = Date.now();
  const thirtyDays = 30 * 86400 * 1000;

  const withDate = pairs
    .filter(p => p.pairCreatedAt)
    .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));

  // Prefer last-30-day tokens; fall back to all sorted by newest
  const recent = withDate.filter(p => (now - p.pairCreatedAt) < thirtyDays);
  const pool = recent.length >= 5 ? recent : withDate;

  return pool.slice(0, 20).map(p => ({
    ...mapPair(p),
    pairAgeMs: now - (p.pairCreatedAt || now),
    risk: quickRisk(p.liquidity?.usd || 0),
  }));
}

function deriveTrending(pairs) {
  return pairs
    .filter(p => (p.volume?.h24 || 0) > 100)
    .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
    .slice(0, 20)
    .map(mapPair); // mapPair already includes volume1h, buys1h, sells1h
}

function deriveWhales(pairs) {
  return pairs
    .filter(p => (p.volume?.h1 || 0) > 5000)
    .sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0))
    .slice(0, 15)
    .map(mapPair);
}

// Live activity: any non-stablecoin Base token with liquidity >= 1k and some 24h volume
function deriveLiveActivity(pairs) {
  return pairs
    .filter(p => (p.liquidity?.usd || 0) >= 1000 && (p.volume?.h24 || 0) >= 50)
    .sort((a, b) => {
      // Sort by 1h volume first, fall back to 24h volume
      const va = (b.volume?.h1 || 0) || (b.volume?.h24 || 0) / 24;
      const vb = (a.volume?.h1 || 0) || (a.volume?.h24 || 0) / 24;
      return va - vb;
    })
    .slice(0, 50)
    .map(mapPair);
}

async function generateCommentary(data, apiKey) {
  if (!apiKey) return '';
  const now = Date.now();
  if (commentaryCache.text && now - commentaryCache.ts < COMMENTARY_TTL) {
    return commentaryCache.text;
  }

  const topWhale = data.whaleActivity?.[0];
  const topTrend = data.trending?.[0];
  const newCount = data.newTokens?.length || 0;

  const prompt = [
    `${newCount} new token pairs on Base (last 7 days).`,
    topTrend ? `Top trending: $${topTrend.symbol} (${topTrend.priceChange24h != null ? (topTrend.priceChange24h >= 0 ? '+' : '') + topTrend.priceChange24h.toFixed(1) : '?'}% 24h, ${fmtUsd(topTrend.volume24h)} vol).` : '',
    topWhale ? `Highest 1h swap volume: $${topWhale.symbol} with ${fmtUsd(topWhale.volume1h)}, ${topWhale.buys1h} buys vs ${topWhale.sells1h} sells.` : '',
    'Provide 1-2 sentences of live market commentary on Base network right now. Be specific and insightful.',
  ].filter(Boolean).join(' ');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: 'You are a live crypto market analyst monitoring Base network. Respond with 1-2 sentences of direct, insightful commentary. No emojis. No markdown.',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('upstream');
    const resp = await r.json();
    const text = resp.content?.[0]?.text || '';
    if (text) commentaryCache = { text, ts: now };
    return text;
  } catch {
    return commentaryCache.text || '';
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== 'GET') {
    res.writeHead(405, CORS);
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const now = Date.now();
  if (dataCache.data && now - dataCache.ts < DATA_TTL) {
    res.writeHead(200, CORS);
    return res.end(JSON.stringify(dataCache.data));
  }

  const pairs = await fetchBasePairPool();

  const newTokens     = deriveNewTokens(pairs);
  const trending      = deriveTrending(pairs);
  const whaleActivity = deriveWhales(pairs);
  const liveActivity  = deriveLiveActivity(pairs);

  const totalVolume1h = liveActivity.reduce((s, w) => s + (w.volume1h || 0), 0);
  const stats = {
    newTokensCount: newTokens.length,
    trendingCount: trending.length,
    whaleCount: whaleActivity.length,
    liveCount: liveActivity.length,
    totalVolume1h,
    pairsScanned: pairs.length,
    ts: now,
  };

  const commentary = await generateCommentary(
    { newTokens, trending, whaleActivity },
    process.env.ANTHROPIC_API_KEY
  );

  const data = { newTokens, trending, whaleActivity, liveActivity, stats, commentary };
  dataCache = { data, ts: now };

  res.writeHead(200, CORS);
  res.end(JSON.stringify(data));
};
