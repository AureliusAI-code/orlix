// /api/b20-skill — Orlix B20 Skill v2
// Agent-callable API with real Base chain interactions
//
// GET  ?action=manifest   → Claude + OpenAI tool schema
// GET  ?action=info       → live chain status + gas prices
// GET  ?action=gas        → current EIP-1559 gas prices
// POST action=balance     → ETH + optional ERC-20 balance
// POST action=token_info  → read any ERC-20 on Base
// POST action=validate    → deep validation + live admin balance check
// POST action=prepare     → full EIP-1559 deployment bundle (real gas + nonce)
// POST action=receipt     → tx hash status + deployed token address

'use strict';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Orlix-Key',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};

const RPC_URL = {
  mainnet: 'https://mainnet.base.org',
  sepolia: 'https://sepolia.base.org',
};
const CHAIN_ID = { mainnet: 8453, sepolia: 84532 };

// B20 factory precompile — activates at Base Beryl
const B20_FACTORY = '0x4200000000000000000000000000000000000B20';

// ERC-20 call selectors (keccak256 of function signatures, first 4 bytes)
const SEL = {
  name:        '06fdde03',
  symbol:      '95d89b41',
  decimals:    '313ce567',
  totalSupply: '18160ddd',
  balanceOf:   '70a08231',
};

// ── JSON-RPC ──────────────────────────────────────────────────────────────────

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

// ── ABI helpers ───────────────────────────────────────────────────────────────

const u256 = (v) => BigInt(v ?? 0).toString(16).padStart(64, '0');
const u8   = (v) => Number(v ?? 0).toString(16).padStart(64, '0');
const addr = (a) => (a ?? '').replace(/^0x/, '').toLowerCase().padStart(64, '0');

function encodeStr(s) {
  const bytes = Buffer.from(s ?? '', 'utf8');
  const lenHex  = u256(bytes.length);
  const dataHex = bytes.toString('hex').padEnd(Math.ceil(bytes.length / 32) * 64, '0');
  return lenHex + dataHex;
}

// ABI encode: types = ['string','string','uint8','uint256','address','uint8','uint8','string']
function abiEncode(types, values) {
  const dynamic = (t) => t === 'string' || t === 'bytes';
  const heads = [];
  const tails = [];
  let offset = types.length * 32;

  for (let i = 0; i < types.length; i++) {
    const t = types[i], v = values[i];
    if (dynamic(t)) {
      heads.push(u256(offset));
      const enc = encodeStr(v);
      tails.push(enc);
      offset += enc.length / 2;
    } else if (t === 'uint256') heads.push(u256(v));
    else if (t === 'uint8')   heads.push(u8(v));
    else if (t === 'address') heads.push(addr(v));
  }
  return heads.join('') + tails.join('');
}

// B20 factory calldata
// Assumed ABI: create(string,string,uint8,uint256,address,uint8,uint8,string)
// Selector confirmed pending official Base Beryl ABI publication
const B20_SELECTOR = 'b20b20b2'; // placeholder (4 bytes) — official selector published at Beryl activation
const B20_TYPES    = ['string','string','uint8','uint256','address','uint8','uint8','string'];

function buildCalldata(config, policyBits) {
  const values = [
    config.name,
    config.symbol,
    config.decimals,
    config.supply_cap ?? '0',
    config.admin ?? '0x0000000000000000000000000000000000000000',
    config.variant === 'stablecoin' ? 1 : 0,
    policyBits,
    config.contract_uri ?? '',
  ];
  const encoded = abiEncode(B20_TYPES, values);
  return {
    calldata:     '0x' + B20_SELECTOR + encoded,
    selector:     '0x' + B20_SELECTOR,
    selectorNote: 'Placeholder — official selector published at Base Beryl activation',
    abiSig:       'create(string,string,uint8,uint256,address,uint8,uint8,string)',
  };
}

// ERC-20 response decoders
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

