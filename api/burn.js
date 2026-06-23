// POST /api/burn — Admin-only ORLIX burn endpoint
// Burns ORLIX from platform treasury to 0xdEaD.
// BURN_SECRET must be passed as Authorization: Bearer <secret> header.
// Rate limited: max 10 burns per hour globally.
//
// Body: { credits: 3 }  OR  { amount: "1000000000000000000" }

const { burnOrlix } = require('./_shared/burnOrlix');
const { ethers }    = require('ethers');

const ORLIX_CONTRACT = '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3';
const BASE_RPC       = 'https://mainnet.base.org';
const DEAD           = '0x000000000000000000000000000000000000dEaD';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

// In-process rate limiter: max 10 requests per hour
const requestLog = [];
const MAX_PER_HOUR = 10;

function isRateLimited() {
  const now    = Date.now();
  const cutoff = now - 3_600_000;
  while (requestLog.length && requestLog[0] < cutoff) requestLog.shift();
  if (requestLog.length >= MAX_PER_HOUR) return true;
  requestLog.push(now);
  return false;
}

module.exports = async function handler(req, res) {
  // No CORS — this endpoint is internal only
  res.setHeader('Access-Control-Allow-Origin',  'same-origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // Auth via Authorization header only (not body — avoids logging secret in request body)
  const BURN_SECRET = process.env.BURN_SECRET || '';
  if (!BURN_SECRET) return res.status(503).json({ error: 'Burn endpoint not configured' });

  const authHeader = (req.headers.authorization || '').trim();
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || token !== BURN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.BURN_PRIVATE_KEY) {
    return res.status(503).json({ error: 'BURN_PRIVATE_KEY not configured' });
  }

  if (isRateLimited()) {
    return res.status(429).json({ error: 'Rate limit exceeded — max 10 burns per hour' });
  }

  const body = typeof req.body === 'object' ? req.body : (() => {
    try { return JSON.parse(req.body || '{}'); } catch { return null; }
  })();

  if (!body) return res.status(400).json({ error: 'Invalid JSON body' });

  try {
    let result;

    if (body.amount) {
      // Raw wei amount — direct transfer (bypass burnOrlix helper)
      const burnWei = BigInt(body.amount);
      if (burnWei <= 0n) return res.status(400).json({ error: 'amount must be positive' });
      if (burnWei > 10n ** 27n) return res.status(400).json({ error: 'amount too large' });

      const provider = new ethers.JsonRpcProvider(BASE_RPC);
      const wallet   = new ethers.Wallet(process.env.BURN_PRIVATE_KEY, provider);
      const orlix    = new ethers.Contract(ORLIX_CONTRACT, ERC20_ABI, wallet);

      const balance = await orlix.balanceOf(wallet.address);
      if (balance < burnWei) {
        return res.status(400).json({ error: 'Insufficient ORLIX balance' });
      }

      const tx = await orlix.transfer(DEAD, burnWei);
      await tx.wait(1);

      result = {
        txHash:      tx.hash,
        burnedWei:   burnWei.toString(),
        burnedOrlix: (Number(burnWei / 10n ** 15n) / 1000).toFixed(0) + ' ORLIX',
      };
    } else if (body.credits != null) {
      const credits = Number(body.credits);
      if (!Number.isFinite(credits) || credits <= 0 || credits > 1000) {
        return res.status(400).json({ error: 'credits must be between 0 and 1000' });
      }
      result = await burnOrlix(credits);
    } else {
      return res.status(400).json({ error: 'Provide "credits" or "amount"' });
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    // Don't expose internal error details
    console.error('[burn] error:', e.message);
    return res.status(500).json({ error: 'Burn failed — check server logs' });
  }
};
