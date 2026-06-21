// Orlix Control Room — DexScreener live data for Base network
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

// Known high-volume Base-native tokens to always include
const BASE_ANCHORS = [
  '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', // DEGEN
  '0x532f27101965dd16442e59d40670faf5ebb142e4', // BRETT
  '0x0d97f261b1e88845184f678e2d1e7a98d9fd38de', // TOSHI
  '0xd418db5d367da0a41c09e39a99cde820e0d7b6f', // VIRTUAL
  '0x20dd04c17afad9b0af40038f89ade4534895bfef', // MOCHI
  '0x0578d8a44db98b23bf096a382e016e29a5ce0ffe', // HIGHER
  '0xaaee1a9723aadb7afa2810263653a34ba2c21c7a', // MOG
  '0xcde172dc5ffc46d228838446c57c1227e0b82049', // WELL
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // CBBTC
  '0x6921b130d297cc43754afba22e5eac0fbf8db75b', // OGN/other
];

let dataCache = { data: null, ts: 0 };
let commentaryCache = { text: '', ts: 0 };
const DATA_TTL = 25_000;
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
    headers: { Accept: 'application/json', 'User-Agent': 'Orlix/1.0' },
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
  return true;
}

function mapPair(p) {
  return {
    address: p.baseToken.address,
    name: p.baseToken.name || 'Unknown',
    symbol: p.baseToken.symbol || '???',
    priceUsd: p.priceUsd || null,
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
    pairCreatedAt: p.pairCreatedAt || null,
    pairUrl: p.url || `https://dexscreener.com/base/${p.baseToken.address}`,
    dexId: p.dexId || 'unknown',
    pairName: `${p.baseToken.symbol}/${p.quoteToken?.symbol || '?'}`,
  };
}

async function fetchAllPairs() {
  // Pull trending Base tokens from DexScreener's own featured/boost feeds
  // + a few anchor addresses that are always high-volume on Base
  const [profilesRes, boostsTopRes, boostsLatestRes] = await Promise.all([
    dget('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => null),
    dget('https://api.dexscreener.com/token-boosts/top/v1').catch(() => null),
    dget('https://api.dexscreener.com/token-boosts/latest/v1').catch(() => null),
  ]);

  // Collect Base token addresses from profiles + boosts
  const addrSet = new Set(BASE_ANCHORS.map(a => a.toLowerCase()));
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

  // Batch-fetch pair data in chunks of 30
  const addrList = [...addrSet].slice(0, 150);
  const chunks = [];
  for (let i = 0; i < addrList.length; i += 30) chunks.push(addrList.slice(i, i + 30).join(','));

  const rawPairs = [];
  const batchResults = await Promise.all(
    chunks.map(c => dget(`https://api.dexscreener.com/latest/dex/tokens/${c}`).catch(() => null))
  );
  for (const r of batchResults) {
    if (r?.pairs) rawPairs.push(...r.pairs);
  }

  // Deduplicate by token address — prefer pairs with priceUsd, then highest liquidity
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

  return Object.values(tokenMap).map(mapPair);
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
    (top.length ? `Top movers: ${top.map(t => `$${t.symbol} (${t.priceChange1h != null ? (t.priceChange1h >= 0 ? '+' : '') + t.priceChange1h.toFixed(1) + '%' : '?'} 1h)`).join(', ')}.` : '') +
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

  const allTokens = await fetchAllPairs();

  // Sort by 1h volume desc (most active first), fallback to 24h
  allTokens.sort((a, b) =>
    ((b.volume1h || 0) || (b.volume24h || 0) / 24) -
    ((a.volume1h || 0) || (a.volume24h || 0) / 24)
  );

  const totalVol1h = allTokens.reduce((s, t) => s + (t.volume1h || 0), 0);
  const safeCount = allTokens.filter(t => (t.liquidity || 0) >= 50000).length;

  const stats = {
    total: allTokens.length,
    safeCount,
    totalVol1h,
    ts: now,
  };

  const liveActivity = allTokens;
  const trending = [...allTokens].sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0)).slice(0, 15);

  const commentary = await generateCommentary(allTokens, process.env.ANTHROPIC_API_KEY);

  const data = { liveActivity, trending, stats, commentary };
  dataCache = { data, ts: now };

  res.writeHead(200, CORS);
  res.end(JSON.stringify(data));
};
