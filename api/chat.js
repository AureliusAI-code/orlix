// Vercel Serverless Function — /api/chat
// Routes to providers:
//   mimo-*   → api.xiaomimimo.com   (MIMO_API_KEY)
//   claude-* → llm.bankr.bot/v1/messages  (BANKR_LLM_KEY) — Anthropic format + Base MCP tools
//   all else → llm.bankr.bot/v1/chat/completions (BANKR_LLM_KEY) — OpenAI-compatible

// ── Tool definitions (Base MCP tools for Claude) ──────────────────────────────
const ALL_TOOLS = [
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
  },
  {
    name: 'web_search',
    description: 'Search the web for current information, news, prices, research papers, or any topic',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Number of results 1-10, default 5' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_webpage',
    description: 'Fetch and read content from any public URL or webpage',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' }
      },
      required: ['url']
    }
  },
  {
    name: 'github_repo_info',
    description: 'Get details about a GitHub repository: stars, description, language, topics, issues',
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'GitHub username or organization' },
        repo: { type: 'string', description: 'Repository name' }
      },
      required: ['owner', 'repo']
    }
  }
];

// ── Base MCP tool executor ────────────────────────────────────────────────────
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
          hash:           tx.hash,
          from:           tx.from,
          to:             tx.to,
          value_eth:      (parseInt(tx.value, 16) / 1e18).toFixed(8),
          gas_price_gwei: (parseInt(tx.gasPrice, 16) / 1e9).toFixed(6),
          block_number:   tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
          status:         receipt ? (receipt.status === '0x1' ? 'success' : 'failed') : 'pending',
          network:        'Base Mainnet',
          chain_id:       8453
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
        const data = '0x70a08231' + input.wallet_address.replace('0x', '').padStart(64, '0');
        const hex  = await rpc('eth_call', [{ to: input.token_address, data }, 'latest']);
        const raw  = parseInt(hex, 16);
        return {
          wallet:      input.wallet_address,
          token:       input.token_address,
          balance_raw: raw.toString(),
          network:     'Base Mainnet',
          chain_id:    8453,
          note:        'Divide balance_raw by 10^decimals to get human-readable amount'
        };
      }
      case 'base_get_network_info': {
        const [blockHex, gasPriceHex, chainIdHex] = await Promise.all([
          rpc('eth_blockNumber', []),
          rpc('eth_gasPrice', []),
          rpc('eth_chainId', []),
        ]);
        return {
          chain_id:       parseInt(chainIdHex, 16),
          network:        'Base Mainnet',
          latest_block:   parseInt(blockHex, 16),
          gas_price_gwei: (parseInt(gasPriceHex, 16) / 1e9).toFixed(6),
          rpc_endpoint:   BASE_RPC,
          explorer:       'https://basescan.org',
          bridge:         'https://bridge.base.org',
        };
      }
      case 'web_search': {
        const braveKey = process.env.BRAVE_API_KEY;
        const count = Math.min(input.count || 5, 10);
        if (braveKey) {
          const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=${count}`, {
            headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveKey }
          });
          const data = await r.json();
          const results = (data.web?.results || []).slice(0, count).map(r => ({
            title: r.title, url: r.url, description: r.description, published: r.age
          }));
          return { query: input.query, results, source: 'Brave Search' };
        }
        const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_html=1&skip_disambig=1`);
        const data = await r.json();
        const results = [];
        if (data.AbstractText) results.push({ title: data.Heading, description: data.AbstractText, url: data.AbstractURL });
        (data.RelatedTopics || []).slice(0, 4).forEach(t => {
          if (t.Text) results.push({ title: t.Text.split(' - ')[0], description: t.Text, url: t.FirstURL });
        });
        return { query: input.query, results, source: 'DuckDuckGo (add BRAVE_API_KEY for full web search)' };
      }
      case 'fetch_webpage': {
        const r = await fetch(input.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrlixAgent/1.0)' },
          redirect: 'follow'
        });
        if (!r.ok) return { error: `HTTP ${r.status}`, url: input.url };
        const html = await r.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000);
        return { url: input.url, content: text, chars: text.length };
      }
      case 'github_repo_info': {
        const r = await fetch(`https://api.github.com/repos/${input.owner}/${input.repo}`, {
          headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'OrlixAgent/1.0' }
        });
        if (!r.ok) return { error: `Repo not found: ${input.owner}/${input.repo}` };
        const d = await r.json();
        return {
          full_name: d.full_name, description: d.description,
          stars: d.stargazers_count, forks: d.forks_count,
          language: d.language, topics: d.topics,
          open_issues: d.open_issues_count, license: d.license?.name,
          created: d.created_at, updated: d.updated_at,
          url: d.html_url, homepage: d.homepage
        };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message, tool: name };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function pipeStream(upstream, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {}
  res.end();
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
  const isMimo   = model.startsWith('mimo');
  const isClaude = model.startsWith('claude');

  // ── Mimo ─────────────────────────────────────────────────────────────────
  if (isMimo) {
    const key = process.env.MIMO_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'MIMO_API_KEY not set in Vercel Environment Variables.' } });
    try {
      const noToolInstruction = 'IMPORTANT: Answer every question directly in plain text. Do NOT output any XML tags whatsoever — no <tool_call>, no <invoke>, no <function_calls>, no <parameter>, no XML of any kind. Never use function-calling syntax. Use only your own knowledge to answer.';
      let msgs = bodyObj.messages || [];
      if (msgs.length && msgs[0].role === 'system') {
        msgs = [{ ...msgs[0], content: noToolInstruction + '\n\n' + msgs[0].content }, ...msgs.slice(1)];
      } else {
        msgs = [{ role: 'system', content: noToolInstruction }, ...msgs];
      }
      const body = { model: bodyObj.model, messages: msgs, max_tokens: bodyObj.max_tokens || 4096 };
      if (bodyObj.temperature != null) body.temperature = bodyObj.temperature;
      if (bodyObj.stream) {
        body.stream = true;
        const r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: JSON.stringify(body),
        });
        if (!r.ok) return res.status(r.status).json({ error: { message: 'Mimo error' } });
        return pipeStream(r, res);
      }
      const r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(body),
      });
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(await r.text());
    } catch (e) { return res.status(502).json({ error: { message: 'Mimo error: ' + e.message } }); }
  }

  // ── All other models → Bankr LLM Gateway ─────────────────────────────────
  const lllKey = process.env.BANKR_LLM_KEY || '';
  if (!lllKey) return res.status(401).json({ error: { message: 'BANKR_LLM_KEY not set in Vercel Environment Variables. Get a key at bankr.bot/api-keys with LLM Gateway enabled.' } });

  const bankrHeaders = {
    'Content-Type': 'application/json',
    'X-API-Key':    lllKey,
  };

  // Claude → Anthropic format via Bankr gateway (keeps Base MCP tool loop)
  if (isClaude) {
    function toAnthropicMessages(messages) {
      return messages.filter(m => m.role !== 'system').map(m => {
        if (!Array.isArray(m.content)) return m;
        return {
          ...m,
          content: m.content.map(block => {
            if (block.type === 'image_url' && block.image_url?.url?.startsWith('data:')) {
              const [header, data] = block.image_url.url.split(',');
              const media_type = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
              return { type: 'image', source: { type: 'base64', media_type, data } };
            }
            return block;
          })
        };
      });
    }

    try {
      const body = {
        model:      bodyObj.model,
        messages:   toAnthropicMessages(bodyObj.messages || []),
        max_tokens: bodyObj.max_tokens || 4096,
        tools:      ALL_TOOLS,
      };
      if (bodyObj.system)      body.system      = bodyObj.system;
      if (bodyObj.temperature) body.temperature = bodyObj.temperature;

      let r    = await fetch('https://llm.bankr.bot/v1/messages', { method: 'POST', headers: bankrHeaders, body: JSON.stringify(body) });
      let text = await r.text();

      if (!r.ok) {
        let msg = text;
        try { msg = JSON.parse(text).error?.message || text; } catch {}
        return res.status(r.status).json({ error: { message: 'Claude (Bankr): ' + msg } });
      }

      let data = JSON.parse(text);

      // Tool use agentic loop — up to 5 rounds
      let round = 0;
      while (data.stop_reason === 'tool_use' && round < 5) {
        round++;
        const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
        const toolResults = await Promise.all(
          toolUseBlocks.map(async b => ({
            type:        'tool_result',
            tool_use_id: b.id,
            content:     JSON.stringify(await executeTool(b.name, b.input)),
          }))
        );
        body.messages = [
          ...body.messages,
          { role: 'assistant', content: data.content },
          { role: 'user',      content: toolResults },
        ];
        r    = await fetch('https://llm.bankr.bot/v1/messages', { method: 'POST', headers: bankrHeaders, body: JSON.stringify(body) });
        text = await r.text();
        if (!r.ok) {
          let msg = text;
          try { msg = JSON.parse(text).error?.message || text; } catch {}
          return res.status(r.status).json({ error: { message: 'Claude tool loop (Bankr): ' + msg } });
        }
        data = JSON.parse(text);
      }
      return res.status(200).setHeader('Content-Type', 'application/json').send(JSON.stringify(data));
    } catch (e) {
      return res.status(502).json({ error: { message: 'Claude error: ' + e.message } });
    }
  }

  // All non-Claude, non-Mimo models → OpenAI-compatible via Bankr gateway
  try {
    // Strip groq- prefix — Bankr gateway uses the base model name
    const resolvedModel = model.startsWith('groq-') ? bodyObj.model.slice(5) : bodyObj.model;
    const body = {
      model:      resolvedModel,
      messages:   bodyObj.messages || [],
      max_tokens: bodyObj.max_tokens || 4096,
    };
    if (bodyObj.temperature != null) body.temperature = bodyObj.temperature;
    if (bodyObj.stream) {
      body.stream = true;
      const r = await fetch('https://llm.bankr.bot/v1/chat/completions', {
        method: 'POST', headers: bankrHeaders, body: JSON.stringify(body)
      });
      if (!r.ok) {
        const errText = await r.text();
        let msg = errText;
        try { msg = JSON.parse(errText).error?.message || errText; } catch {}
        return res.status(r.status).json({ error: { message: 'Bankr LLM: ' + msg } });
      }
      return pipeStream(r, res);
    }
    const r    = await fetch('https://llm.bankr.bot/v1/chat/completions', {
      method: 'POST', headers: bankrHeaders, body: JSON.stringify(body)
    });
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error?.message || text; } catch {}
      return res.status(r.status).json({ error: { message: 'Bankr LLM: ' + msg } });
    }
    return res.status(200).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    return res.status(502).json({ error: { message: 'Bankr LLM error: ' + e.message } });
  }
};
