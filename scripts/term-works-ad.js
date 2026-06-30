#!/usr/bin/env node
/**
 * Orlix → TermWorks (term.works) ad campaign launcher
 *
 * Puts Orlix in front of developers' terminals via the TermWorks Agent API.
 * Docs/spec: https://term.works/openapi.json  (TermWorks Agent API 1.0.0)
 *
 * Payment model:
 *   1. Create an advertiser account + fund a balance at term.works/dashboard
 *      (the dashboard handles the USDC-on-Tempo payment UI). Grab your
 *      advertiser_id from there.
 *   2. Launch campaigns with this script — the budget is deducted from balance.
 *   3. (Optional) If you pay USDC on Tempo manually, submit the tx hash with the
 *      `topup` command. USDC on Tempo currency: 0x20c000000000000000000000b9537d11c60e8b50
 *
 * Usage:
 *   TERMWORKS_ADVERTISER_ID=acc_xxx node scripts/term-works-ad.js audience
 *   TERMWORKS_ADVERTISER_ID=acc_xxx node scripts/term-works-ad.js launch
 *   node scripts/term-works-ad.js status <campaign_id>
 *   TERMWORKS_ADVERTISER_ID=acc_xxx node scripts/term-works-ad.js topup <tempo_tx_hash>
 *
 * Override the creative/targeting/budget via env vars (see CONFIG below).
 */

'use strict';

const BASE = 'https://term.works/api/v1/mpp';

// ── Campaign config (Orlix defaults — override via env) ────────────
const ADVERTISER_ID = process.env.TERMWORKS_ADVERTISER_ID || '';

const CAMPAIGN = {
  title:   process.env.TW_TITLE   || '$_ orlix — analyze any base token + 19 AI models from your terminal',
  message: process.env.TW_MESSAGE || '19 frontier AI models + live Base intelligence in one CLI — token analysis, wallet alerts, and B20 deploy. watching base. all of it.',
  url:     process.env.TW_URL     || 'https://orlixai.xyz',
  // sponsor=$0.05 min CPM · opportunity=$0.15 · role=$0.50 · job=$1.00
  opportunity_type: process.env.TW_TYPE || 'sponsor',
  bid_cpm_cents:  parseInt(process.env.TW_BID_CPM_CENTS || '10', 10),   // $0.10 CPM
  budget_cents:   parseInt(process.env.TW_BUDGET_CENTS  || '1000', 10), // $10.00 total
  targeting: {
    categories: (process.env.TW_CATEGORIES || 'ai-ml,web3,backend,infra').split(',').map(s => s.trim()),
    os:         (process.env.TW_OS || 'macos,linux,windows').split(',').map(s => s.trim()),
  },
};

// ── ANSI ───────────────────────────────────────────────────────────
const O = '\x1b[38;2;255;140;0m', G = '\x1b[92m', R = '\x1b[91m', D = '\x1b[2m', W = '\x1b[97m\x1b[1m', X = '\x1b[0m';
const log = (...a) => console.log(...a);
const die = (m) => { console.error(`\n  ${R}✗ ${m}${X}\n`); process.exit(1); };

async function api(path, body, method = 'POST') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'orlix/1.0 (+orlixai.xyz)' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data; try { data = await res.json(); } catch { data = { raw: await res.text().catch(() => '') }; }
  return { status: res.status, data };
}

function banner(sub) {
  log(`\n  ${O}$_ orlix${X}  ${D}→  TermWorks${X}   ${D}${sub}${X}\n`);
}

// ── Commands ───────────────────────────────────────────────────────
async function cmdAudience() {
  banner('audience estimate');
  const { status, data } = await api('/audience', {
    categories: CAMPAIGN.targeting.categories,
    open_to_work: false,
  });
  if (status === 200) {
    log(`  ${G}✓${X} estimated reach: ${W}${data.reach ?? JSON.stringify(data)}${X} developers\n`);
  } else if (status === 402) {
    log(`  ${O}402 Payment Required${X} — audience estimate costs ${W}$0.01${X} (USDC on Tempo).`);
    log(`  ${D}Pay via the term.works dashboard or agentcash, then re-run. Details:${X}`);
    log('  ' + JSON.stringify(data) + '\n');
  } else {
    log(`  ${R}${status}${X} ${JSON.stringify(data)}\n`);
  }
}

