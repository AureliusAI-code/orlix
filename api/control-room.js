// Orlix Control Room — live Base network intelligence
// Stablecoins and wrapped assets to exclude from all panels
const EXCLUDE_SYMBOLS = new Set([
  'USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB',
  'EURC','CRVUSD','LUSD','FRAX','SUSD','BUSD','GUSD','TUSD',
  'AERO','RETH','STETH','WSTETH',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

let dataCache = { data: null, ts: 0 };
let commentaryCache = { text: '', ts: 0 };
const DATA_TTL = 30_000;
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

// Fetch a large pool of Base pairs via multiple searches
async function fetchBasePairPool() {
  const queries = ['USDC', 'ETH', 'WETH', 'DAI', 'USDT'];
  const results = await Promise.allSettled(
    queries.map(q =>
      dget(`https://api.dexscreener.com/latest/dex/search?q=${q}&chainIds=base`)
    )
  );

  const seen = new Set();
  const pairs = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const p of r.value.pairs || []) {
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

  const newTokens    = deriveNewTokens(pairs);
  const trending     = deriveTrending(pairs);
  const whaleActivity = deriveWhales(pairs);

  const totalVolume1h = whaleActivity.reduce((s, w) => s + (w.volume1h || 0), 0);
  const stats = {
    newTokensCount: newTokens.length,
    trendingCount: trending.length,
    whaleCount: whaleActivity.length,
    totalVolume1h,
    pairsScanned: pairs.length,
    ts: now,
  };

  const commentary = await generateCommentary(
    { newTokens, trending, whaleActivity },
    process.env.ANTHROPIC_API_KEY
  );

  const data = { newTokens, trending, whaleActivity, stats, commentary };
  dataCache = { data, ts: now };

  res.writeHead(200, CORS);
  res.end(JSON.stringify(data));
};
