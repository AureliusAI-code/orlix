// Orlix X402 — Token Security Analyzer
// AI-powered risk verdict for any Base token. $ORLIX holders get deeper analysis.

import { getOrlixTier, withTier } from '../_shared/holder';

const BASE_RPC = 'https://mainnet.base.org';

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
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

async function getTokenInfo(address: string) {
  const [name, symbol, supply, dec] = await Promise.allSettled([
    rpc('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']),
    rpc('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
  ]);
  const decimals = dec.status === 'fulfilled' ? (parseInt(dec.value as string, 16) || 18) : 18;
  const raw      = supply.status === 'fulfilled' ? (supply.value as string) : '0x0';
  const rawBig   = raw && raw !== '0x' ? BigInt(raw) : 0n;
  return {
    name:        name.status   === 'fulfilled' ? decodeStr(name.value   as string) : 'Unknown',
    symbol:      symbol.status === 'fulfilled' ? decodeStr(symbol.value as string) : '?',
    decimals,
    totalSupply: rawBig > 0n ? (Number(rawBig) / Math.pow(10, decimals)).toLocaleString() : 'Unknown',
  };
}

async function getDex(address: string) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const data: any = await r.json();
  const basePairs = (data.pairs || []).filter((p: any) => p.chainId === 'base');
  const pool      = basePairs.length ? basePairs : (data.pairs || []);
  if (!pool.length) return null;
  const best      = pool.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const liq       = best.liquidity?.usd || 0;
  const mcap      = best.marketCap || best.fdv || 0;
  const buys      = best.txns?.h24?.buys  || 0;
  const sells     = best.txns?.h24?.sells || 0;
  return {
    priceUsd:       best.priceUsd ?? null,
    priceChange1h:  best.priceChange?.h1  ?? null,
    priceChange6h:  best.priceChange?.h6  ?? null,
    priceChange24h: best.priceChange?.h24 ?? null,
    liquidityUsd:   liq,
    volume1h:       best.volume?.h1  || 0,
    volume6h:       best.volume?.h6  || 0,
    volume24h:      best.volume?.h24 || 0,
    buys24h:        buys,
    sells24h:       sells,
    buySellRatio:   sells > 0 ? (buys / sells).toFixed(2) : buys > 0 ? '∞' : '0',
    fdv:            best.fdv || 0,
    marketCap:      best.marketCap || 0,
    liqMcapRatio:   mcap > 0 ? ((liq / mcap) * 100).toFixed(1) : null,
    dexId:          best.dexId || 'unknown',
    pairsCount:     pool.length,
    pairCreatedAt:  best.pairCreatedAt || null,
    chainId:        best.chainId || 'base',
    pairUrl:        best.url || '',
  };
}

async function aiAnalysis(address: string, token: any, dex: any, maxTokens: number, holderTier: string) {
  const key = process.env.ORLIX_LLM_KEY || process.env.BANKR_LLM_KEY || '';
  if (!key) return 'AI analysis unavailable.';

  const priceStr = dex?.priceUsd
    ? `$${Number(dex.priceUsd) < 0.0001 ? Number(dex.priceUsd).toFixed(10) : Number(dex.priceUsd).toFixed(6)}`
    : 'Not listed';
  const ageStr   = dex?.pairCreatedAt
    ? `${Math.floor((Date.now() - dex.pairCreatedAt) / 86400000)} days old`
    : 'Unknown';

  const ctx = [
    `Contract: ${address} (Base)`,
    `Token: ${token?.name} (${token?.symbol}) | Supply: ${token?.totalSupply}`,
    dex ? [
      `Price: ${priceStr} | 1h: ${dex.priceChange1h ?? 'N/A'}% | 6h: ${dex.priceChange6h ?? 'N/A'}% | 24h: ${dex.priceChange24h ?? 'N/A'}%`,
      `Liquidity: $${Number(dex.liquidityUsd).toLocaleString()} | Volume 24h: $${Number(dex.volume24h).toLocaleString()}`,
      `Txns 24h: ${dex.buys24h} buys / ${dex.sells24h} sells (ratio: ${dex.buySellRatio})`,
      `FDV: $${Number(dex.fdv).toLocaleString()} | MCap: $${Number(dex.marketCap).toLocaleString()}`,
      dex.liqMcapRatio ? `Liq/MCap: ${dex.liqMcapRatio}% (below 5% = high rug risk)` : '',
      `Pair age: ${ageStr} | DEX: ${dex.dexId} | Total pairs: ${dex.pairsCount}`,
    ].filter(Boolean).join('\n') : 'No DEX listing.',
  ].join('\n');

  // Holders get extended analysis
  const isHolder  = holderTier !== 'NONE';
  const extraInst = isHolder
    ? '\n\nAdditional sections for verified holder (include all):\n**💰 Price Action**\n[1h/6h/24h trend analysis]\n\n**🐋 Whale Risk**\n[supply concentration analysis based on available data]'
    : '';

  const r = await fetch('https://llm.bankr.bot/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: 'You are a crypto security analyst for Base network tokens. Use **bold** for headers. Be direct, specific, and data-driven. Flag risks explicitly.',
      messages: [{
        role: 'user',
        content: `Analyze this Base token:\n\n**🚩 Red Flags**\n• [specific flags with data, or "None detected"]\n\n**✅ Green Flags**\n• [positives with data, or "None detected"]\n\n**💧 Liquidity**\n[Liq/MCap ratio interpretation]\n\n**⚖️ Verdict: SAFE / CAUTION / HIGH RISK / SCAM LIKELY**\n[One sentence reason]${extraInst}\n\nData:\n${ctx}`,
      }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const d: any = await r.json();
  return d.content?.[0]?.text || 'Analysis unavailable.';
}

export default async function handler(req: Request) {
  const url     = new URL(req.url);
  const address = (url.searchParams.get('address') || '').trim().toLowerCase();
  const wallet  = url.searchParams.get('wallet') || null;

  if (!address || !/^0x[0-9a-f]{40}$/i.test(address)) {
    return new Response(JSON.stringify({
      error:   'Invalid address',
      usage:   'GET /analyze?address=0x...&wallet=0x... (wallet optional — $ORLIX holders get deeper analysis)',
      example: '/analyze?address=0xContractAddress&wallet=0xYourWallet',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const tier = await getOrlixTier(wallet);

  const [tokR, dexR] = await Promise.allSettled([getTokenInfo(address), getDex(address)]);
  const token    = tokR.status === 'fulfilled' ? tokR.value : null;
  const dex      = dexR.status === 'fulfilled' ? dexR.value : null;
  const analysis = await aiAnalysis(address, token, dex, tier.maxTokens, tier.tier);

  return withTier({
    address,
    network:   'base',
    tokenInfo: token,
    dexInfo:   dex,
    analysis,
    timestamp: new Date().toISOString(),
    poweredBy: 'Orlix AI — orlixai.xyz',
  }, tier);
}
