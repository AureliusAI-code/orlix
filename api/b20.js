// /api/b20 — B20 token standard info + token list on Base
// Beryl mainnet: June 25, 2026
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const BERYL_MAINNET_TS = new Date('2026-06-25T00:00:00Z').getTime();

const KNOWN_B20 = [];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'GET') { res.writeHead(405, CORS); return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  const action = req.query.action || 'info';
  const now = Date.now();
  const mainnetLive = now >= BERYL_MAINNET_TS;

  res.writeHead(200, CORS);

  if (action === 'info') {
    return res.end(JSON.stringify({
      standard: 'B20',
      network: 'Base',
      upgrade: 'Beryl',
      mainnetDate: '2026-06-25',
      mainnetLive,
      msUntilMainnet: mainnetLive ? 0 : BERYL_MAINNET_TS - now,
      testnet: {
        name: 'Base Sepolia',
        chainId: 84532,
        explorer: 'https://sepolia.basescan.org',
      },
      variants: [
        {
          name: 'Asset',
          description: 'General-purpose variant. Configurable decimals, issuer metadata, rebasing support.',
          useCases: ['onchain-native tokens', 'real-world assets', 'governance tokens'],
        },
        {
          name: 'Stablecoin',
          description: 'Focused variant for fiat-backed assets. Fixed 6 decimals, currency code field.',
          useCases: ['fiat-backed stablecoins', 'regulated assets'],
        },
      ],
      features: [
        'ERC-20 compatible — drop-in for wallets, DEXes, indexers',
        'ERC-2612 permits — approve without separate transaction',
        'Role-based access control — mint, burn, pause, metadata',
        'Supply caps — optional maximum supply',
        'Transfer policies — granular sender/receiver/executor control',
        'Freeze & seize — burn balance of blocked address',
        'Transfer memos — payment IDs and compliance tags',
      ],
      comingSoon: [
        'Pay gas in your own B20 token — no ETH required',
        'Virtual deposit addresses',
        'Indexed balances and history from Base Node RPC',
        '~50% cheaper transfers',
      ],
      docs: 'https://docs.base.org/base-chain/specs/upgrades/beryl/b20',
    }));
  }

  if (action === 'tokens') {
    if (!mainnetLive) {
      return res.end(JSON.stringify({
        tokens: [],
        total: 0,
        mainnetLive: false,
        message: 'B20 tokens go live on Base mainnet June 25, 2026. Check back then.',
        msUntilMainnet: BERYL_MAINNET_TS - now,
        testnetExplorer: 'https://sepolia.basescan.org',
      }));
    }
    return res.end(JSON.stringify({
      tokens: KNOWN_B20,
      total: KNOWN_B20.length,
      mainnetLive: true,
      ts: now,
    }));
  }

  res.end(JSON.stringify({ error: 'Unknown action. Use ?action=info or ?action=tokens' }));
};
