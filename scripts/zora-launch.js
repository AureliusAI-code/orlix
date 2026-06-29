#!/usr/bin/env node
/**
 * Orlix — Zora Agent Coin Launcher
 *
 * Required env vars:
 *   ORLIX_PRIVATE_KEY   — deployer wallet private key (0x...)
 *   PAYOUT_ADDRESS      — wallet that receives trading fees
 *   PINATA_JWT          — Pinata JWT (free at pinata.cloud) for IPFS upload
 *
 * Usage:
 *   node scripts/zora-launch.js --dry-run
 *   node scripts/zora-launch.js
 */

'use strict';

const https = require('https');
const { createCoin, CreateConstants, getCoin } = require('@zoralabs/coins-sdk');
const { createWalletClient, createPublicClient, http } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

const DRY_RUN = process.argv.includes('--dry-run');

// ── ANSI ─────────────────────────────────────────────────────────
const tc  = (r,g,b) => `\x1b[38;2;${r};${g};${b}m`;
const O1  = tc(255,214,60); const O = tc(255,140,0); const O4 = tc(255,98,0); const O5 = tc(220,70,0);
const G   = '\x1b[92m'; const R = '\x1b[91m'; const W = '\x1b[97m\x1b[1m';
const DIM = '\x1b[2m\x1b[90m'; const RST = '\x1b[0m';
const log  = m => console.log(`  ${m}${RST}`);
const ok   = m => log(`${G}✓${RST}  ${m}`);
const info = m => log(`${DIM}·${RST}  ${DIM}${m}`);
const err  = m => log(`${R}✗${RST}  ${R}${m}`);

function banner() {
  const rows = [O1,O1,O,O,O4,O5];
  const art  = [
    ' ██████╗ ██████╗ ██╗     ██╗██╗  ██╗',
    '██╔═══██╗██╔══██╗██║     ██║╚██╗██╔╝',
    '██║   ██║██████╔╝██║     ██║ ╚███╔╝ ',
    '██║   ██║██╔══██╗██║     ██║ ██╔██╗ ',
    '╚██████╔╝██║  ██║███████╗██║██╔╝ ██╗',
    ' ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝',
  ];
  console.log();
  art.forEach((l,i) => console.log(`  ${rows[i]}\x1b[1m${l}${RST}`));
  console.log(`  ${DIM}${'─'.repeat(38)}${RST}`);
  console.log(`  ${DIM}Zora Agent Coin Launcher${RST}  ${O}●${RST}  ${DIM}orlix.xyz${RST}`);
  console.log();
}

// ── Env ──────────────────────────────────────────────────────────
function need(key) {
  const v = process.env[key];
  if (!v) { err(`Missing: ${key}`); process.exit(1); }
  return v;
}

const PRIVATE_KEY = process.env.ORLIX_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { err('Missing: ORLIX_PRIVATE_KEY'); process.exit(1); }
const PINATA_JWT  = process.env.PINATA_JWT || '';
const account     = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
const PAYOUT      = process.env.PAYOUT_ADDRESS || account.address;
const REFERRER    = process.env.PLATFORM_REFERRER || '0x0000000000000000000000000000000000000000';

// ── Coin definition ───────────────────────────────────────────────
const METADATA = {
  name:        'Orlix',
  symbol:      'ORLIX',
  description: 'Base chain intelligence. Real-time on-chain analytics, B20 token deployment, and autonomous AI agent — all built on Base. Powered by Claude · orlix.xyz',
  image:       'https://orlix.xyz/orlix-logo.jpeg',
  properties: {
    type:     'agent',
    website:  'https://orlix.xyz',
    twitter:  'https://x.com/OrlixAI',
    category: 'AI Agent',
  },
};

// ── IPFS upload via Pinata ────────────────────────────────────────
function pinataUpload(json, jwt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      pinataContent: json,
      pinataMetadata: { name: 'orlix-coin-metadata.json' },
    });

    const req = https.request({
      hostname: 'api.pinata.cloud',
      path:     '/pinning/pinJSONToIPFS',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bearer ${jwt}`,
      },
      timeout: 30000,
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          if (d.IpfsHash) resolve(`ipfs://${d.IpfsHash}`);
          else reject(new Error(d.error?.details || JSON.stringify(d)));
        } catch { reject(new Error('Invalid Pinata response')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Pinata timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Clients ───────────────────────────────────────────────────────
const publicClient = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const walletClient = createWalletClient({ account, chain: base, transport: http('https://mainnet.base.org') });

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  banner();

  if (DRY_RUN) { log(`${O}[DRY RUN]${RST} No transaction will be sent`); console.log(); }

  log(`${W}Coin${RST}`);
  info(`Name:    ${METADATA.name}`);
  info(`Symbol:  $${METADATA.symbol}`);
  info(`Creator: ${account.address}`);
  info(`Payout:  ${PAYOUT}`);
  info(`Network: Base Mainnet (8453)`);
  console.log();

  // ── Upload metadata to IPFS ──────────────────────────────────
  let metadataURI;

  if (DRY_RUN) {
    metadataURI = 'ipfs://dry-run-placeholder';
    info('Skipping IPFS upload (dry run)');
  } else {
    if (!PINATA_JWT) {
      err('Missing: PINATA_JWT');
      err('Get a free JWT at pinata.cloud → API Keys → New Key');
      process.exit(1);
    }
    log(`${W}Uploading metadata to IPFS via Pinata...${RST}`);
    metadataURI = await pinataUpload(METADATA, PINATA_JWT);
    ok(`IPFS URI: ${DIM}${metadataURI}${RST}`);
  }
  console.log();

  // ── Prepare coin params ───────────────────────────────────────
  const coinParams = {
    creator:                 account.address,
    name:                    METADATA.name,
    symbol:                  METADATA.symbol,
    metadata:                { uri: metadataURI },
    currency:                CreateConstants.ContentCoinCurrencies.ETH,
    chainId:                 base.id,
    payoutRecipientOverride: PAYOUT,
    platformReferrer:        REFERRER,
    skipMetadataValidation:  true,
  };

  if (DRY_RUN) {
    log(`${O}[DRY RUN] Params:${RST}`);
    console.log(JSON.stringify(coinParams, null, 2));
    console.log();
    ok('Dry run complete — no transaction sent.');
    log(`Remove ${DIM}--dry-run${RST} to deploy for real.`);
    console.log();
    return;
  }

  // ── Deploy ────────────────────────────────────────────────────
  log(`${W}Deploying $ORLIX on Base...${RST}`);
  const result = await createCoin(
    { call: coinParams },
    walletClient,
    publicClient,
  );

  const { hash, address } = result;
  console.log();
  ok(`${G}$ORLIX deployed!${RST}`);
  info(`Tx:       ${DIM}https://basescan.org/tx/${hash}${RST}`);
  info(`Contract: ${DIM}${address}${RST}`);
  info(`Zora:     ${O}https://zora.co/coin/base:${address}${RST}`);
  console.log();
}

main().catch(e => {
  console.error(`\n  ${R}✗ ${e.message}${RST}\n`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
