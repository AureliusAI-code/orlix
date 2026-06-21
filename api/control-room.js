// Orlix Control Room — live Base network intelligence aggregator
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

let dataCache = { data: null, ts: 0 };
let commentaryCache = { text: '', ts: 0 };
const DATA_TTL = 30_000;
const COMMENTARY_TTL = 300_000; // 5 minutes

function shortenAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'Unknown';
}

function fmtUsd(n) {
  if (!n && n !== 0) return '—';
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

async function batchDex(addresses) {
  if (!addresses.length) return {};
  const addrs = addresses.slice(0, 30).join(',');
  try {
    const data = await dget(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`);
    const map = {};
    for (const p of data.pairs || []) {
      if (p.chainId !== 'base') continue;
      const key = (p.baseToken?.address || '').toLowerCase();
      if (!map[key] || (p.liquidity?.usd || 0) > (map[key].liquidity?.usd || 0)) {
        map[key] = p;
      }
    }
    return map;
  } catch { return {}; }
}

async function fetchNewTokens() {
  try {
    const data = await dget('https://api.dexscreener.com/token-profiles/latest/v1');
    const tokens = (Array.isArray(data) ? data : [])
      .filter(t => t.chainId === 'base')
      .slice(0, 20);
    if (!tokens.length) return [];

    const pairMap = await batchDex(tokens.map(t => t.tokenAddress).filter(Boolean));

    return tokens.map(t => {
      const pair = pairMap[(t.tokenAddress || '').toLowerCase()];
      const liq = pair?.liquidity?.usd || 0;
      return {
        address: t.tokenAddress,
        name: t.header || shortenAddr(t.tokenAddress),
        description: (t.description || '').slice(0, 100),
        icon: t.icon || null,
        links: (t.links || []).slice(0, 4),
        priceUsd: pair?.priceUsd || null,
        liquidity: liq,
        volume24h: pair?.volume?.h24 || 0,
        priceChange24h: pair?.priceChange?.h24 ?? null,
        pairUrl: pair?.url || `https://dexscreener.com/base/${t.tokenAddress}`,
        risk: liq <= 0 ? 'UNKNOWN' : liq < 10000 ? 'HIGH RISK' : liq < 50000 ? 'CAUTION' : 'SAFE',
      };
    });
  } catch { return []; }
}

async function fetchTrending() {
  // Primary: token boosts
  try {
    const data = await dget('https://api.dexscreener.com/token-boosts/top/v1');
    const tokens = (Array.isArray(data) ? data : []).filter(t => t.chainId === 'base').slice(0, 15);
    if (tokens.length > 0) {
      const pairMap = await batchDex(tokens.map(t => t.tokenAddress).filter(Boolean));
      return tokens.map(t => {
        const pair = pairMap[(t.tokenAddress || '').toLowerCase()];
        return {
          address: t.tokenAddress,
          name: t.description || pair?.baseToken?.name || shortenAddr(t.tokenAddress),
          symbol: pair?.baseToken?.symbol || '???',
          icon: t.icon || null,
          priceUsd: pair?.priceUsd || null,
          priceChange1h: pair?.priceChange?.h1 ?? null,
          priceChange24h: pair?.priceChange?.h24 ?? null,
          volume24h: pair?.volume?.h24 || 0,
          liquidity: pair?.liquidity?.usd || 0,
          pairUrl: pair?.url || `https://dexscreener.com/base/${t.tokenAddress}`,
        };
      }).sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
    }
  } catch { /* fall through */ }

  // Fallback: search active USDC pairs on Base
  try {
    const data = await dget('https://api.dexscreener.com/latest/dex/search?q=USDC&chainIds=base');
    return (data.pairs || [])
      .filter(p => p.chainId === 'base')
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0))
      .slice(0, 15)
      .map(p => ({
        address: p.baseToken?.address,
        name: p.baseToken?.name || 'Unknown',
        symbol: p.baseToken?.symbol || '???',
        icon: null,
        priceUsd: p.priceUsd,
        priceChange1h: p.priceChange?.h1 ?? null,
        priceChange24h: p.priceChange?.h24 ?? null,
        volume24h: p.volume?.h24 || 0,
        liquidity: p.liquidity?.usd || 0,
        pairUrl: p.url,
      }));
  } catch { return []; }
}

async function fetchWhaleActivity() {
  try {
    const [r1, r2] = await Promise.allSettled([
      dget('https://api.dexscreener.com/latest/dex/search?q=ETH&chainIds=base'),
      dget('https://api.dexscreener.com/latest/dex/search?q=WETH&chainIds=base'),
    ]);

    const seen = new Set();
    const pairs = [];
    for (const r of [r1, r2]) {
      if (r.status === 'fulfilled') {
        for (const p of r.value.pairs || []) {
          if (p.chainId === 'base' && !seen.has(p.pairAddress)) {
            seen.add(p.pairAddress);
            pairs.push(p);
          }
        }
      }
    }

    return pairs
      .filter(p => (p.volume?.h1 || 0) > 20000)
      .sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0))
      .slice(0, 15)
      .map(p => ({
        token: p.baseToken?.symbol || '???',
        name: p.baseToken?.name || 'Unknown',
        address: p.baseToken?.address,
        volume1h: p.volume?.h1 || 0,
        volume24h: p.volume?.h24 || 0,
        buys1h: p.txns?.h1?.buys || 0,
        sells1h: p.txns?.h1?.sells || 0,
        priceChange1h: p.priceChange?.h1 || 0,
        priceUsd: p.priceUsd,
        liquidity: p.liquidity?.usd || 0,
        pairUrl: p.url,
      }));
  } catch { return []; }
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
    `${newCount} new tokens launched on Base recently.`,
    topTrend ? `Top trending: $${topTrend.symbol} (${topTrend.priceChange24h != null ? (topTrend.priceChange24h >= 0 ? '+' : '') + topTrend.priceChange24h.toFixed(1) : '?'}% 24h, ${fmtUsd(topTrend.volume24h)} vol).` : '',
    topWhale ? `Highest 1h swap activity: $${topWhale.token} with ${fmtUsd(topWhale.volume1h)} volume, ${topWhale.buys1h} buys vs ${topWhale.sells1h} sells.` : '',
    'Give a concise 1-2 sentence live market commentary on Base ecosystem activity right now. Be specific and insightful.',
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
    if (!r.ok) throw new Error('upstream error');
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

  const [newTokens, trending, whaleActivity] = await Promise.all([
    fetchNewTokens(),
    fetchTrending(),
    fetchWhaleActivity(),
  ]);

  const totalVolume1h = whaleActivity.reduce((s, w) => s + (w.volume1h || 0), 0);
  const stats = {
    newTokensCount: newTokens.length,
    trendingCount: trending.length,
    whaleCount: whaleActivity.length,
    totalVolume1h,
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