// ── gas ───────────────────────────────────────────────────────────────────────

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
  const tip25    = BigInt(rewards[0] ?? '0x0');
  const tip50    = BigInt(rewards[1] ?? '0x0');
  const tip75    = BigInt(rewards[2] ?? '0x0');

  const priorityFee  = tip50 > 0n ? tip50 : 1000000n; // 0.001 gwei fallback
  const maxFeePerGas = baseFee * 2n + priorityFee;

  const gwei  = (n) => (Number(n) / 1e9).toFixed(4);
  const hex   = (n) => '0x' + n.toString(16);

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

// ── validation ────────────────────────────────────────────────────────────────

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

  const rawCap   = String(input.supply_cap ?? input.supplyCap ?? '0').replace(/,/g, '');
  let supplyCap  = '0';
  if (rawCap && rawCap !== '0') {
    if (!/^\d+$/.test(rawCap)) errors.push('supply_cap must be an integer string with no commas or decimals');
    else supplyCap = rawCap;
  }

  const pol      = input.policies ?? {};
  const policies = { allowlist: !!pol.allowlist, blocklist: !!pol.blocklist, freeze: !!pol.freeze };
  if (policies.allowlist && policies.blocklist) warnings.push('Both allowlist and blocklist enabled — allowlist takes precedence');
  if (policies.freeze) warnings.push('Freeze & Seize grants admin power to freeze accounts and seize their balances');
  if (adminless && Object.values(policies).some(Boolean)) warnings.push('Compliance policies have no effect when adminless is true');

  return {
    errors, warnings,
    config: {
      name, symbol, variant, decimals,
      supply_cap:   supplyCap,
      admin:        adminless ? null : admin,
      adminless,
      policies,
      contract_uri: input.contract_uri ?? input.contractUri ?? null,
    },
  };
}

// ── handlers ──────────────────────────────────────────────────────────────────

