// /api/b20-skill — Orlix B20 Skill v3
// Agent-callable API with real Base chain interactions + correct Beryl ABI
//
// GET  ?action=manifest   → Claude + OpenAI tool schema
// GET  ?action=info       → live chain status, activation check, gas prices
// GET  ?action=gas        → current EIP-1559 gas prices
// POST action=balance     → ETH + optional ERC-20 balance
// POST action=token_info  → read any ERC-20 on Base
// POST action=validate    → deep validation + live admin balance check
// POST action=prepare     → full EIP-1559 deployment bundle (real gas + nonce)
// POST action=receipt     → tx hash status + deployed token address

'use strict';

const { ethers } = require('ethers');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Orlix-Key',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

// ── Addresses ─────────────────────────────────────────────────────────────────
const B20_FACTORY         = '0xB20f000000000000000000000000000000000000';
const ACTIVATION_REGISTRY = '0x8453000000000000000000000000000000000001';
const POLICY_REGISTRY     = '0x8453000000000000000000000000000000000002';

// ── Network ───────────────────────────────────────────────────────────────────
const RPC_URL  = { mainnet: 'https://mainnet.base.org', sepolia: 'https://sepolia.base.org' };
const CHAIN_ID = { mainnet: 8453, sepolia: 84532 };

// ── Role constants — keccak256 of role name strings ───────────────────────────
const ROLES = {
  DEFAULT_ADMIN: '0x0000000000000000000000000000000000000000000000000000000000000000',
  MINT_ROLE:         '0x154c00819833dac601ee5ddded6fda79d9d8b506b911b3dbd54cdb95fe6c3686',
  BURN_ROLE:         '0xe97b137254058bd94f28d2f3eb79e2d34074ffb488d042e3bc958e0a57d2fa22',
  BURN_BLOCKED_ROLE: '0x7408fdc0d31c7bcb349eab611f5d1168acd4303574993f8cdc98b1cd18c41cae',
  PAUSE_ROLE:        '0x139c2898040ef16910dc9f44dc697df79363da767d8bc92f2e310312b816e46d',
  UNPAUSE_ROLE:      '0x265b220c5a8891efdd9e1b1b7fa72f257bd5169f8d87e319cf3dad6ff52b94ae',
  METADATA_ROLE:     '0x6bd6b5318a46e5fff572d5e4258a20774aab40cc35ac7680654b9081fcc82f80',
  // Asset-variant only — gates updateMultiplier and announce()
  OPERATOR_ROLE:     ethers.id('OPERATOR_ROLE'),
};

// ── Activation Registry feature IDs — keccak256("base.b20_*") ────────────────
const FEATURE_B20_ASSET      = '0xcdcc772fe4cbdb1029f822861176d09e646db96723d4c1e82ddfdeb8163ef54c';
const FEATURE_B20_STABLECOIN = '0xecfa0def2c10020caaf65e6155aa69c84b24892aaef76eeac52e0e2b3a0b8601';

// ── ABI interfaces ────────────────────────────────────────────────────────────
const FACTORY_IFACE = new ethers.Interface([
  'function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address token)',
  'function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)',
  'function isB20(address token) view returns (bool)',
]);

const B20_IFACE = new ethers.Interface([
  'function grantRole(bytes32 role, address account)',
  'function updateSupplyCap(uint256 newSupplyCap)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

const REGISTRY_IFACE = new ethers.Interface([
  'function isActivated(bytes32 featureId) view returns (bool)',
]);

const ABI_CODER = ethers.AbiCoder.defaultAbiCoder();

// Standard ERC-20 selectors for direct eth_call reads
const SEL = {
  name:        '06fdde03',
  symbol:      '95d89b41',
  decimals:    '313ce567',
  totalSupply: '18160ddd',
  balanceOf:   '70a08231',
};

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

async function rpc(net, method, params = []) {
  const url = RPC_URL[net] ?? RPC_URL.mainnet;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function batchRpc(net, calls) {
  const url = RPC_URL[net] ?? RPC_URL.mainnet;
  const batch = calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params ?? [] }));
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
  const results = await resp.json();
  return results.sort((a, b) => a.id - b.id);
}

