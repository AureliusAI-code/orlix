// Vercel Serverless — /api/stake
// Checks ORLIX wallet balance + staking tier
// Returns tier info, daily credits, and staking status

const { getOrlixTier, withTier, STAKING_TIERS } = require('./_shared/holder');

const BASE_RPC          = 'https://mainnet.base.org';
const ORLIX_CONTRACT    = '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3';
// Set STAKING_CONTRACT env var once the ORLIXStaking contract is deployed
const STAKING_CONTRACT  = process.env.STAKING_CONTRACT || null;

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

// Call getStake(address) on staking contract
// Returns (amount, unlocksAt, unlocked, tier)
async function getStakeInfo(wallet) {
  if (!STAKING_CONTRACT) return null;

  try {
    // getStake(address) selector
    const data = '0x7a766460' + wallet.replace('0x', '').toLowerCase().padStart(64, '0');
    const hex  = await rpc('eth_call', [{ to: STAKING_CONTRACT, data }, 'latest']);
    if (!hex || hex === '0x') return null;

    const raw      = hex.slice(2);
    const amount   = BigInt('0x' + raw.slice(0, 64));
    const unlockTs = BigInt('0x' + raw.slice(64, 128));
    const unlocked = BigInt('0x' + raw.slice(128, 192)) === 1n;
    const stakeTier = Number(BigInt('0x' + raw.slice(192, 256)));

    const amtFmt   = (Number(amount / 10n ** 15n) / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const unlockDt = unlockTs > 0n ? new Date(Number(unlockTs) * 1000).toISOString() : null;

    const CREDITS = { 0: 0, 1: 3, 2: 5, 3: 10 };

    return {
      staked:       amtFmt + ' ORLIX',
      stakedRaw:    amount.toString(),
      unlocksAt:    unlockDt,
      unlocked,
      stakeTier,
      dailyCredits: CREDITS[stakeTier] || 0,
      tierLabel:    stakeTier > 0 ? `Staker Tier ${stakeTier}` : null,
    };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wallet');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const wallet = (req.query.wallet || req.headers['x-wallet'] || '').trim();
  if (!wallet || !/^0x[0-9a-f]{40}$/i.test(wallet)) {
    return res.status(400).json({ error: 'Missing or invalid wallet address' });
  }

  try {
    const [tier, stakeInfo] = await Promise.all([
      getOrlixTier(wallet),
      getStakeInfo(wallet),
    ]);

    return res.status(200).json({
      wallet,
      holder: {
        tier:         tier.tier,
        label:        tier.label,
        balance:      tier.balance + ' ORLIX',
        dailyCredits: tier.dailyCredits > 0 ? `$${tier.dailyCredits}/day` : null,
        models:       tier.models,
        discount:     tier.discount + '%',
      },
      staking: stakeInfo || {
        status:  'Coming soon',
        message: 'Set STAKING_CONTRACT env var after contract deployment to activate staking.',
      },
      ca: ORLIX_CONTRACT,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
