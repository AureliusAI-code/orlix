// x402 paid endpoint — Base Wallet Analyzer
// $0.03 USDC per request (Base network, USDC)
// Builder Code: bc_cxvityc7

const { withX402 }           = require('./_x402guard');
const { getOrlixTier, withTier } = require('./_orlix-tier');

const BASE_RPC       = 'https://mainnet.base.org';
const ORLIX_CONTRACT = '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3';

async function rpc(method, params = []) {
  const r = await fetch(BASE_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(8000),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

async function getErc20Balance(token, wallet) {
  const data = '0x70a08231' + wallet.replace('0x', '').toLowerCase().padStart(64, '0');
  const hex  = await rpc('eth_call', [{ to: token, data }, 'latest']);
  return hex && hex !== '0x' ? BigInt(hex).toString() : '0';
}

async function getRecentSwaps(wallet, limit) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${wallet}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.pairs || []).slice(0, limit).map(p => ({
      pair:     `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
      dex:      p.dexId,
      price:    p.priceUsd,
      volume1h: p.volume?.h1 || 0,
    }));
  } catch { return []; }
}

const coreHandler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const target = ((req.query?.address || req.query?.wallet || '') + '').trim().toLowerCase();
  const caller = ((req.query?.caller || target) + '').trim().toLowerCase();

  if (!target || !/^0x[0-9a-f]{40}$/i.test(target)) {
    return res.status(400).json({
      error:   'address required',
      usage:   'GET /api/x402-wallet?address=0xWallet&caller=0xYourWallet',
      example: '/api/x402-wallet?address=0xd4d2a64d506c98b118c039d9c3eaf5442bf3e1b8',
    });
  }

  const tier = await getOrlixTier(caller || null);

  try {
    const [ethHex, orlixRaw, chainIdHex, blockHex, gasPriceHex] = await Promise.all([
      rpc('eth_getBalance',  [target, 'latest']),
      getErc20Balance(ORLIX_CONTRACT, target),
      rpc('eth_chainId',    []),
      rpc('eth_blockNumber',[]),
      rpc('eth_gasPrice',   []),
    ]);

    const ethWei       = BigInt(ethHex || '0x0');
    const ethBalance   = (Number(ethWei) / 1e18).toFixed(6);
    const orlixWei     = BigInt(orlixRaw || '0');
    const orlixBalance = (Number(orlixWei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const chainId      = parseInt(chainIdHex, 16);
    const blockNum     = parseInt(blockHex, 16);
    const gasPriceGwei = (parseInt(gasPriceHex, 16) / 1e9).toFixed(4);

    const walletTier   = await getOrlixTier(target);
    const recentSwaps  = tier.tier !== 'NONE' ? await getRecentSwaps(target, Math.min(tier.results, 10)) : [];

    let aiSummary = '';
    const llmKey  = process.env.BANKR_LLM_KEY || '';
    if (tier.tier !== 'NONE' && llmKey) {
      try {
        const prompt = `Wallet ${target} on Base: ${ethBalance} ETH, ${orlixBalance} ORLIX. Holder tier: ${walletTier.label}. Block: ${blockNum}. Gas: ${gasPriceGwei} gwei. Write a 2-sentence wallet profile. Be specific. No emojis.`;
        const r = await fetch('https://llm.bankr.bot/v1/messages', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': llmKey, 'anthropic-version': '2023-06-01' },
          body:    JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: 'You are a blockchain analyst.', messages: [{ role: 'user', content: prompt }] }),
          signal:  AbortSignal.timeout(10000),
        });
        const d = await r.json();
        aiSummary = d.content?.[0]?.text || '';
      } catch { /* best effort */ }
    }

    return res.json(withTier({
      address:  target,
      network:  { name: 'Base Mainnet', chainId, latestBlock: blockNum, gasPriceGwei },
      balances: {
        eth:   { raw: ethWei.toString(),   formatted: ethBalance + ' ETH' },
        orlix: { raw: orlixWei.toString(), formatted: orlixBalance + ' ORLIX', tier: walletTier.label },
      },
      recentSwaps: recentSwaps.length ? recentSwaps : (tier.tier === 'NONE' ? 'Hold $ORLIX to unlock recent activity' : []),
      aiSummary:   aiSummary || (tier.tier === 'NONE' ? 'Hold $ORLIX to unlock AI wallet analysis' : ''),
      basescan:    `https://basescan.org/address/${target}`,
      timestamp:   new Date().toISOString(),
      poweredBy:   'Orlix AI — orlixai.xyz',
    }, tier));
  } catch (e) {
    return res.status(502).json({ error: 'Service temporarily unavailable.' });
  }
};

module.exports = withX402(coreHandler, {
  path:       '/api/x402-wallet',
  amountUsdc: 0.03,
  description: 'Base wallet analysis — ETH/ORLIX balances, holder tier, recent swaps, AI portfolio summary',
});