async function ethCall(net, to, data) {
  return rpc(net, 'eth_call', [{ to, data }, 'latest']);
}

// ── Activation Registry ───────────────────────────────────────────────────────

async function checkActivated(net, variant) {
  const featureId = variant === 'stablecoin' ? FEATURE_B20_STABLECOIN : FEATURE_B20_ASSET;
  const data = REGISTRY_IFACE.encodeFunctionData('isActivated', [featureId]);
  try {
    const result = await ethCall(net, ACTIVATION_REGISTRY, data);
    if (!result || result === '0x') return false;
    return ABI_CODER.decode(['bool'], result)[0];
  } catch {
    return false;
  }
}

// ── B20 calldata builders ─────────────────────────────────────────────────────

function encodeCreateParams(config) {
  if (config.variant === 'stablecoin') {
    // Currency: A-Z only per B20 spec (no digits, no spaces)
    const currency = (config.currency ?? 'USD').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
    return ABI_CODER.encode(
      ['uint8', 'string', 'string', 'address', 'string'],
      [1, config.name, config.symbol, config.admin ?? ethers.ZeroAddress, currency]
    );
  }
  return ABI_CODER.encode(
    ['uint8', 'string', 'string', 'address', 'uint8'],
    [1, config.name, config.symbol, config.admin ?? ethers.ZeroAddress, config.decimals]
  );
}

function buildInitCalls(config) {
  const calls = [];

  // Supply cap
  if (config.supply_cap && config.supply_cap !== '0') {
    calls.push(B20_IFACE.encodeFunctionData('updateSupplyCap', [BigInt(config.supply_cap)]));
  }

  // Role grants
  const roleMap = {
    minter:       ROLES.MINT_ROLE,
    burner:       ROLES.BURN_ROLE,
    burn_blocked: ROLES.BURN_BLOCKED_ROLE,
    pauser:       ROLES.PAUSE_ROLE,
    unpauser:     ROLES.UNPAUSE_ROLE,
    meta_admin:   ROLES.METADATA_ROLE,
    operator:     ROLES.OPERATOR_ROLE,  // Asset only — rebase multiplier & announcements
  };
  for (const [key, roleHash] of Object.entries(roleMap)) {
    const addr = (config.roles ?? {})[key];
    if (addr && /^0x[0-9a-fA-F]{40}$/i.test(addr)) {
      calls.push(B20_IFACE.encodeFunctionData('grantRole', [roleHash, addr]));
    }
  }

  return calls;
}

function buildCreateCalldata(config, salt) {
  const variant    = config.variant === 'stablecoin' ? 1 : 0;
  const params     = encodeCreateParams(config);
  const initCalls  = buildInitCalls(config);
  return FACTORY_IFACE.encodeFunctionData('createB20', [variant, salt, params, initCalls]);
}

// ── Gas helper ────────────────────────────────────────────────────────────────

