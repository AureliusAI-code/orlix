#!/usr/bin/env node
/**
 * Orlix — Zora Agent Coin Launcher
 *
 * Deploys $ORLIX as an Agent Coin on Zora (Base mainnet).
 * Uses @zoralabs/coins-sdk + viem.
 *
 * Required env vars:
 *   PRIVATE_KEY          — deployer wallet private key (0x...)
 *   PAYOUT_ADDRESS       — where trading fees go (defaults to deployer)
 *   PLATFORM_REFERRER    — optional referral address for fee split
 *
 * Usage:
 *   node scripts/zora-launch.js
 *   node scripts/zora-launch.js --dry-run   (simulate, no tx sent)
 */

'use strict';

const {
  createCoinCall,
  createCoin,
  CoinMetadataBuilder,
  createZoraUploaderForCreator,
  CreateConstants,
  getCoin,
} = require('@zoralabs/coins-sdk');

const { createWalletClient, createPublicClient, http, parseEther } = require('viem');
const { base }       = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');

// ── Config ────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

function env(key, fallback) {
  const v = process.env[key];
  if (!v && !fallback) {
    console.error(`\x1b[91m✗ Missing env var: ${key}\x1b[0m`);
    process.exit(1);
  }
  return v || fallback;
}

const PRIVATE_KEY = env('ORLIX_PRIVATE_KEY') || env('PRIVATE_KEY');
const account     = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);
const PAYOUT      = (process.env.PAYOUT_ADDRESS || account.address);
const REFERRER    = process.env.PLATFORM_REFERRER || '0x0000000000000000000000000000000000000000';

// ── Coin definition ───────────────────────────────────────────────

const COIN = {
  name:        'Orlix',
  symbol:      'ORLIX',
  description: (
    'Base chain intelligence. Real-time on-chain analytics, B20 token ' +
    'deployment, and autonomous AI agent — all built on Base. ' +
    'Powered by Claude · orlix.xyz'
  ),
  // Orlix logo hosted on-site — Zora will mirror to IPFS
  imageUrl:    'https://orlix.xyz/orlix-logo.png',
  website:     'https://orlix.xyz',
  twitter:     'https://x.com/OrlixAI',
};

// ── Clients ───────────────────────────────────────────────────────

const publicClient = createPublicClient({
  chain:     base,
  transport: http('https://mainnet.base.org'),
});

const walletClient = createWalletClient({
  account,
  chain:     base,
  transport: http('https://mainnet.base.org'),
});

// ── Helpers ───────────────────────────────────────────────────────

const O  = '\x1b[38;2;255;140;0m';
const O1 = '\x1b[38;2;255;214;60m';
const DIM = '\x1b[2m\x1b[90m';
const G   = '\x1b[92m';
const R   = '\x1b[91m';
const W   = '\x1b[97m\x1b[1m';
const RST = '\x1b[0m';

function log(msg)  { console.log(`  ${msg}${RST}`); }
function ok(msg)   { log(`${G}✓${RST}  ${msg}`); }
function info(msg) { log(`${DIM}·${RST}  ${DIM}${msg}`); }
function err(msg)  { log(`${R}✗${RST}  ${R}${msg}`); }

