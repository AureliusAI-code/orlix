// POST /api/burn — Platform burn mechanic for $ORLIX
// Burns ORLIX from platform treasury wallet proportional to AI credits consumed.
//
// Required env vars:
//   BURN_PRIVATE_KEY  — platform treasury wallet private key (holds ORLIX for burning)
//   BURN_SECRET       — shared secret to authenticate calls from internal services
//   STAKING_CONTRACT  — deployed ORLIXStaking contract address (optional, for event tracking)
//
// Body: { credits: 3, secret: "..." }   — credits = dollar value of AI used
//   OR: { amount: "1000000000000000000", secret: "..." }  — raw wei amount to burn
//
// ORLIX burn rate: 1000 ORLIX per $1 of AI credits (adjustable via BURN_RATE env var)

const { ethers }       = require('ethers');
const ORLIX_CONTRACT   = '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3';
const BASE_RPC         = 'https://mainnet.base.org';
const DEAD             = '0x000000000000000000000000000000000000dEaD';

// ERC-20 transfer(address,uint256) ABI (minimal)
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Restrict to server-side calls only (no CORS for external origins)
  res.setHeader('Access-Control-Allow-Origin', 'same-origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const BURN_SECRET      = process.env.BURN_SECRET      || '';
  const BURN_PRIVATE_KEY = process.env.BURN_PRIVATE_KEY || '';
  const BURN_RATE        = BigInt(process.env.BURN_RATE || '1000'); // ORLIX per $1

  if (!BURN_SECRET || !BURN_PRIVATE_KEY) {
    return res.status(503).json({
      error:   'Burn mechanic not configured',
      missing: [!BURN_SECRET && 'BURN_SECRET', !BURN_PRIVATE_KEY && 'BURN_PRIVATE_KEY'].filter(Boolean),
    });
  }

  const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

  if (body.secret !== BURN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let burnWei;
  if (body.amount) {
    burnWei = BigInt(body.amount);
  } else if (body.credits != null) {
    burnWei = BigInt(Math.ceil(body.credits)) * BURN_RATE * 10n ** 18n;
  } else {
    return res.status(400).json({ error: 'Provide "credits" (dollar amount) or "amount" (raw wei)' });
  }

  if (burnWei <= 0n) return res.status(400).json({ error: 'Amount must be positive' });

  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const wallet   = new ethers.Wallet(BURN_PRIVATE_KEY, provider);
    const orlix    = new ethers.Contract(ORLIX_CONTRACT, ERC20_ABI, wallet);

    // Sanity check: platform wallet has enough ORLIX
    const balance = await orlix.balanceOf(wallet.address);
    if (balance < burnWei) {
      return res.status(400).json({
        error:          'Insufficient ORLIX in platform wallet',
        walletBalance:  balance.toString(),
        requested:      burnWei.toString(),
      });
    }

    const tx = await orlix.transfer(DEAD, burnWei);
    await tx.wait(1);

    const burnedOrlix = (Number(burnWei / 10n ** 15n) / 1000).toFixed(0);

    return res.status(200).json({
      ok:          true,
      txHash:      tx.hash,
      burnedWei:   burnWei.toString(),
      burnedOrlix: burnedOrlix + ' ORLIX',
      burnerWallet: wallet.address,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