async function fetchGas(net) {
  const results = await batchRpc(net, [
    { method: 'eth_gasPrice' },
    { method: 'eth_feeHistory', params: [1, 'latest', [25, 50, 75]] },
    { method: 'eth_blockNumber' },
  ]);

  const gasPriceWei = BigInt(results[0].result ?? '0x0');
  const feeHist     = results[1].result ?? {};
  const blockNumber = parseInt(results[2].result ?? '0x0', 16);

  const baseFee  = BigInt(feeHist.baseFeePerGas?.[0] ?? '0x0');
  const rewards  = feeHist.reward?.[0] ?? [];
  const tip50    = BigInt(rewards[1] ?? '0x0');
  const tip25    = BigInt(rewards[0] ?? '0x0');
  const tip75    = BigInt(rewards[2] ?? '0x0');

  const priorityFee  = tip50 > 0n ? tip50 : 1000000n;
  const maxFeePerGas = baseFee * 2n + priorityFee;

  const gwei = (n) => (Number(n) / 1e9).toFixed(4);
  const hex  = (n) => '0x' + n.toString(16);

  return {
    blockNumber,
    baseFeeGwei:         gwei(baseFee),
    gasPriceGwei:        gwei(gasPriceWei),
    maxFeePerGas:        hex(maxFeePerGas),
    maxPriorityFeePerGas:hex(priorityFee),
    tips: { slow: gwei(tip25), normal: gwei(tip50), fast: gwei(tip75) },
    raw: { baseFee: hex(baseFee), maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(priorityFee) },
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function parseConfig(input) {
  const errors   = [];
  const warnings = [];

  const name = (input.name ?? '').trim();
  if (!name) errors.push('name is required');
  else if (name.length > 64) errors.push('name must be ≤ 64 characters');

  const symbol = (input.symbol ?? '').trim().toUpperCase();
  if (!symbol) errors.push('symbol is required');
  else if (symbol.length > 11) errors.push('symbol must be ≤ 11 characters');
  else if (!/^[A-Z0-9]+$/.test(symbol)) warnings.push('symbol should only contain letters and numbers');

  const variant = (input.variant ?? 'asset').toLowerCase();
  if (!['asset', 'stablecoin'].includes(variant))
    errors.push('variant must be "asset" or "stablecoin"');

  let decimals = parseInt(input.decimals ?? 18, 10);
  if (variant === 'stablecoin') {
    if (input.decimals !== undefined && parseInt(input.decimals, 10) !== 6)
      warnings.push('Stablecoin variant fixes decimals at 6');
    decimals = 6;
  } else if (isNaN(decimals) || decimals < 6 || decimals > 18) {
    errors.push('decimals must be 6–18 for Asset variant');
    decimals = 18;
  }

  const adminless = !!(input.adminless);
  const admin     = (input.admin ?? '').trim().toLowerCase();
  if (!adminless) {
    if (!admin) errors.push('admin is required (or set adminless: true)');
    else if (!/^0x[0-9a-f]{40}$/.test(admin)) errors.push('admin must be a valid 0x Ethereum address');
  }
  if (adminless) warnings.push('Admin-less deploy is irreversible — no minting, pausing, or policy changes ever');

  const rawCap  = String(input.supply_cap ?? input.supplyCap ?? '0').replace(/,/g, '');
  let supplyCap = '0';
  if (rawCap && rawCap !== '0') {
    if (!/^\d+$/.test(rawCap)) errors.push('supply_cap must be an integer string with no commas or decimals');
    else supplyCap = rawCap;
  }

  const pol      = input.policies ?? {};
  const policies = { allowlist: !!pol.allowlist, blocklist: !!pol.blocklist, freeze: !!pol.freeze };
  if (policies.allowlist && policies.blocklist) warnings.push('Both allowlist and blocklist enabled — allowlist takes precedence');
  if (policies.freeze) warnings.push('Freeze & Seize grants admin power to freeze accounts and seize their balances');
  if (adminless && Object.values(policies).some(Boolean)) warnings.push('Compliance policies have no effect when adminless is true');

  // Roles
  const roles = {};
  for (const key of ['minter','burner','burn_blocked','pauser','unpauser','meta_admin','operator']) {
    const addr = (input.roles ?? {})[key];
    if (addr && addr.trim()) {
      if (!/^0x[0-9a-fA-F]{40}$/i.test(addr.trim()))
        warnings.push(`roles.${key} is not a valid address — ignored`);
      else
        roles[key] = addr.trim().toLowerCase();
    }
  }

  return {
    errors, warnings,
    config: {
      name, symbol, variant, decimals,
      supply_cap:   supplyCap,
      admin:        adminless ? null : admin,
      adminless,
      policies,
      roles,
      currency:     (input.currency ?? 'USD').trim().toUpperCase().slice(0, 3),
      contract_uri: input.contract_uri ?? input.contractUri ?? null,
    },
  };
}

// ── ERC-20 decoders ───────────────────────────────────────────────────────────

function decodeString(hex) {
  if (!hex || hex === '0x') return '';
  try {
    const raw    = hex.replace('0x', '');
    const offset = parseInt(raw.slice(0, 64), 16) * 2;
    const len    = parseInt(raw.slice(offset, offset + 64), 16);
    const data   = raw.slice(offset + 64, offset + 64 + len * 2);
    return Buffer.from(data, 'hex').toString('utf8');
  } catch { return ''; }
}
function decodeUint(hex)  { try { return BigInt(hex ?? '0x0').toString(); } catch { return '0'; } }
function decodeUint8(hex) { try { return parseInt(hex ?? '0x0', 16); } catch { return 0; } }

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleInfo(net, res) {
  try {
    const [gas, assetActive, stableActive] = await Promise.all([
      fetchGas(net),
      checkActivated(net, 'asset'),
      checkActivated(net, 'stablecoin'),
    ]);

    return res.end(JSON.stringify({
      ok:       true,
      standard: 'B20',
      network:  net === 'mainnet' ? 'Base' : 'Base Sepolia',
      chainId:  CHAIN_ID[net],
      upgrade:  'Base Beryl',
      activation: {
        asset:      assetActive,
        stablecoin: stableActive,
        registryAddress: ACTIVATION_REGISTRY,
        note: assetActive ? 'B20 is live — ready to deploy' : 'Activation Registry not yet enabled — wait ~1 hour after Beryl hardfork',
      },
      chain: {
        blockNumber: gas.blockNumber,
        baseFeeGwei: gas.baseFeeGwei,
        gasTip:      `${gas.tips.normal} gwei (normal)`,
      },
      factory: {
        address: B20_FACTORY,
        note:    'B20 Factory precompile on Base',
      },
      policyRegistry: {
        address: POLICY_REGISTRY,
        note:    'Create allowlist/blocklist policies, then link to token via updatePolicy(scope, policyId)',
      },
      variants: [
        { name: 'asset',      description: 'General-purpose. Configurable decimals (6–18), rebasing, issuer metadata.' },
        { name: 'stablecoin', description: 'Fiat-focused. Fixed 6 decimals, immutable currency code (e.g. "USD").' },
      ],
      features: [
        'ERC-20 compatible — works with any wallet, DEX, or indexer',
        'ERC-2612 permits — gasless approvals (no separate tx)',
        'Role-based access — mint, burn, pause, metadata roles',
        'Supply caps — optional maximum total supply',
        'Transfer policies — sender/receiver/executor control',
        'Freeze & Seize — freeze accounts and recover balances',
        'Transfer memos — payment IDs and compliance tags',
      ],
      roles: ROLES,
      links: {
        studio:   'https://orlixai.xyz/b20-studio.html',
        manifest: 'https://orlixai.xyz/api/b20-skill?action=manifest',
        baseDocs: 'https://docs.base.org/base-chain/specs/upgrades/beryl/b20',
      },
    }));
  } catch (e) {
    return res.end(JSON.stringify({
      ok: false, error: `Chain query failed: ${e.message}`,
      standard: 'B20', network: net, chainId: CHAIN_ID[net],
    }));
  }
}

async function handleGas(net, res) {
  try {
    const gas = await fetchGas(net);
    const DEPLOY_GAS = 300000n;
    const maxFee     = BigInt(gas.raw.maxFeePerGas);
    const costWei    = DEPLOY_GAS * maxFee;
    const costEth    = Number(costWei) / 1e18;

    return res.end(JSON.stringify({
      ok: true, network: net, chainId: CHAIN_ID[net], blockNumber: gas.blockNumber,
      eip1559: {
        baseFeeGwei:              gas.baseFeeGwei,
        maxFeePerGas:             gas.maxFeePerGas,
        maxPriorityFeePerGas:     gas.maxPriorityFeePerGas,
        maxPriorityFeePerGas_gwei:(Number(BigInt(gas.raw.maxPriorityFeePerGas)) / 1e9).toFixed(6) + ' gwei',
        tips: gas.tips,
      },
      deployEstimate: {
        gasUnits:   300000,
        note:       'Approximate — actual gas depends on calldata size',
        maxCostEth: costEth.toFixed(8),
        maxCostWei: costWei.toString(),
        summary:    costEth.toFixed(8) + ' ETH at ' + gas.baseFeeGwei + ' gwei base fee',
      },
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}