function banner() {
  const rows = [O1,O1,O,O,'\x1b[38;2;255;98;0m','\x1b[38;2;220;70;0m'];
  const art  = [
    ' ██████╗ ██████╗ ██╗     ██╗██╗  ██╗',
    '██╔═══██╗██╔══██╗██║     ██║╚██╗██╔╝',
    '██║   ██║██████╔╝██║     ██║ ╚███╔╝ ',
    '██║   ██║██╔══██╗██║     ██║ ██╔██╗ ',
    '╚██████╔╝██║  ██║███████╗██║██╔╝ ██╗',
    ' ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝',
  ];
  console.log();
  art.forEach((l, i) => console.log(`  ${rows[i]}\x1b[1m${l}${RST}`));
  console.log(`  ${DIM}${'─'.repeat(38)}${RST}`);
  console.log(`  ${DIM}Zora Agent Coin Launcher${RST}  ${O}●${RST}  ${DIM}orlix.xyz${RST}`);
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  banner();

  if (DRY_RUN) {
    log(`${O}[DRY RUN]${RST} No transaction will be sent`);
    console.log();
  }

  // 1. Show config
  log(`${W}Coin${RST}`);
  info(`Name:     ${COIN.name}`);
  info(`Symbol:   $${COIN.symbol}`);
  info(`Creator:  ${account.address}`);
  info(`Payout:   ${PAYOUT}`);
  info(`Network:  Base Mainnet (${base.id})`);
  console.log();

  // 2. Build + upload metadata
  log(`${W}Building metadata...${RST}`);

  const builder = new CoinMetadataBuilder({
    name:        COIN.name,
    description: COIN.description,
    image:       COIN.imageUrl,
  });

  // Set agent-type properties (Zora reads these for the AGENT badge)
  builder.withProperties({
    type:    'agent',
    website: COIN.website,
    twitter: COIN.twitter,
  });

  let metadataURI;

  if (DRY_RUN) {
    // In dry-run, skip actual upload
    metadataURI = 'ipfs://dry-run-placeholder';
    info('Skipping IPFS upload (dry run)');
  } else {
    log(`${W}Uploading metadata to IPFS via Zora...${RST}`);
    const uploader = createZoraUploaderForCreator(account.address);
    const uploadResult = await builder.upload(uploader);
    metadataURI = uploadResult.uri;
    ok(`Metadata URI: ${DIM}${metadataURI}${RST}`);
  }

  console.log();

  // 3. Build the createCoin call
  log(`${W}Preparing coin deployment...${RST}`);

  const coinParams = {
    creator:              account.address,
    name:                 COIN.name,
    symbol:               COIN.symbol,
    metadata:             { uri: metadataURI },
    currency:             CreateConstants.ContentCoinCurrencies.ETH,
    chainId:              base.id,
    payoutRecipientOverride: PAYOUT,
    platformReferrer:     REFERRER,
    skipMetadataValidation: DRY_RUN,
  };

  if (DRY_RUN) {
    console.log();
    log(`${O}[DRY RUN] Coin params that would be submitted:${RST}`);
    console.log(JSON.stringify(coinParams, null, 2));
    console.log();
    log(`${G}Dry run complete — no transaction sent.${RST}`);
    log(`Remove ${DIM}--dry-run${RST} to deploy for real.`);
    console.log();
    return;
  }

  // 4. Deploy
  log(`${W}Deploying $${COIN.symbol} on Base...${RST}`);

  let result;
  try {
    result = await createCoin(
      { call: coinParams },
      walletClient,
      publicClient,
    );
  } catch (e) {
    // Try alternate call signature (some SDK versions differ)
    result = await createCoin({
      call:         coinParams,
      walletClient,
      publicClient,
    });
  }

  const { hash, address } = result;

  console.log();
  ok(`${G}$${COIN.symbol} deployed!${RST}`);
  info(`Tx hash:  ${DIM}${hash}${RST}`);
  info(`Contract: ${DIM}${address}${RST}`);
  console.log();

  // 5. Verify on Zora
  log(`${W}Fetching coin info from Zora...${RST}`);
  try {
    const coin = await getCoin({ address, chain: base.id });
    info(`Zora URL: ${O}https://zora.co/coin/base:${address}${RST}`);
    info(`Market cap: $${coin.marketCap || 'N/A'}`);
  } catch {
    info(`View at: ${O}https://zora.co/coin/base:${address}${RST}`);
  }

  console.log();
  log(`${O}${'─'.repeat(46)}${RST}`);
  log(`${DIM}Share: x.com/OrlixAI  ·  orlix.xyz  ·  Base${RST}`);
  console.log();
}

main().catch(e => {
  console.error(`\n  ${R}✗ ${e.message}${RST}\n`);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