async function cmdLaunch() {
  if (!ADVERTISER_ID) die('Set TERMWORKS_ADVERTISER_ID (get it at term.works/dashboard, fund the balance first).');
  banner('launch campaign');
  log(`  ${W}Creative${X}`);
  log(`  ${D}title:${X}  ${CAMPAIGN.title}`);
  log(`  ${D}msg:  ${X}  ${CAMPAIGN.message}`);
  log(`  ${D}url:  ${X}  ${O}${CAMPAIGN.url}${X}`);
  log(`  ${D}type: ${X}  ${CAMPAIGN.opportunity_type}   ${D}bid:${X} $${(CAMPAIGN.bid_cpm_cents/100).toFixed(2)} CPM   ${D}budget:${X} $${(CAMPAIGN.budget_cents/100).toFixed(2)}`);
  log(`  ${D}target:${X} ${CAMPAIGN.targeting.categories.join(', ')}  ·  ${CAMPAIGN.targeting.os.join('/')}\n`);

  const { status, data } = await api('/campaigns', { advertiser_id: ADVERTISER_ID, ...CAMPAIGN });
  if (status === 201 || status === 200) {
    log(`  ${G}✓ campaign created${X} — pending review, goes live within 24h`);
    if (data.id) log(`  ${D}id:${X} ${W}${data.id}${X}  ${D}(check: node scripts/term-works-ad.js status ${data.id})${X}`);
    log('');
  } else if (status === 402) {
    log(`  ${O}402 — insufficient balance.${X} Top up at ${O}term.works/dashboard${X} first, then re-run.\n`);
  } else {
    log(`  ${R}${status}${X} ${JSON.stringify(data)}\n`);
  }
}

async function cmdStatus(id) {
  if (!id) die('Usage: node scripts/term-works-ad.js status <campaign_id>');
  banner(`campaign ${id}`);
  const { status, data } = await api(`/campaigns/${encodeURIComponent(id)}`, null, 'GET');
  log(`  ${status === 200 ? G + '✓' : R + status}${X} ${JSON.stringify(data, null, 2)}\n`);
}

async function cmdTopup(txHash) {
  if (!ADVERTISER_ID) die('Set TERMWORKS_ADVERTISER_ID.');
  if (!txHash) die('Usage: node scripts/term-works-ad.js topup <tempo_tx_hash>  (pay USDC on Tempo first)');
  banner('top up balance');
  const { status, data } = await api('/topup', { advertiser_id: ADVERTISER_ID, tx_hash: txHash });
  if (status === 200) {
    log(`  ${G}✓ credited${X} ${data.credited_cents ? '$' + (data.credited_cents/100).toFixed(2) : ''}  ${D}new balance:${X} ${data.balance_cents != null ? '$' + (data.balance_cents/100).toFixed(2) : JSON.stringify(data)}\n`);
  } else {
    log(`  ${R}${status}${X} ${JSON.stringify(data)}\n`);
  }
}

// ── Entry ──────────────────────────────────────────────────────────
const [cmd, arg] = process.argv.slice(2);
(async () => {
  switch (cmd) {
    case 'audience': return cmdAudience();
    case 'launch':   return cmdLaunch();
    case 'status':   return cmdStatus(arg);
    case 'topup':    return cmdTopup(arg);
    default:
      log(`\n  ${O}$_ orlix${X} → TermWorks ad launcher\n`);
      log(`  ${W}commands${X}`);
      log(`  ${O}audience${X}            estimate developer reach for the targeting`);
      log(`  ${O}launch${X}              launch the Orlix sponsor campaign`);
      log(`  ${O}status${X} <id>         check a campaign's status`);
      log(`  ${O}topup${X} <tx_hash>     credit balance after paying USDC on Tempo`);
      log(`\n  ${D}First: create an advertiser account + fund balance at term.works/dashboard,${X}`);
      log(`  ${D}then export TERMWORKS_ADVERTISER_ID=acc_xxx${X}\n`);
  }
})().catch(e => die(e.message));
