// Shared $ORLIX holder tier check — used by all API endpoints
// Token: 0x799c28BAC95B3E0B26534D1e9A586511895EcBA3 (Base mainnet)

const ORLIX_CONTRACT = '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3';
const BASE_RPC       = 'https://mainnet.base.org';

// Tier definitions
// Platform access tiers (balance-based, from original announcement)
// Staking tiers (stake-based, for AI credits — requires staking contract)
const TIERS = {
  NONE: {
    label:        'Standard',
    minHold:      '0',
    dailyCredits: 0,
    maxTokens:    2048,
    models:       'basic',   // mimo models only
    discount:     0,
  },
  HOLDER: {
    label:        'Holder',
    minHold:      '1,000,000',
    dailyCredits: 3,          // $3/day AI credits
    maxTokens:    4096,
    models:       'standard', // + deepseek, groq fast models
    discount:     30,
  },
  POWER_HOLDER: {
    label:        'Power Holder',
    minHold:      '10,000,000',
    dailyCredits: 5,          // $5/day AI credits
    maxTokens:    6144,
    models:       'full',     // all 19 models
    discount:     65,
  },
  ELITE: {
    label:        'Elite',
    minHold:      '50,000,000',
    dailyCredits: 10,         // $10/day AI credits
    maxTokens:    8192,
    models:       'full',     // all 19 models + priority queue
    discount:     100,
  },
};

// Staking tiers for AI credits (requires ORLIXStaking contract)
// Minimum stake: 3M ORLIX for 30 days
const STAKING_TIERS = {
  TIER_1: { minStake: '3,000,000',  dailyCredits: 3,  label: 'Staker Tier 1' },
  TIER_2: { minStake: '10,000,000', dailyCredits: 5,  label: 'Staker Tier 2' },
  TIER_3: { minStake: '50,000,000', dailyCredits: 10, label: 'Staker Tier 3' },
};

// Thresholds in wei (18 decimals)
const THRESHOLDS = [
  ['ELITE',        50_000_000n * 10n ** 18n],
  ['POWER_HOLDER', 10_000_000n * 10n ** 18n],
  ['HOLDER',        1_000_000n * 10n ** 18n],
];

async function getOrlixBalance(wallet) {
  const data = '0x70a08231' + wallet.replace('0x', '').toLowerCase().padStart(64, '0');
  const r = await fetch(BASE_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ORLIX_CONTRACT, data }, 'latest'] }),
    signal:  AbortSignal.timeout(5000),
  });
  const d   = await r.json();
  const hex = d.result || '0x0';
  return hex === '0x' ? 0n : BigInt(hex);
}

async function getOrlixTier(wallet) {
  const none = { tier: 'NONE', balance: '0', balanceRaw: 0n, ...TIERS.NONE };

  if (!wallet || !/^0x[0-9a-f]{40}$/i.test(wallet)) return none;

  try {
    const balance = await getOrlixBalance(wallet);
    const balFmt  = (Number(balance / 10n ** 15n) / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 });

    let tierKey = 'NONE';
    for (const [key, min] of THRESHOLDS) {
      if (balance >= min) { tierKey = key; break; }
    }

    return { tier: tierKey, balance: balFmt, balanceRaw: balance, ...TIERS[tierKey] };
  } catch {
    return none;
  }
}

// Attach holder info to every API response
function withTier(data, tier) {
  const nextTierMap = { NONE: 'HOLDER', HOLDER: 'POWER_HOLDER', POWER_HOLDER: 'ELITE', ELITE: null };
  const nextTier    = nextTierMap[tier.tier];
  const nextInfo    = nextTier ? TIERS[nextTier] : null;

  return {
    ...data,
    _orlix: {
      tier:         tier.tier,
      label:        tier.label,
      balance:      tier.balance + ' ORLIX',
      dailyCredits: tier.dailyCredits > 0 ? `$${tier.dailyCredits}/day` : null,
      models:       tier.models,
      discount:     tier.discount + '%',
      nextTier:     nextInfo
        ? `Hold ${nextInfo.minHold} $ORLIX to unlock ${nextInfo.label} — $${nextInfo.dailyCredits}/day AI credits`
        : 'Max tier reached',
      ca:           ORLIX_CONTRACT,
    },
  };
}

// Check if a wallet is allowed to use a given model tier
function canUseModel(tier, modelCategory) {
  const access = { basic: 0, standard: 1, full: 2 };
  const tierAccess = { NONE: 0, HOLDER: 1, POWER_HOLDER: 2, ELITE: 2 };
  return tierAccess[tier] >= access[modelCategory];
}

module.exports = { getOrlixTier, withTier, canUseModel, TIERS, STAKING_TIERS };
