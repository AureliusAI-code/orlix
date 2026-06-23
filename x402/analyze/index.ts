// Orlix X402 — Token Security Analysis
// Paid endpoint: AI-powered risk analysis for any Base token contract
// Payment handled by Bankr — no x402 imports needed here

const BASE_RPC = 'https://mainnet.base.org';

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d: any = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

function decodeStr(hex: string): string {
  try {
    if (!hex || hex === '0x') return '';
    const raw = hex.slice(2);
    if (raw.length < 128) return '';
    const len = parseInt(raw.slice(64, 128), 16);
    return Buffer.from(raw.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}

function decodeUint(hex: string): string {
  try { return hex && hex !== '0x' ? BigInt(hex).toString() : '0'; } catch { return '0'; }
}

async function getTokenInfo(address: string) {
  const [name, symbol, supply, dec] = await Promise.allSettled([
    rpc('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
  ]);
  const decimals = dec.status === 'fulfilled' ? (parseInt((dec.value as string), 16) || 18) : 18;
  const raw = supply.status === 'fulfilled' ? decodeUint(supply.value as string) : '0';
  const totalSupply = raw !== '0'
    ? (Number(BigInt(raw)) / Math.pow(10, decimals)).toLocaleString()
    : 'Unknown';
  return {
    name:        name.status   === 'fulfilled' ? decodeStr(name.value as string)   : 'Unknown',
    symbol:      symbol.status === 'fulfilled' ? decodeStr(symbol.value as string) : '?',
    decimals,
    totalSupply,
  };
}

async function getDex(address: string) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  if (!r.ok) return null;
  const data: any = await r.json();
  const basePairs = (data.pairs || []).filter((p: any) => p.chainId === 'base');
  const pool = basePairs.length ? basePairs : (data.pairs || []);
  if (!pool.length) return null;
  const best = pool.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const liq  = best.liquidity?.usd || 0;
  const mcap = best.marketCap || best.fdv || 0;
  const buys  = best.txns?.h24?.buys  || 0;
  const sells = best.txns?.h24?.sells || 0;
  return {
    priceUsd:       best.priceUsd ?? null,
    priceChange24h: best.priceChange?.h24 ?? 0,
    liquidityUsd:   liq,
    volume24h:      best.volume?.h24 || 0,
    buys24h:        buys,
    sells24h:       sells,
    buySellRatio:   sells > 0 ? (buys / sells).toFixed(2) : buys > 0 ? '∞' : '0',
    fdv:            best.fdv || 0,
    marketCap:      best.marketCap || 0,
    liqMcapRatio:   mcap > 0 ? ((liq / mcap) * 100).toFixed(1) : null,
    dexId:          best.dexId || 'unknown',
    pairCreatedAt:  best.pairCreatedAt || null,
    chainId:        best.chainId || 'base',
  };
}

async function aiAnalysis(address: string, token: any, dex: any) {
  const key = process.env.BANKR_LLM_KEY || '';
  if (!key) return 'AI analysis unavailable — BANKR_LLM_KEY not set.';

  const priceStr = dex?.priceUsd ? `$${Number(dex.priceUsd).toFixed(8)}` : 'Not listed';
  const ageStr   = dex?.pairCreatedAt
    ? `${Math.floor((Date.now() - dex.pairCreatedAt) / 86400000)} days old`
    : 'Unknown';

  const ctx = [
    `Contract: ${address} (Base network)`,
    `Token: ${token?.name} (${token?.symbol}) | Supply: ${token?.totalSupply}`,
    dex ? [
      `Price: ${priceStr} | 24h change: ${dex.priceChange24h}%`,
      `Liquidity: $${Number(dex.liquidityUsd).toLocaleString()} | Volume 24h: $${Number(dex.volume24h).toLocaleString()}`,
      `Txns 24h: ${dex.buys24h} buys / ${dex.sells24h} sells (ratio: ${dex.buySellRatio})`,
      `FDV: $${Number(dex.fdv).toLocaleString()} | MCap: $${Number(dex.marketCap).toLocaleString()}`,
      dex.liqMcapRatio ? `Liq/MCap: ${dex.liqMcapRatio}% (below 5% = high rug risk)` : '',
      `Pair age: ${ageStr} | DEX: ${dex.dexId}`,
    ].filter(Boolean).join('\n') : 'No DEX listing found.',
  ].join('\n');

  const r = await fetch('https://llm.bankr.bot/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: 'You are a crypto security analyst for Base network tokens. Use **bold** for headers. Be direct and data-driven. Flag risks explicitly.',
      messages: [{
        role: 'user',
        content: `Analyze this Base token:\n\n**🚩 Red Flags**\n• [specific flags or "None detected"]\n\n**✅ Green Flags**\n• [positives or "None detected"]\n\n**⚖️ Verdict: SAFE / CAUTION / HIGH RISK / SCAM LIKELY**\n[One sentence reason]\n\nData:\n${ctx}`,
      }],
    }),
  });
  const d: any = await r.json();
  return d.content?.[0]?.text || 'Analysis unavailable.';
}

export default async function handler(req: Request) {
  const url     = new URL(req.url);
  const address = (url.searchParams.get('address') || '').trim().toLowerCase();

  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) {
    return new Response(JSON.stringify({ error: 'Invalid address — must be 0x + 40 hex chars' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const [tokR, dexR] = await Promise.allSettled([getTokenInfo(address), getDex(address)]);
  const token    = tokR.status === 'fulfilled' ? tokR.value : null;
  const dex      = dexR.status === 'fulfilled' ? dexR.value : null;
  const analysis = await aiAnalysis(address, token, dex);

  return {
    address,
    network: 'base',
    tokenInfo: token,
    dexInfo:   dex,
    analysis,
    timestamp: new Date().toISOString(),
    poweredBy: 'Orlix AI — orlixai.xyz',
  };
}
