// Token Analyzer — Base RPC + DexScreener + AI verdict
const BASE_RPC = 'https://mainnet.base.org';

async function rpc(method, params = []) {
  const r = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

function decodeStr(hex) {
  try {
    if (!hex || hex === '0x') return '';
    const raw = hex.slice(2);
    if (raw.length < 128) return '';
    const len = parseInt(raw.slice(64, 128), 16);
    return Buffer.from(raw.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}
function decodeUint(hex) {
  try { return hex && hex !== '0x' ? BigInt(hex).toString() : '0'; } catch { return '0'; }
}
function decodeU8(hex) {
  try { return hex && hex !== '0x' ? parseInt(hex, 16) : 18; } catch { return 18; }
}

async function getTokenInfo(address) {
  const [name, symbol, supply, dec] = await Promise.allSettled([
    rpc('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
  ]);
  const decimals = dec.status === 'fulfilled' ? decodeU8(dec.value) : 18;
  const raw = supply.status === 'fulfilled' ? decodeUint(supply.value) : '0';
  const totalSupply = raw !== '0'
    ? (Number(BigInt(raw)) / Math.pow(10, decimals)).toLocaleString()
    : 'Unknown';
  return {
    name:        name.status   === 'fulfilled' ? decodeStr(name.value)   : 'Unknown',
    symbol:      symbol.status === 'fulfilled' ? decodeStr(symbol.value) : '?',
    decimals,
    totalSupply,
  };
}

async function getDex(address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) return null;
  const data = await r.json();
  // Prefer Base pairs, fallback to any chain
  const basePairs = (data.pairs || []).filter(p => p.chainId === 'base');
  const allPairs  = data.pairs || [];
  const pool      = basePairs.length ? basePairs : allPairs;
  if (!pool.length) return null;
  const best = pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const priceRaw = best.priceUsd ? Number(best.priceUsd) : 0;
  return {
    priceUsd:        priceRaw > 0 ? best.priceUsd : null,
    priceChange24h:  best.priceChange?.h24 ?? 0,
    liquidityUsd:    best.liquidity?.usd    || 0,
    volume24h:       best.volume?.h24       || 0,
    buys24h:         best.txns?.h24?.buys   || 0,
    sells24h:        best.txns?.h24?.sells  || 0,
    dexId:           best.dexId             || 'unknown',
    pairName:        (best.baseToken?.symbol || '?') + '/' + (best.quoteToken?.symbol || '?'),
    fdv:             best.fdv               || 0,
    pairsCount:      pool.length,
    chainId:         best.chainId           || 'base',
    url:             best.url               || '',
  };
}

async function aiVerdict(address, token, dex) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) return '**AI analysis unavailable** — ANTHROPIC_API_KEY not set.';

  const priceStr = dex?.priceUsd
    ? `$${Number(dex.priceUsd).toFixed(8)}`
    : 'Not listed / no price data';

  const ctx = [
    `Contract: ${address} (Base network)`,
    `Name: ${token?.name} (${token?.symbol})`,
    `Decimals: ${token?.decimals} | Total Supply: ${token?.totalSupply}`,
    dex ? [
      `Price: ${priceStr}`,
      `Price Change 24h: ${dex.priceChange24h}%`,
      `Liquidity: $${Number(dex.liquidityUsd).toLocaleString()}`,
      `Volume 24h: $${Number(dex.volume24h).toLocaleString()}`,
      `Buys / Sells 24h: ${dex.buys24h} / ${dex.sells24h}`,
      `FDV: $${Number(dex.fdv).toLocaleString()}`,
      `DEX: ${dex.dexId} — Pair: ${dex.pairName} — Pairs found: ${dex.pairsCount}`,
    ].join('\n') : 'No DEX listing found (token not traded or very new).',
  ].join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: 'You are a crypto security analyst for tokens on Base network. Use **bold** for section headers. Do NOT use ## or ### markdown. Be direct and concise.',
      messages: [{
        role: 'user',
        content: `Analyze this token. Use exactly this format (bold headers, bullet points):\n\n**📊 Overview**\n[what this token is, 1–2 sentences]\n\n**💧 Liquidity**\n[is it adequate? risk level?]\n\n**🚩 Red Flags**\n• [each flag on its own line, or write: None detected]\n\n**📈 Buy/Sell Pressure**\n[what the 24h transaction pattern suggests]\n\n**⚖️ Verdict: SAFE / CAUTION / HIGH RISK / SCAM LIKELY**\n[one sentence reason]\n\nData:\n${ctx}`,
      }],
    }),
  });
  const d = await r.json();
  return d.content?.[0]?.text || 'Analysis unavailable.';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const address = ((req.query.address || '') + '').trim().toLowerCase();
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) {
    return res.status(400).json({ error: 'Invalid address — must be 0x + 40 hex chars.' });
  }

  try {
    const [tokR, dexR] = await Promise.allSettled([getTokenInfo(address), getDex(address)]);
    const token    = tokR.status === 'fulfilled' ? tokR.value : null;
    const dex      = dexR.status === 'fulfilled' ? dexR.value : null;
    const analysis = await aiVerdict(address, token, dex);
    return res.json({ address, tokenInfo: token, dexInfo: dex, analysis, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