async function handleInfo(net, res) {
  try {
    const gas = await fetchGas(net);
    return res.end(JSON.stringify({
      ok:       true,
      standard: 'B20',
      network:  net === 'mainnet' ? 'Base' : 'Base Sepolia',
      chainId:  CHAIN_ID[net],
      upgrade:  'Base Beryl',
      status:   'gated',
      message:  'B20 deploys go live when Base activates the standard',
      chain: {
        blockNumber:  gas.blockNumber,
        baseFeeGwei:  gas.baseFeeGwei,
        gasTip:       `${gas.tips.normal} gwei (normal)`,
      },
      factory: {
        address: B20_FACTORY,
        note:    'Precompile activates at Base Beryl upgrade',
      },
      variants: [
        { name: 'asset',      description: 'General-purpose. Configurable decimals (6–18), rebasing, issuer metadata.' },
        { name: 'stablecoin', description: 'Fiat-focused. Fixed 6 decimals, currency code field.' },
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
      links: {
        studio:   'https://orlixai.xyz/b20',
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

    const DEPLOY_GAS = 200000n;
    const maxFee     = BigInt(gas.raw.maxFeePerGas);
    const costWei    = DEPLOY_GAS * maxFee;
    const costEth    = Number(costWei) / 1e18;

    return res.end(JSON.stringify({
      ok:        true,
      network:   net,
      chainId:   CHAIN_ID[net],
      blockNumber: gas.blockNumber,
      eip1559: {
        baseFeeGwei:              gas.baseFeeGwei,
        maxFeePerGas:             gas.maxFeePerGas,
        maxFeePerGas_gwei:        gas.baseFeeGwei + ' (approx)',
        maxPriorityFeePerGas:     gas.maxPriorityFeePerGas,
        maxPriorityFeePerGas_gwei:(Number(BigInt(gas.raw.maxPriorityFeePerGas)) / 1e9).toFixed(6) + ' gwei',
        tips:                     gas.tips,
      },
      legacy: { gasPriceGwei: gas.gasPriceGwei },
      deployEstimate: {
        gasUnits:    200000,
        note:        'Approximate — actual gas depends on calldata length (name/symbol)',
        maxCostEth:  costEth.toFixed(8),
        maxCostWei:  costWei.toString(),
        summary:     costEth.toFixed(8) + ' ETH at ' + gas.baseFeeGwei + ' gwei base fee',
      },
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function handleBalance(body, res) {
  const { address, token, network = 'mainnet' } = body;
  const net = ['mainnet', 'sepolia'].includes(network) ? network : 'mainnet';

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address))
    return res.end(JSON.stringify({ ok: false, error: 'address must be a valid 0x Ethereum address' }));

  try {
    const calls = [{ method: 'eth_getBalance', params: [address, 'latest'] }];
    if (token && /^0x[0-9a-fA-F]{40}$/.test(token)) {
      calls.push({
        method: 'eth_call',
        params: [{ to: token, data: '0x' + SEL.balanceOf + '000000000000000000000000' + address.replace('0x', '').toLowerCase() }, 'latest'],
      });
    }

    const results = await batchRpc(net, calls);
    const ethWei  = BigInt(results[0].result ?? '0x0');
    const ethBal  = Number(ethWei) / 1e18;

    const out = {
      ok: true, network: net, chainId: CHAIN_ID[net], address,
      eth: {
        wei:                   ethWei.toString(),
        ether:                 ethBal.toFixed(6),
        sufficient_for_deploy: ethBal >= 0.001,
      },
    };

    if (token && results[1] && !results[1].error) {
      const tokenWei = BigInt(results[1].result ?? '0x0');
      out.token = { address: token, balanceWei: tokenWei.toString() };
    }

    return res.end(JSON.stringify(out));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function handleTokenInfo(body, res) {
  const { address, holder, network = 'mainnet' } = body;
  const net = ['mainnet', 'sepolia'].includes(network) ? network : 'mainnet';

  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address))
    return res.end(JSON.stringify({ ok: false, error: 'address must be a valid token contract address' }));

  try {
    const calls = [
      { method: 'eth_call', params: [{ to: address, data: '0x' + SEL.name        }, 'latest'] },
      { method: 'eth_call', params: [{ to: address, data: '0x' + SEL.symbol      }, 'latest'] },
      { method: 'eth_call', params: [{ to: address, data: '0x' + SEL.decimals    }, 'latest'] },
      { method: 'eth_call', params: [{ to: address, data: '0x' + SEL.totalSupply }, 'latest'] },
    ];

    if (holder && /^0x[0-9a-fA-F]{40}$/.test(holder)) {
      calls.push({
        method: 'eth_call',
        params: [{ to: address, data: '0x' + SEL.balanceOf + '000000000000000000000000' + holder.replace('0x', '').toLowerCase() }, 'latest'],
      });
    }

    const results = await batchRpc(net, calls);

    if (results[0].error)
      return res.end(JSON.stringify({ ok: false, error: 'Not a valid ERC-20 token contract or call failed', address }));

    const name         = decodeString(results[0].result);
    const symbol       = decodeString(results[1].result);
    const decimals     = decodeUint8(results[2].result);
    const supplyRaw    = BigInt(results[3].result ?? '0x0');
    const supply       = Number(supplyRaw) / Math.pow(10, decimals);

    const out = {
      ok: true, network: net, chainId: CHAIN_ID[net], address,
      name, symbol, decimals,
      totalSupply:    supply.toLocaleString(),
      totalSupplyRaw: supplyRaw.toString(),
    };

    if (holder && results[4] && !results[4].error) {
      const balRaw = BigInt(results[4].result ?? '0x0');
      out.holder = {
        address,
        balanceRaw: balRaw.toString(),
        balance:    (Number(balRaw) / Math.pow(10, decimals)).toLocaleString(),
      };
    }

    return res.end(JSON.stringify(out));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function handleValidate(body, res) {
  const { errors, warnings, config } = parseConfig(body);
  const net = ['mainnet', 'sepolia'].includes(body.network) ? body.network : 'mainnet';

  if (errors.length)
    return res.end(JSON.stringify({ ok: false, valid: false, errors, warnings }));

  let chainCheck = null;
  if (config.admin) {
    try {
      const [balResult, gas] = await Promise.all([
        rpc(net, 'eth_getBalance', [config.admin, 'latest']),
        fetchGas(net),
      ]);

      const balWei   = BigInt(balResult ?? '0x0');
      const balEth   = Number(balWei) / 1e18;
      const maxFee   = BigInt(gas.raw.maxFeePerGas);
      const costWei  = 200000n * maxFee;
      const costEth  = Number(costWei) / 1e18;
      const funded   = balWei > costWei;

      if (!funded) warnings.push(`Admin wallet has ${balEth.toFixed(6)} ETH — estimated deploy cost ~${costEth.toFixed(6)} ETH. Fund before deploying.`);

      chainCheck = {
        network: net, chainId: CHAIN_ID[net], blockNumber: gas.blockNumber,
        admin: {
          address:            config.admin,
          ethBalance:         balEth.toFixed(6),
          ethBalanceWei:      balWei.toString(),
          deployCostEstimate: costEth.toFixed(6),
          sufficientBalance:  funded,
        },
        gas: {
          baseFeeGwei:         gas.baseFeeGwei,
          maxFeePerGas:        gas.maxFeePerGas,
          maxPriorityFeePerGas:gas.maxPriorityFeePerGas,
        },
      };
    } catch (e) {
      warnings.push(`Live chain check skipped: ${e.message}`);
    }
  }

  return res.end(JSON.stringify({ ok: true, valid: true, errors: [], warnings, config, chainCheck }));
}

async function handlePrepare(body, res) {
  const { errors, warnings, config } = parseConfig(body);
  const net = ['mainnet', 'sepolia'].includes(body.network) ? body.network : 'mainnet';

  if (errors.length)
    return res.end(JSON.stringify({ ok: false, valid: false, errors, warnings }));

  const policyBits = (config.policies.allowlist ? 1 : 0)
                   | (config.policies.blocklist  ? 2 : 0)
                   | (config.policies.freeze     ? 4 : 0);

  const cd = buildCalldata(config, policyBits);

  let gas = null, nonce = null, ethBalance = null;

  try {
    const adminAddr = config.admin ?? '0x0000000000000000000000000000000000000000';
    const [gasResult, nonceResult, balResult] = await Promise.all([
      fetchGas(net),
      rpc(net, 'eth_getTransactionCount', [adminAddr, 'latest']),
      config.admin ? rpc(net, 'eth_getBalance', [config.admin, 'latest']) : Promise.resolve('0x0'),
    ]);

    gas   = gasResult;
    nonce = parseInt(nonceResult ?? '0x0', 16);

    const balWei  = BigInt(balResult ?? '0x0');
    const balEth  = Number(balWei) / 1e18;
    const maxFee  = BigInt(gas.raw.maxFeePerGas);
    const costWei = 200000n * maxFee;
    const costEth = Number(costWei) / 1e18;

    ethBalance = { wei: balWei.toString(), ether: balEth.toFixed(6) };

    if (balWei < costWei)
      warnings.push(`Admin wallet has ${balEth.toFixed(6)} ETH — estimated cost ~${costEth.toFixed(6)} ETH. Fund before deploying.`);
  } catch (e) {
    warnings.push(`Live chain data fetch failed: ${e.message} — fill nonce/gas manually before signing`);
  }

  const maxFeeHex  = gas?.maxFeePerGas ?? null;
  const tipHex     = gas?.maxPriorityFeePerGas ?? null;
  const maxFeeGwei = maxFeeHex ? (Number(BigInt(maxFeeHex)) / 1e9).toFixed(6) : null;
  const tipGwei    = tipHex    ? (Number(BigInt(tipHex))    / 1e9).toFixed(6) : null;

  const DEPLOY_GAS_UNITS = 200000;
  const deployCostEth = maxFeeHex
    ? (Number(BigInt(maxFeeHex) * BigInt(DEPLOY_GAS_UNITS)) / 1e18).toFixed(8)
    : null;

  // Human-readable summary for agents / display
  const txSummary = {
    to:               'B20 Factory Precompile (Base Beryl)',
    toAddress:        B20_FACTORY,
    network:          net === 'mainnet' ? 'Base Mainnet' : 'Base Sepolia',
    chainId:          CHAIN_ID[net],
    gasLimit:         `${DEPLOY_GAS_UNITS.toLocaleString()} units`,
    maxFeePerGas:     maxFeeGwei ? `${maxFeeGwei} gwei (${maxFeeHex})` : 'unknown',
    maxPriorityFee:   tipGwei    ? `${tipGwei} gwei (${tipHex})`    : 'unknown',
    nonce:            nonce !== null ? nonce : 'unknown',
    value:            '0 ETH',
    estimatedCost:    deployCostEth ? `~${deployCostEth} ETH at current Base gas` : 'unknown',
    calldataSelector: cd.selector + ' (placeholder — updated at Beryl activation)',
    status:           'ready to sign once Base Beryl activates',
  };

  const tx = {
    type:                 '0x02',
    chainId:              '0x' + CHAIN_ID[net].toString(16),
    to:                   B20_FACTORY,
    value:                '0x0',
    data:                 cd.calldata,
    gas:                  '0x' + DEPLOY_GAS_UNITS.toString(16),
    maxFeePerGas:         maxFeeHex,
    maxPriorityFeePerGas: tipHex,
    nonce:                nonce !== null ? '0x' + nonce.toString(16) : null,
  };

  return res.end(JSON.stringify({
    ok:      true,
    status:  'prepared',
    gated:   true,
    message: 'Config valid. Sign and broadcast once Base Beryl activates.',

    config,

    txSummary,

    chain: {
      network: net, chainId: CHAIN_ID[net],
      blockNumber: gas?.blockNumber ?? null,
      adminBalance: ethBalance,
      gas: gas ? {
        baseFeeGwei:         gas.baseFeeGwei,
        maxFeePerGas:        maxFeeGwei ? `${maxFeeGwei} gwei` : gas.maxFeePerGas,
        maxPriorityFeePerGas:tipGwei    ? `${tipGwei} gwei`    : gas.maxPriorityFeePerGas,
      } : null,
    },

    deployment: {
      factory:    B20_FACTORY,
      network:    net,
      chainId:    CHAIN_ID[net],
      policyBits,
      calldata: {
        data:           cd.calldata,
        selector:       cd.selector,
        selectorStatus: cd.selectorNote,
        abiSig:         cd.abiSig,
      },
      tx,
      txNote: 'EIP-1559 unsigned tx — gas/nonce fetched live from Base. Sign with wallet once Beryl activates.',
    },

    warnings,

    links: {
      studio: 'https://orlixai.xyz/b20',
    },
  }));
}

async function handleReceipt(body, res) {
  const { tx_hash, network = 'mainnet' } = body;
  const net = ['mainnet', 'sepolia'].includes(network) ? network : 'mainnet';

  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))
    return res.end(JSON.stringify({ ok: false, error: 'tx_hash must be a 0x transaction hash (66 hex chars)' }));

  try {
    const receipt = await rpc(net, 'eth_getTransactionReceipt', [tx_hash]);

    if (!receipt) {
      return res.end(JSON.stringify({
        ok: true, found: false, tx_hash, network: net,
        status: 'pending',
        message: 'Transaction not yet mined — try again in a few seconds',
      }));
    }

    const success = receipt.status === '0x1';

    // Extract deployed token address from contract creation or factory logs
    let deployedToken = receipt.contractAddress ?? null;
    if (!deployedToken && success && receipt.logs?.length > 0) {
      // B20 factory likely emits TokenCreated(address indexed token, address indexed admin, ...)
      // topic[0] = event selector, topic[1] = token address (indexed)
      const log = receipt.logs.find(l => l.address?.toLowerCase() === B20_FACTORY.toLowerCase());
      if (log?.topics?.[1]) {
        deployedToken = '0x' + log.topics[1].slice(26);
      }
    }

    return res.end(JSON.stringify({
      ok:           true,
      found:        true,
      tx_hash,
      network:      net,
      chainId:      CHAIN_ID[net],
      status:       success ? 'success' : 'failed',
      blockNumber:  parseInt(receipt.blockNumber ?? '0x0', 16),
      blockHash:    receipt.blockHash,
      gasUsed:      parseInt(receipt.gasUsed ?? '0x0', 16),
      from:         receipt.from,
      to:           receipt.to,
      deployedToken,
      logCount:     receipt.logs?.length ?? 0,
      receipt,
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

function handleManifest(res) {
  const schema = b20Schema();
  return res.end(JSON.stringify({
    schema:      'orlix-skill/2.0',
    id:          'orlix.b20',
    name:        'Orlix B20 Token Skill',
    version:     '2.0.0',
    description: 'Full B20 token lifecycle on Base: live chain data, balance checks, config validation, deployment bundles, ERC-20 reads, tx receipts. Real Base RPC calls — no mocks.',
    endpoint:    'https://orlixai.xyz/api/b20-skill',
    networks:    { mainnet: { chainId: 8453, rpc: 'https://mainnet.base.org' }, sepolia: { chainId: 84532, rpc: 'https://sepolia.base.org' } },

    actions: {
      GET:  ['manifest', 'info', 'gas'],
      POST: ['validate', 'prepare', 'balance', 'token_info', 'receipt'],
    },

    tools: [
      {
        name:        'b20_info',
        description: 'Live Base chain status + gas prices + B20 standard details. No params required.',
        input_schema: { type: 'object', properties: { network: netProp() } },
      },
      {
        name:        'b20_gas',
        description: 'Current EIP-1559 gas prices on Base with B20 deploy cost estimate.',
        input_schema: { type: 'object', properties: { network: netProp() } },
      },
      {
        name:        'b20_balance',
        description: 'Check ETH balance (and optionally ERC-20 balance) for any address on Base.',
        input_schema: {
          type: 'object', required: ['address'],
          properties: {
            address: { type: 'string', description: '0x wallet address' },
            token:   { type: 'string', description: 'Optional ERC-20 contract address to also check' },
            network: netProp(),
          },
        },
      },
      {
        name:        'b20_token_info',
        description: 'Read name, symbol, decimals, total supply for any ERC-20 on Base. Optional holder balance.',
        input_schema: {
          type: 'object', required: ['address'],
          properties: {
            address: { type: 'string', description: 'Token contract address (0x...)' },
            holder:  { type: 'string', description: 'Optional wallet address to check balance for' },
            network: netProp(),
          },
        },
      },
      {
        name:        'b20_validate',
        description: 'Validate B20 token config + live admin ETH balance + gas estimate from Base RPC.',
        input_schema: { type: 'object', ...schema },
      },
      {
        name:        'b20_prepare',
        description: 'Build complete EIP-1559 B20 deployment tx with live gas + nonce from Base. Ready to sign once Beryl activates.',
        input_schema: { type: 'object', ...schema },
      },
      {
        name:        'b20_receipt',
        description: 'Check tx hash on Base — returns success/pending/failed + deployed token address from logs.',
        input_schema: {
          type: 'object', required: ['tx_hash'],
          properties: {
            tx_hash: { type: 'string', description: '0x transaction hash (66 hex chars)' },
            network: netProp(),
          },
        },
      },
    ],

    openai_functions: [
      { name: 'b20_validate',    description: 'Validate B20 config + live chain check',            parameters: { type: 'object', ...schema } },
      { name: 'b20_prepare',     description: 'Prepare B20 deployment tx with real gas + nonce',   parameters: { type: 'object', ...schema } },
      { name: 'b20_token_info',  description: 'Read any ERC-20 on Base',
        parameters: { type: 'object', required: ['address'], properties: { address: { type: 'string' }, holder: { type: 'string' }, network: netProp() } } },
      { name: 'b20_balance',     description: 'ETH + optional token balance on Base',
        parameters: { type: 'object', required: ['address'], properties: { address: { type: 'string' }, token: { type: 'string' }, network: netProp() } } },
      { name: 'b20_receipt',     description: 'Tx status + deployed token address',
        parameters: { type: 'object', required: ['tx_hash'], properties: { tx_hash: { type: 'string' }, network: netProp() } } },
    ],

    links: {
      studio:   'https://orlixai.xyz/b20',
      app:      'https://orlixai.xyz',
      manifest: 'https://orlixai.xyz/api/b20-skill?action=manifest',
    },
  }));
}

function netProp() {
  return { type: 'string', enum: ['mainnet', 'sepolia'], default: 'mainnet', description: 'mainnet=Base (8453), sepolia=Base Sepolia (84532)' };
}

function b20Schema() {
  return {
    properties: {
      action: { type: 'string', enum: ['validate', 'prepare'], description: 'validate: check + live chain. prepare: validate + build full deployment tx.' },
      name:   { type: 'string', description: 'Full token name, max 64 chars. Example: "BNKR Token"' },
      symbol: { type: 'string', description: 'Ticker, max 11 alphanumeric chars. Example: "BNKR"' },
      variant: { type: 'string', enum: ['asset', 'stablecoin'], default: 'asset', description: 'asset: 6–18 decimals. stablecoin: fixed 6 decimals.' },
      decimals: { type: 'integer', minimum: 6, maximum: 18, default: 18, description: 'Token precision (6–18). Fixed at 6 for stablecoin.' },
      supply_cap: { type: 'string', default: '0', description: 'Max supply as integer string. "0" = uncapped. Example: "1000000000"' },
      admin: { type: 'string', description: '0x admin wallet. Gets all roles at deploy. Required unless adminless: true.' },
      adminless: { type: 'boolean', default: false, description: 'No admin — irreversible.' },
      policies: {
        type: 'object',
        properties: {
          allowlist: { type: 'boolean', default: false, description: 'Only allowlisted addresses can hold/receive.' },
          blocklist: { type: 'boolean', default: false, description: 'Blocked addresses cannot transfer.' },
          freeze:    { type: 'boolean', default: false, description: 'Admin can freeze + seize balances.' },
        },
      },
      contract_uri: { type: 'string', description: 'IPFS URI for token metadata. Example: "ipfs://bafkrei..."' },
      network: netProp(),
    },
    required: ['name', 'symbol', 'admin'],
  };
}

// ── router ────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.writeHead(200, CORS);
  if (req.method === 'OPTIONS') return res.end();

  try {
    const body   = req.method === 'POST' ? (req.body ?? {}) : (req.query ?? {});
    const action = body.action ?? (req.method === 'GET' ? 'manifest' : 'prepare');
    const net    = ['mainnet', 'sepolia'].includes(body.network ?? req.query?.network)
      ? (body.network ?? req.query?.network)
      : 'mainnet';

    if (action === 'manifest')                        return handleManifest(res);
    if (action === 'info')                            return handleInfo(net, res);
    if (action === 'gas')                             return handleGas(net, res);
    if (action === 'balance')                         return handleBalance(body, res);
    if (action === 'token_info' || action === 'token')return handleTokenInfo(body, res);
    if (action === 'validate')                        return handleValidate(body, res);
    if (action === 'prepare' || action === 'deploy')  return handlePrepare(body, res);
    if (action === 'receipt')                         return handleReceipt(body, res);

    return res.end(JSON.stringify({
      ok: false,
      error: `Unknown action: "${action}"`,
      valid_actions: { GET: ['manifest', 'info', 'gas'], POST: ['validate', 'prepare', 'balance', 'token_info', 'receipt'] },
    }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
};
