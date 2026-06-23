// Internal burn utility — called directly by chat.js (no HTTP, no secret passing)
// Requires: BURN_PRIVATE_KEY env var (platform treasury wallet)

const ORLIX_CONTRACT = '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3';
const BASE_RPC       = 'https://mainnet.base.org';
const DEAD           = '0x000000000000000000000000000000000000dEaD';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

// Simple in-process rate limit: max 1 burn per 30s globally
let lastBurnAt = 0;
const BURN_INTERVAL_MS = 30_000;

// 1000 ORLIX per $1 of AI credits (override with BURN_RATE env var)
function getBurnRate() {
  const rate = BigInt(process.env.BURN_RATE || '1000');
  if (rate <= 0n) throw new Error('BURN_RATE must be positive');
  return rate;
}

/**
 * Burn ORLIX from the platform treasury wallet.
 * @param {number} credits — dollar amount of AI credits consumed
 * @returns {Promise<{txHash: string, burnedOrlix: string}>}
 */
async function burnOrlix(credits) {
  const key = process.env.BURN_PRIVATE_KEY || '';
  if (!key) throw new Error('BURN_PRIVATE_KEY not set');

  if (typeof credits !== 'number' || credits <= 0 || credits > 1000) {
    throw new Error('credits must be a positive number <= 1000');
  }

  // In-process rate limit
  const now = Date.now();
  if (now - lastBurnAt < BURN_INTERVAL_MS) {
    throw new Error('Rate limited — wait before next burn');
  }

  const burnRate = getBurnRate();
  const burnWei  = BigInt(Math.ceil(credits)) * burnRate * 10n ** 18n;

  const { ethers } = require('ethers');
  const provider   = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet     = new ethers.Wallet(key, provider);
  const orlix      = new ethers.Contract(ORLIX_CONTRACT, ERC20_ABI, wallet);

  const balance = await orlix.balanceOf(wallet.address);
  if (balance < burnWei) {
    throw new Error('Insufficient ORLIX in platform wallet');
  }

  const tx = await orlix.transfer(DEAD, burnWei);
  await tx.wait(1);

  lastBurnAt = Date.now();

  return {
    txHash:      tx.hash,
    burnedOrlix: (Number(burnWei / 10n ** 15n) / 1000).toFixed(0) + ' ORLIX',
  };
}

module.exports = { burnOrlix };
