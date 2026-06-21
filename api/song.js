// /api/song.js — generate song lyrics for a Base token using real DexScreener data
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function fetchTokenData(query) {
  // Try as address first, then as symbol search
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(query.trim());

  let pairs = [];

  if (isAddress) {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${query.trim()}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Orlix/1.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const d = await r.json();
      pairs = (d.pairs || []).filter(p => p.chainId === 'base');
    }
  } else {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Orlix/1.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const d = await r.json();
      pairs = (d.pairs || []).filter(p => p.chainId === 'base');
    }
  }

  if (!pairs.length) return null;

  // Pick highest liquidity pair
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];

  return {
    symbol: p.baseToken?.symbol || query,
    name: p.baseToken?.name || query,
    address: p.baseToken?.address || '',
    priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : null,
    priceChange1h: p.priceChange?.h1 ?? null,
    priceChange24h: p.priceChange?.h24 ?? null,
    volume24h: p.volume?.h24 || 0,
    liquidity: p.liquidity?.usd || 0,
    marketCap: p.marketCap || p.fdv || 0,
    buys24h: p.txns?.h24?.buys || 0,
    sells24h: p.txns?.h24?.sells || 0,
    dexId: p.dexId || 'unknown',
    pairUrl: p.url || `https://dexscreener.com/base/${p.baseToken?.address}`,
  };
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

function buildPrompt(token, genre) {
  const price = token.priceUsd ? `$${token.priceUsd < 0.001 ? token.priceUsd.toExponential(2) : token.priceUsd.toFixed(token.priceUsd < 1 ? 4 : 2)}` : 'unknown price';
  const chg24 = token.priceChange24h != null ? `${token.priceChange24h >= 0 ? '+' : ''}${token.priceChange24h.toFixed(1)}%` : 'unknown';
  const vol = formatNumber(token.volume24h);
  const liq = formatNumber(token.liquidity);
  const mc = formatNumber(token.marketCap);
  const pressure = token.buys24h + token.sells24h > 0
    ? `${Math.round(token.buys24h / (token.buys24h + token.sells24h) * 100)}% buy pressure`
    : '';

  const genreInstructions = {
    trap: 'aggressive trap/hip-hop lyrics with hard bars, money references, flexing. Use slang: "on chain", "ape in", "moon", "bag", "gm". Flow should be punchy with internal rhymes.',
    phonk: 'dark phonk/drift rap lyrics. Mysterious, hypnotic, aggressive. Russian drift culture meets crypto. Dark imagery. Short punchy lines.',
    pop: 'catchy pop song with a big chorus that sticks. Uplifting, hopeful, melodic feel. Think anthemic. References to "to the moon", diamond hands, community.',
    drill: 'UK/Chicago drill style. Dark, menacing bars about the streets of crypto. Talk about rugging competitors, holding bags, not selling. Gritty.',
    hype: 'insane hype/energy song like a sports anthem. CAPS for emphasis. Battle cry energy. Crowd chant moments. Pure adrenaline.',
    ballad: 'emotional ballad about the journey of holding a volatile crypto token. Bittersweet. Joy of pumps, pain of dips. Longing for ATH.',
  };

  return `You are a creative songwriter. Write original song lyrics for a cryptocurrency token called $${token.symbol} (${token.name}) on Base network.

Token stats (use these naturally in lyrics, don't just list them):
- Price: ${price} (24h change: ${chg24})
- 24h volume: $${vol}
- Liquidity: $${liq}
- Market cap: $${mc}
${pressure ? `- ${pressure}` : ''}
${token.priceChange1h != null ? `- 1h change: ${token.priceChange1h >= 0 ? '+' : ''}${token.priceChange1h.toFixed(1)}%` : ''}

Style: ${genreInstructions[genre] || genreInstructions.trap}

Structure the song with:
[Verse 1]
(4-8 lines)

[Chorus]
(4-6 lines — catchy, repeatable)

[Verse 2]
(4-8 lines — reference the actual price/volume stats)

[Chorus]
(repeat)

[Bridge or Outro]
(2-4 lines — strong finish)

Rules:
- Write ONLY in English
- Make it genuinely creative and funny/hype
- Weave in the REAL stats naturally (the price, the % change, the volume)
- Include the token symbol $${token.symbol} multiple times
- Reference Base network or "on Base"
- NO generic filler — make every line count
- Do NOT add any commentary before or after the lyrics, just output the song`;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'POST only' })); }

  let body = '';
  await new Promise((resolve, reject) => {
    req.on('data', d => { body += d; });
    req.on('end', resolve);
    req.on('error', reject);
  });

  let query, genre;
  try { ({ query, genre } = JSON.parse(body)); } catch { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

  if (!query?.trim()) { res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Missing token query' })); }
  genre = genre || 'trap';

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.writeHead(503, CORS); return res.end(JSON.stringify({ error: 'AI not configured' })); }

  // Fetch token data
  let token = null;
  try { token = await fetchTokenData(query); } catch {}

  if (!token) {
    // Fallback: use the query as-is with no stats
    token = { symbol: query.toUpperCase().replace('$', ''), name: query, priceUsd: null, priceChange24h: null, volume24h: 0, liquidity: 0, marketCap: 0, buys24h: 0, sells24h: 0 };
  }

  const prompt = buildPrompt(token, genre);

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
        max_tokens: 1024,
        system: 'You are a creative, witty songwriter who specializes in crypto culture music. You ALWAYS write in English only. You write genuinely funny, hype, and creative lyrics that reference real token stats.',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!r.ok) throw new Error(`Claude API ${r.status}`);
    const data = await r.json();
    const lyrics = data.content?.[0]?.text || '';

    res.writeHead(200, CORS);
    res.end(JSON.stringify({ lyrics, token, genre }));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message }));
  }
};
