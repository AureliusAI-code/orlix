// Orlix X402 — B20 Token Standard Info
// Info about the B20 standard on Base + live network stats. Holders get deployment guide.

import { getOrlixTier, withTier } from '../_shared/holder';

const BASE_RPC = 'https://mainnet.base.org';

async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(BASE_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(8000),
  });
  const d: any = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

export default async function handler(req: Request) {
  const url    = new URL(req.url);
  const wallet = url.searchParams.get('wallet') || null;
  const tier   = await getOrlixTier(wallet);

  // Live Base network stats
  const [blockHex, gasPriceHex, chainIdHex] = await Promise.all([
    rpc('eth_blockNumber',[]),
    rpc('eth_gasPrice',  []),
    rpc('eth_chainId',   []),
  ]);

  const blockNumber   = parseInt(blockHex, 16);
  const gasPriceGwei  = (parseInt(gasPriceHex, 16) / 1e9).toFixed(6);
  const chainId       = parseInt(chainIdHex, 16);

  const standard = {
    name:    'B20',
    network: 'Base',
    upgrade: 'Beryl',
    chainId,
    latestBlock: blockNumber,
    gasPriceGwei,
    variants: [
      { name: 'Asset', description: 'General-purpose. Configurable decimals, issuer metadata, rebasing support.', useCases: ['onchain-native tokens','governance tokens','real-world assets'] },
      { name: 'Stablecoin', description: 'Fiat-backed. Fixed 6 decimals, currency code field.', useCases: ['fiat-backed stablecoins','regulated assets'] },
    ],
    features: [
      'ERC-20 compatible — drop-in for wallets, DEXes, indexers',
      'ERC-2612 permits — gasless approvals',
      'Role-based access control — mint, burn, pause, metadata',
      'Supply caps — optional maximum supply',
      'Transfer policies — sender/receiver/executor control',
      'Freeze & seize — compliance controls',
      'Transfer memos — payment IDs and tags',
    ],
    links: {
      docs:    'https://docs.base.org/b20',
      studio:  'https://orlixai.xyz/b20-studio',
      basescan:`https://basescan.org`,
    },
  };

  // Holders get deployment guide + recommended config
  const deployGuide = tier.tier !== 'NONE' ? {
    recommended: {
      variant:        'Asset',
      decimals:        18,
      supplyCapEnabled:true,
      permitsEnabled:  true,
      roles: {
        issuer: 'Can mint tokens',
        admin:  'Can update metadata and policies',
        pauser: 'Can pause transfers in emergencies',
      },
    },
    deployVia: 'https://orlixai.xyz/b20-studio',
    telegramBot: 'Available via @OrlixAIBot — /deploy command (coming soon)',
    estimatedGasCost: `~$${(parseInt(gasPriceHex, 16) / 1e9 * 800000 * 2800 / 1e9).toFixed(4)} at current gas price`,
    note: 'B20 Beryl mainnet deployment available. Use Orlix B20 Studio for guided deployment.',
  } : 'Hold $ORLIX to unlock the B20 deployment guide and recommended configuration.';

  return withTier({
    standard,
    deployGuide,
    timestamp: new Date().toISOString(),
    poweredBy: 'Orlix AI — orlixai.xyz',
  }, tier);
}
