// api/analyze.js
const BASE_RPC = 'https://mainnet.base.org';

async function rpcCall(method, params = []) {
  const r = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

async function ethCall(to, data) {
  const result = await rpcCall('eth_call', [{ to, data }, 'latest']);
  return result;
}

function decodeString(hex) {
  // ABI decode string from eth_call result
  try {
    if (!hex || hex === '0x') return '';
    // Remove 0x prefix and skip offset (first 32 bytes) and length (next 32 bytes)
    const raw = hex.slice(2);
    if (raw.length < 128) return '';
    const lenHex = raw.slice(64, 128);
    const len = parseInt(lenHex, 16);
    const strHex = raw.slice(128, 128 + len * 2);
    return Buffer.from(strHex, 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}

function decodeUint256(hex) {
  try {
    if (!hex || hex === '0x') return '0';
    return BigInt(hex).toString();
  } catch { return '0'; }
}

function decodeUint8(hex) {
  try {
    if (!hex || hex === '0x') return 18;
    return parseInt(hex, 16);
  } catch { return 18; }
}

async function getTokenInfo(address) {
  const [nameHex, symbolHex, supplyHex, decimalsHex] = await Promise.allSettled([
    ethCall(address, '0x06fdde03'), // name()
    ethCall(address, '0x95d89b41'), // symbol()
    ethCall(address, '0x18160ddd'), // totalSupply()
    ethCall(address, '0x313ce567'), // decimals()
  ]);
  const decimals = decimalsHex.status === 'fulfilled' ? decodeUint8(decimalsHex.value) : 18;
  const rawSupply = supplyHex.status === 'fulfilled' ? decodeUint256(supplyHex.value) : '0';
  const supply = rawSupply !== '0' ? (Number(BigInt(rawSupply)) / Math.pow(10, decimals)).toLocaleString() : 'Unknown';
  return {
    name: nameHex.status === 'fulfilled' ? decodeString(nameHex.value) : 'Unknown',
    symbol: symbolHex.status === 'fulfilled' ? decodeString(symbolHex.value) : 'Unknown',
    decimals,
    totalSupply: supply,
  };
}

async function getDexScreener(address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { 'Accept': 'application/json' }
  });
  if (!r.ok) return null;
  const data = await r.json();
  const pairs = data.pairs || [];
  if (!pairs.length) return null;
  // Get the most liquid pair
  const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return {
    priceUsd: best.priceUsd || '0',
    priceChange24h: best.priceChange?.h24 || 0,
    liquidityUsd: best.liquidity?.usd || 0,
    volume24h: best.volume?.h24 || 0,
    txns24h: (best.txns?.h24?.buys || 0) + (best.txns?.h24?.sells || 0),
    buys24h: best.txns?.h24?.buys || 0,
    sells24h: best.txns?.h24?.sells || 0,
    dexId: best.dexId || 'unknown',
    pairAddress: best.pairAddress || '',
    pairName: best.baseToken?.symbol + '/' + best.quoteToken?.symbol,
    fdv: best.fdv || 0,
    allPairsCount: pairs.length,
    chainId: best.chainId || 'base',
  };
}

async function aiAnalysis(address, tokenInfo, dexInfo) {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) return 'AI analysis unavailable (ANTHROPIC_API_KEY not set).';

  const context = `
Token Contract: ${address}
Name: ${tokenInfo?.name || 'Unknown'} (${tokenInfo?.symbol || '?'})
Decimals: ${tokenInfo?.decimals}
Total Supply: ${tokenInfo?.totalSupply}
${dexInfo ? `
Price: $${dexInfo.priceUsd}
Price Change 24h: ${dexInfo.priceChange24h}%
Liquidity: $${dexInfo.liquidityUsd?.toLocaleString()}
Volume 24h: $${dexInfo.volume24h?.toLocaleString()}
Transactions 24h: ${dexInfo.txns24h} (${dexInfo.buys24h} buys / ${dexInfo.sells24h} sells)
FDV: $${dexInfo.fdv?.toLocaleString()}
DEX: ${dexInfo.dexId}
Trading Pair: ${dexInfo.pairName}
Number of pairs: ${dexInfo.allPairsCount}
` : 'No DEX data found (not listed on any DEX or very new).'}
`.trim();

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: 'You are a crypto security analyst specializing in token analysis on Base network. Analyze the provided token data and give a clear, structured assessment.',
      messages: [{
        role: 'user',
        content: `Analyze this token on Base network and provide:\n1. **Overview** - what this token appears to be\n2. **Liquidity Assessment** - is liquidity adequate? Risk level?\n3. **Red Flags** - list any suspicious indicators (if none, say so)\n4. **Buy/Sell Pressure** - what do the 24h transaction patterns suggest?\n5. **Verdict** - SAFE / CAUTION / HIGH RISK / SCAM LIKELY with brief reason\n\nToken Data:\n${context}`
      }]
    })
  });
  const data = await r.json();
  return data.content?.[0]?.text || 'Analysis failed.';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const address = ((req.query.address || '') + '').toLowerCase().trim();
  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) {
    return res.status(400).json({ error: 'Invalid contract address. Must be 0x followed by 40 hex characters.' });
  }

  try {
    const [tokenResult, dexResult] = await Promise.allSettled([
      getTokenInfo(address),
      getDexScreener(address),
    ]);
    const tokenInfo = tokenResult.status === 'fulfilled' ? tokenResult.value : null;
    const dexInfo   = dexResult.status   === 'fulfilled' ? dexResult.value   : null;
    const analysis  = await aiAnalysis(address, tokenInfo, dexInfo);

    return res.json({ address, tokenInfo, dexInfo, analysis, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
