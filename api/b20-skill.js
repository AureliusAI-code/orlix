// /api/b20-skill — Orlix B20 Skill
// Agent-callable API: validate B20 token config & prepare deployment on Base
// GET  ?action=manifest  → tool schema (Claude + OpenAI format)
// GET  ?action=info      → B20 standard status
// POST { action, ...params } → validate | prepare

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Orlix-Key',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

// ── helpers ───────────────────────────────────────────────────────────────────

function h32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').toUpperCase();
}

// Deterministic address preview from token params (same algo as b20-studio.html)
function previewAddress(name, symbol, variant) {
  const p = [
    h32(name + symbol),
    h32(symbol + variant),
    h32(variant + name),
    h32(name + variant + symbol),
    h32(symbol + name + variant),
  ].join('');
  return '0xB20' + p.slice(0, 37).toUpperCase();
}

// ── validation ────────────────────────────────────────────────────────────────

function parseConfig(input) {
  const errors = [];
  const warnings = [];

  // name
  const name = (input.name ?? '').trim();
  if (!name) errors.push('name is required');
  else if (name.length > 64) errors.push('name must be ≤ 64 characters');

  // symbol
  const symbol = (input.symbol ?? '').trim().toUpperCase();
  if (!symbol) errors.push('symbol is required');
  else if (symbol.length > 11) errors.push('symbol must be ≤ 11 characters');
  else if (!/^[A-Z0-9]+$/.test(symbol)) warnings.push('symbol should only contain letters and numbers');

  // variant
  const variant = (input.variant ?? 'asset').toLowerCase();
  if (!['asset', 'stablecoin'].includes(variant))
    errors.push('variant must be "asset" or "stablecoin"');

  // decimals
  let decimals = parseInt(input.decimals ?? 18, 10);
  if (variant === 'stablecoin') {
    if (input.decimals !== undefined && parseInt(input.decimals, 10) !== 6)
      warnings.push('Stablecoin variant fixes decimals at 6');
    decimals = 6;
  } else {
    if (isNaN(decimals) || decimals < 6 || decimals > 18) {
      errors.push('decimals must be 6–18 for Asset variant');
      decimals = 18;
    }
  }

  // admin
  const adminless = !!(input.adminless);
  const admin = (input.admin ?? '').trim().toLowerCase();
  if (!adminless) {
    if (!admin) errors.push('admin is required (or set adminless: true)');
    else if (!/^0x[0-9a-f]{40}$/.test(admin))
      errors.push('admin must be a valid Ethereum address');
  }
  if (adminless)
    warnings.push('Admin-less deploy is irreversible — no one can mint, pause, or change policies after deploy');

  // supply_cap
  let supplyCap = '0';
  const rawCap = String(input.supply_cap ?? input.supplyCap ?? '0').replace(/,/g, '');
  if (rawCap && rawCap !== '0') {
    if (!/^\d+$/.test(rawCap)) errors.push('supply_cap must be an integer string (no decimals or commas)');
    else supplyCap = rawCap;
  }

  // policies
  const pol = input.policies ?? {};
  const policies = {
    allowlist: !!pol.allowlist,
    blocklist: !!pol.blocklist,
    freeze:    !!pol.freeze,
  };
  if (policies.allowlist && policies.blocklist)
    warnings.push('Both allowlist and blocklist enabled — allowlist takes precedence');
  if (policies.freeze)
    warnings.push('Freeze & Seize grants admin power to freeze any account and seize balances');
  if (adminless && Object.values(policies).some(Boolean))
    warnings.push('Compliance policies have no effect on an admin-less token');

  const config = {
    name,
    symbol,
    variant,
    decimals,
    supply_cap: supplyCap,
    admin: adminless ? null : admin,
    adminless,
    policies,
    contract_uri: input.contract_uri ?? input.contractUri ?? null,
  };

  return { errors, warnings, config };
}

// ── handlers ──────────────────────────────────────────────────────────────────

