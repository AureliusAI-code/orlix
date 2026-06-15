// Vercel Serverless Function — /api/chat
// Routes to the right provider based on model name:
//   claude-*          → api.anthropic.com   (ANTHROPIC_API_KEY env var) + Base MCP tools
//   grok-*            → api.x.ai            (XAI_API_KEY env var)
//   gpt-* / o1/o3/o4  → api.openai.com      (OPENAI_API_KEY env var)
//   others            → api.bankr.bot        (x-api-key header from user settings)
const crypto = require('crypto');

// ── Base MCP: tool definitions ────────────────────────────────────────────────
const BASE_TOOLS = [
  {
    name: 'base_get_eth_balance',
    description: 'Get the ETH balance of a wallet address on Base network (L2)',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Ethereum wallet address (0x...)' }
      },
      required: ['address']
    }
  },
  {
    name: 'base_get_gas_price',
    description: 'Get the current gas price on Base network in gwei',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'base_get_transaction',
    description: 'Get details of a transaction on Base network by its hash',
    input_schema: {
      type: 'object',
      properties: {
        tx_hash: { type: 'string', description: 'Transaction hash (0x...)' }
      },
      required: ['tx_hash']
    }
  },
  {
    name: 'base_get_latest_block',
    description: 'Get the latest block information on Base network including transaction count and gas usage',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'base_get_token_balance',
    description: 'Get ERC20 token balance for a wallet address on Base network',
    input_schema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string', description: 'Wallet address to check' },
        token_address:  { type: 'string', description: 'ERC20 token contract address on Base' }
      },
      required: ['wallet_address', 'token_address']
    }
  },
  {
    name: 'base_get_network_info',
    description: 'Get general information about the Base network (chain ID, latest block, gas price)',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── Base MCP: tool executor (via Base public RPC) ─────────────────────────────
const BASE_RPC = 'https://mainnet.base.org';

async function rpc(method, params = []) {
  const r = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'base_get_eth_balance': {
        const hex = await rpc('eth_getBalance', [input.address, 'latest']);
        const eth = (parseInt(hex, 16) / 1e18).toFixed(8);
        return { address: input.address, balance_eth: eth, network: 'Base Mainnet', chain_id: 8453 };
      }
      case 'base_get_gas_price': {
        const hex = await rpc('eth_gasPrice', []);
        const gwei = (parseInt(hex, 16) / 1e9).toFixed(6);
        return { gas_price_gwei: gwei, network: 'Base Mainnet', chain_id: 8453 };
      }
      case 'base_get_transaction': {
        const tx = await rpc('eth_getTransactionByHash', [input.tx_hash]);
        if (!tx) return { error: 'Transaction not found', tx_hash: input.tx_hash };
        const receipt = await rpc('eth_getTransactionReceipt', [input.tx_hash]).catch(() => null);
        return {
          hash:        tx.hash,
          from:        tx.from,
          to:          tx.to,
          value_eth:   (parseInt(tx.value, 16) / 1e18).toFixed(8),
          gas_price_gwei: (parseInt(tx.gasPrice, 16) / 1e9).toFixed(6),
          block_number: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
          status:      receipt ? (receipt.status === '0x1' ? 'success' : 'failed') : 'pending',
          network:     'Base Mainnet',
          chain_id:    8453
        };
      }
      case 'base_get_latest_block': {
        const b = await rpc('eth_getBlockByNumber', ['latest', false]);
        return {
          block_number:      parseInt(b.number, 16),
          hash:              b.hash,
          timestamp:         new Date(parseInt(b.timestamp, 16) * 1000).toISOString(),
          transaction_count: b.transactions.length,
          gas_used:          parseInt(b.gasUsed, 16),
          gas_limit:         parseInt(b.gasLimit, 16),
          base_fee_gwei:     b.baseFeePerGas ? (parseInt(b.baseFeePerGas, 16) / 1e9).toFixed(6) : null,
          network:           'Base Mainnet',
          chain_id:          8453
        };
      }
      case 'base_get_token_balance': {
        // ERC20 balanceOf(address) selector = 0x70a08231
        const data = '0x70a08231' + input.wallet_address.replace('0x', '').padStart(64, '0');
        const hex  = await rpc('eth_call', [{ to: input.token_address, data }, 'latest']);
        const raw  = parseInt(hex, 16);
        return {
          wallet:       input.wallet_address,
          token:        input.token_address,
          balance_raw:  raw.toString(),
          network:      'Base Mainnet',
          chain_id:     8453,
          note:         'Divide balance_raw by 10^decimals to get human-readable amount'
        };
      }
      case 'base_get_network_info': {
        const [blockHex, gasPriceHex, chainIdHex] = await Promise.all([
          rpc('eth_blockNumber', []),
          rpc('eth_gasPrice', []),
          rpc('eth_chainId', []),
        ]);
        return {
          chain_id:           parseInt(chainIdHex, 16),
          network:            'Base Mainnet',
          latest_block:       parseInt(blockHex, 16),
          gas_price_gwei:     (parseInt(gasPriceHex, 16) / 1e9).toFixed(6),
          rpc_endpoint:       BASE_RPC,
          explorer:           'https://basescan.org',
          bridge:             'https://bridge.base.org',
        };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message, tool: name };
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('x-orlix-proxy', '1');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const bodyObj = typeof req.body === 'object' && req.body !== null
    ? req.body : JSON.parse(req.body || '{}');

  const model    = (bodyObj.model || '').toLowerCase();
  const isClaude = model.startsWith('claude');
  const isGrok   = model.startsWith('grok');
  const isOpenAI = model.startsWith('gpt-') || /^o[134]/.test(model);

  async function callCompat(url, key) {
    const body = { model: bodyObj.model, messages: bodyObj.messages || [], max_tokens: bodyObj.max_tokens || 2048 };
    if (bodyObj.temperature != null) body.temperature = bodyObj.temperature;
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify(body) });
  }

  // ── Anthropic / Claude + Base MCP tools ──────────────────────────────────
  if (isClaude) {
    const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || process.env.ANT_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'ANTHROPIC_API_KEY not set in Vercel Environment Variables. Add it and redeploy.' } });

    const anthropicHeaders = {
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01',
    };

    try {
      const body = {
        model:      bodyObj.model,
        messages:   (bodyObj.messages || []).filter(m => m.role !== 'system'),
        max_tokens: bodyObj.max_tokens || 2048,
        tools:      BASE_TOOLS,
      };
      if (bodyObj.system)      body.system      = bodyObj.system;
      if (bodyObj.temperature) body.temperature = bodyObj.temperature;

      let r    = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: anthropicHeaders, body: JSON.stringify(body) });
      let text = await r.text();

      if (!r.ok) {
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch {}
        return res.status(r.status).json({ error: { message: 'Anthropic: ' + msg } });
      }

      let data = JSON.parse(text);

      // Tool use loop — execute Base tools and send results back to Claude
      if (data.stop_reason === 'tool_use') {
        const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
        const toolResults   = await Promise.all(
          toolUseBlocks.map(async b => ({
            type:        'tool_result',
            tool_use_id: b.id,
            content:     JSON.stringify(await executeTool(b.name, b.input)),
          }))
        );

        const body2 = {
          ...body,
          messages: [
            ...body.messages,
            { role: 'assistant', content: data.content },
            { role: 'user',      content: toolResults  },
          ],
        };

        r    = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: anthropicHeaders, body: JSON.stringify(body2) });
        text = await r.text();

        if (!r.ok) {
          let msg = text;
          try { msg = JSON.parse(text).error?.message || text; } catch {}
          return res.status(r.status).json({ error: { message: 'Anthropic (after tool): ' + msg } });
        }
      }

      return res.status(200).setHeader('Content-Type', 'application/json').send(text);
    } catch (e) {
      return res.status(502).json({ error: { message: 'Anthropic error: ' + e.message } });
    }
  }

  // ── Grok / xAI ────────────────────────────────────────────────────────────
  if (isGrok) {
    const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'XAI_API_KEY not set in Vercel Environment Variables.' } });
    try {
      const r = await callCompat('https://api.x.ai/v1/chat/completions', key);
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(await r.text());
    } catch (e) { return res.status(502).json({ error: { message: 'xAI error: ' + e.message } }); }
  }

  // ── OpenAI ────────────────────────────────────────────────────────────────
  if (isOpenAI) {
    const key = process.env.OPENAI_API_KEY || process.env.OPEN_AI_API_KEY || process.env.OPENAI_KEY || process.env.OPEN_AI_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'OpenAI API key not found. Add OPENAI_API_KEY in Vercel → Settings → Environment Variables, then redeploy.' } });
    try {
      const r    = await callCompat('https://api.openai.com/v1/chat/completions', key);
      const text = await r.text();
      if (!r.ok) {
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch {}
        return res.status(r.status).json({ error: { message: 'OpenAI: ' + msg } });
      }
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(text);
    } catch (e) { return res.status(502).json({ error: { message: 'OpenAI error: ' + e.message } }); }
  }

  const apiKey = req.headers['x-api-key'] || '';

  // ── x402.bankr.bot (pay-per-use) ─────────────────────────────────────────
  if (!apiKey) {
    const privKey = process.env.BANKR_PRIVATE_KEY || '';
    if (!privKey) {
      return res.status(401).json({
        error: { message: 'No API key. Add your bankr.bot key in Settings, or set BANKR_PRIVATE_KEY in Vercel for $0.01 USDC/request mode.' }
      });
    }
    const messages  = bodyObj.messages || [];
    const prompt    = messages.map(m => {
      const c = Array.isArray(m.content) ? m.content.map(b => b.text || '').join('') : (m.content || '');
      return `${m.role}: ${c}`;
    }).join('\n\n');
    const x402Model = bodyObj.model || 'gpt-4o-mini';

    let r1;
    try {
      r1 = await fetch('https://x402.bankr.bot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
    } catch (e) { return res.status(502).json({ error: { message: 'x402 fetch error: ' + e.message } }); }

    if (r1.status !== 402) {
      const text = await r1.text();
      try {
        const data  = JSON.parse(text);
        const reply = data.response || data.content || data.text || data.choices?.[0]?.message?.content || text;
        return res.json({ content: [{ type: 'text', text: String(reply) }], usage: data.usage || {} });
      } catch { return res.status(r1.status).json({ error: { message: text.slice(0, 200) } }); }
    }

    let paymentDetails;
    try { paymentDetails = await r1.json(); } catch { paymentDetails = {}; }

    const nonce         = paymentDetails.nonce || crypto.randomUUID();
    const timestamp     = Date.now();
    const payload       = JSON.stringify({ nonce, timestamp, model: x402Model, amount: '0.01', currency: 'USDC' });
    const sig           = crypto.createHmac('sha256', privKey).update(payload).digest('hex');
    const paymentHeader = Buffer.from(JSON.stringify({ payload, sig, version: '1' })).toString('base64');

    let r2;
    try {
      r2 = await fetch('https://x402.bankr.bot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x402-payment': paymentHeader }, body: JSON.stringify({ prompt }) });
    } catch (e) { return res.status(502).json({ error: { message: 'x402 payment retry error: ' + e.message } }); }

    const text2 = await r2.text();
    if (!r2.ok) return res.status(r2.status).json({ error: { message: `x402 payment failed (${r2.status}): ${text2.slice(0, 200)}` } });

    try {
      const data  = JSON.parse(text2);
      const reply = data.response || data.content || data.text || data.choices?.[0]?.message?.content || text2;
      return res.json({ content: [{ type: 'text', text: String(reply) }], usage: data.usage || {} });
    } catch { return res.json({ content: [{ type: 'text', text: text2 }], usage: {} }); }
  }

  // ── api.bankr.bot (user API key) ─────────────────────────────────────────
  const bankrHeaders = { 'Content-Type': 'application/json', 'x-api-key': apiKey };

  async function tryBankr(path) {
    const r    = await fetch('https://api.bankr.bot' + path, { method: 'POST', headers: bankrHeaders, body: JSON.stringify(bodyObj) });
    const text = await r.text();
    return { status: r.status, text };
  }

  try {
    let { status, text } = await tryBankr('/v1/messages');
    if (status === 404) {
      const r2 = await tryBankr('/v1/chat/completions');
      if (r2.status !== 404) { status = r2.status; text = r2.text; }
    }

    let isJson = true;
    try { JSON.parse(text); } catch { isJson = false; }

    if (!isJson || status === 404) {
      return res.status(status).json({
        error: {
          message: `bankr.bot error (HTTP ${status}): ${text.replace(/<[^>]+>/g, '').trim().slice(0, 300)}`,
          hint:    status === 404 ? 'bankr.bot API endpoint not found.' : 'Your bankr.bot API key may be invalid or expired.'
        }
      });
    }

    res.status(status).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Proxy error: ' + e.message } });
  }
};