function handleManifest(res) {
  const schema = inputSchema();
  return res.end(JSON.stringify({
    schema: 'orlix-skill/1.0',
    id: 'orlix.b20',
    name: 'B20 Token Skill',
    description: 'Create, validate, and prepare B20 token deployments on Base. Supports Asset and Stablecoin variants with role-based access, supply caps, and compliance policies.',
    endpoint: 'https://orlixai.xyz/api/b20-skill',
    version: '1.0.0',
    status: 'gated',
    standard: 'B20/Beryl',
    network: { name: 'Base', chainId: 8453 },
    actions: ['manifest', 'info', 'validate', 'prepare'],

    // Claude tool use format
    tools: [
      {
        name: 'b20_prepare',
        description: 'Validate and prepare a B20 token deployment on Base. Returns config, deterministic address preview, and deployment parameters ready to sign once Base Beryl activates.',
        input_schema: { type: 'object', ...schema },
        examples: [
          {
            description: 'Asset token, blocklist policy',
            input: { name: 'BNKR Token', symbol: 'BNKR', variant: 'asset', decimals: 18, supply_cap: '1000000000', admin: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', policies: { blocklist: true } },
          },
          {
            description: 'Stablecoin, allowlist only',
            input: { name: 'Orlix USD', symbol: 'OUSD', variant: 'stablecoin', supply_cap: '100000000', admin: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', policies: { allowlist: true } },
          },
        ],
      },
      {
        name: 'b20_validate',
        description: 'Validate B20 token parameters. Returns errors and warnings without preparing deployment data.',
        input_schema: { type: 'object', ...schema },
      },
    ],

    // OpenAI / LangChain compatible
    openai_functions: [
      {
        name: 'b20_prepare',
        description: 'Validate and prepare a B20 token deployment on Base',
        parameters: { type: 'object', ...schema },
      },
    ],

    links: {
      studio:   'https://orlixai.xyz/b20',
      docs:     'https://orlixai.xyz/docs',
      api_info: 'https://orlixai.xyz/api/b20?action=info',
      manifest: 'https://orlixai.xyz/api/b20-skill?action=manifest',
    },
  }));
}

function handleInfo(res) {
  return res.end(JSON.stringify({
    ok: true,
    standard: 'B20',
    network: 'Base',
    chainId: 8453,
    upgrade: 'Base Beryl',
    status: 'gated',
    message: 'B20 deploys go live when Base activates the standard',
    variants: ['asset', 'stablecoin'],
    features: ['mint', 'burn', 'pause', 'roles', 'supply_cap', 'allowlist', 'blocklist', 'freeze_seize'],
    links: {
      studio:   'https://orlixai.xyz/b20',
      api:      'https://orlixai.xyz/api/b20?action=info',
      manifest: 'https://orlixai.xyz/api/b20-skill?action=manifest',
    },
  }));
}

function handleValidate(input, res) {
  const { errors, warnings, config } = parseConfig(input);
  if (errors.length)
    return res.end(JSON.stringify({ ok: false, valid: false, errors, warnings }));
  return res.end(JSON.stringify({ ok: true, valid: true, errors: [], warnings, config }));
}

function handlePrepare(input, res) {
  const { errors, warnings, config } = parseConfig(input);
  if (errors.length)
    return res.end(JSON.stringify({ ok: false, valid: false, errors, warnings }));

  const address = previewAddress(config.name, config.symbol, config.variant);

  // Policy bitmask: bit0=allowlist bit1=blocklist bit2=freeze
  const policyBits = (config.policies.allowlist ? 1 : 0)
                   | (config.policies.blocklist  ? 2 : 0)
                   | (config.policies.freeze     ? 4 : 0);

  return res.end(JSON.stringify({
    ok:      true,
    status:  'prepared',
    gated:   true,
    message: 'Config is valid. B20 deploys go live when Base activates the standard — deploy then.',
    config,
    preview: {
      address,
      standard: `B20/${config.variant === 'asset' ? 'Asset' : 'Stablecoin'}`,
      chain:    'base',
      chainId:  8453,
      note: 'Deterministic preview only. Actual address is assigned by the B20 factory precompile at deploy time.',
    },
    deployment: {
      // B20 factory precompile address — to be confirmed by Base team at Beryl activation
      to:       '0x4200000000000000000000000000000000000B20',
      chain_id: 8453,
      value:    '0x0',
      params: {
        name:         config.name,
        symbol:       config.symbol,
        decimals:     config.decimals,
        supply_cap:   config.supply_cap,
        admin:        config.admin ?? '0x0000000000000000000000000000000000000000',
        variant:      config.variant === 'asset' ? 0 : 1,
        policy_bits:  policyBits,
        contract_uri: config.contract_uri ?? '',
      },
      note: 'Precompile address is preliminary. Calldata encoding will be available once the official B20 ABI is published at Beryl activation.',
    },
    links: {
      studio:        'https://orlixai.xyz/b20',
      control_room:  'https://orlixai.xyz/control-room',
      docs:          'https://orlixai.xyz/docs',
    },
    warnings,
  }));
}

function inputSchema() {
  return {
    properties: {
      action: {
        type: 'string',
        enum: ['validate', 'prepare'],
        description: 'validate: check config only. prepare: check + return deployment data.',
      },
      name: {
        type: 'string',
        description: 'Full token name, max 64 chars. Example: "BNKR Token"',
      },
      symbol: {
        type: 'string',
        description: 'Token ticker, max 11 alphanumeric chars. Example: "BNKR"',
      },
      variant: {
        type: 'string',
        enum: ['asset', 'stablecoin'],
        default: 'asset',
        description: 'asset: 6–18 decimals, general-purpose. stablecoin: fixed 6 decimals, fiat-focused.',
      },
      decimals: {
        type: 'integer',
        minimum: 6,
        maximum: 18,
        default: 18,
        description: 'Decimal places (6–18). Ignored for stablecoin variant — fixed at 6.',
      },
      supply_cap: {
        type: 'string',
        default: '0',
        description: 'Maximum total supply as integer string. "0" or omit for uncapped. Example: "1000000000"',
      },
      admin: {
        type: 'string',
        description: 'Admin wallet address (0x + 40 hex). Receives all roles at deploy. Required unless adminless is true.',
      },
      adminless: {
        type: 'boolean',
        default: false,
        description: 'Deploy with no admin. Irreversible — no minting, pausing, or policy changes ever.',
      },
      policies: {
        type: 'object',
        description: 'Optional compliance policies for the token.',
        properties: {
          allowlist: {
            type: 'boolean',
            default: false,
            description: 'Only addresses on the allowlist can hold or receive the token.',
          },
          blocklist: {
            type: 'boolean',
            default: false,
            description: 'Blocked addresses cannot send or receive transfers.',
          },
          freeze: {
            type: 'boolean',
            default: false,
            description: 'Admin can freeze an account and seize its token balance.',
          },
        },
      },
      contract_uri: {
        type: 'string',
        description: 'IPFS URI for token metadata JSON. Example: "ipfs://bafkrei...metadata.json"',
      },
    },
    required: ['name', 'symbol', 'admin'],
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.writeHead(200, CORS);

  if (req.method === 'OPTIONS') return res.end();

  try {
    let body = {};
    if (req.method === 'POST') {
      body = req.body ?? {};
    } else {
      body = req.query ?? {};
    }

    const action = body.action ?? (req.method === 'GET' ? 'manifest' : 'prepare');

    if (action === 'manifest') return handleManifest(res);
    if (action === 'info')     return handleInfo(res);
    if (action === 'validate') return handleValidate(body, res);
    if (action === 'prepare')  return handlePrepare(body, res);
    if (action === 'deploy')   return handlePrepare(body, res); // alias — actual deploy when live

    return res.end(JSON.stringify({
      ok: false,
      error: `Unknown action: "${action}"`,
      valid_actions: ['manifest', 'info', 'validate', 'prepare'],
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
