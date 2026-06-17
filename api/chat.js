// Vercel Serverless Function — /api/chat
// Routes to the right provider based on model name:
//   mimo-*            → api.xiaomimimo.com  (MIMO_API_KEY env var) — primary engine
//   claude-*          → api.anthropic.com   (ANTHROPIC_API_KEY env var) + Base MCP tools
//   grok-*            → api.x.ai            (XAI_API_KEY env var)
//   gpt-* / o1/o3/o4  → api.openai.com      (OPENAI_API_KEY env var)

// ── Tool definitions (Base MCP + Aeon agentic tools) ─────────────────────────
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
        // Fallback: DuckDuckGo instant answers
        const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(input.query)}&format=json&no_html=1&skip_disambig=1`);
        const data = await r.json();
        const results = [];
        if (data.AbstractText) results.push({ title: data.Heading, description: data.AbstractText, url: data.AbstractURL });
        (data.RelatedTopics || []).slice(0, 4).forEach(t => {
          if (t.Text) results.push({ title: t.Text.split(' - ')[0], description: t.Text, url: t.FirstURL });
        });
        return { query: input.query, results, source: 'DuckDuckGo (add BRAVE_API_KEY env var for full web search)' };
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
  const isGrok   = model.startsWith('grok');
  const isOpenAI = model.startsWith('gpt-') || /^o[134]/.test(model);

  async function callCompat(url, key) {
    const body = { model: bodyObj.model, messages: bodyObj.messages || [], max_tokens: bodyObj.max_tokens || 4096 };
    if (bodyObj.temperature != null) body.temperature = bodyObj.temperature;
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, body: JSON.stringify(body) });
  }

  // ── Mimo (primary engine) ────────────────────────────────────────────────
  if (isMimo) {
    const key = process.env.MIMO_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'MIMO_API_KEY not set in Vercel Environment Variables. Add it and redeploy.' } });
    try {
      // Inject a no-tool-call instruction into the system message so Mimo
      // answers directly instead of outputting <tool_call> XML blocks
      const noToolInstruction = 'IMPORTANT: Do NOT use <tool_call> XML or any function-calling syntax. Answer every question directly in plain text using your own knowledge.';
      let msgs = bodyObj.messages || [];
      if (msgs.length && msgs[0].role === 'system') {
        msgs = [{ ...msgs[0], content: noToolInstruction + '\n\n' + msgs[0].content }, ...msgs.slice(1)];
      } else {
        msgs = [{ role: 'system', content: noToolInstruction }, ...msgs];
      }
      const body = { model: bodyObj.model, messages: msgs, max_tokens: bodyObj.max_tokens || 4096 };
      if (bodyObj.temperature != null) body.temperature = bodyObj.temperature;
      const r = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(body),
      });
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(await r.text());
    } catch (e) { return res.status(502).json({ error: { message: 'Mimo error: ' + e.message } }); }
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
        max_tokens: bodyObj.max_tokens || 4096,
        tools:      ALL_TOOLS,
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

      // Tool use agentic loop — up to 5 rounds
      let round = 0;
      while (data.stop_reason === 'tool_use' && round < 5) {
        round++;
        const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
        const toolResults = await Promise.all(
          toolUseBlocks.map(async b => ({
            type: 'tool_result',
            tool_use_id: b.id,
            content: JSON.stringify(await executeTool(b.name, b.input)),
          }))
        );
        body.messages = [
          ...body.messages,
          { role: 'assistant', content: data.content },
          { role: 'user', content: toolResults },
        ];
        r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: anthropicHeaders, body: JSON.stringify(body) });
        text = await r.text();
        if (!r.ok) {
          let msg = text;
          try { msg = JSON.parse(text).error?.message || text; } catch {}
          return res.status(r.status).json({ error: { message: 'Anthropic (tool loop): ' + msg } });
        }
        data = JSON.parse(text);
      }
      return res.status(200).setHeader('Content-Type', 'application/json').send(JSON.stringify(data));
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

  // ── Groq ────────────────────────────────────────────────────────────────────
  if (model.startsWith('groq-')) {
    const key = process.env.GROQ_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'GROQ_API_KEY not set in Vercel Environment Variables.' } });
    try {
      const actualModel = model.replace('groq-', '');
      const body = { model: actualModel, messages: bodyObj.messages || [], max_tokens: bodyObj.max_tokens || 4096 };
      if (bodyObj.temperature != null) body.temperature = bodyObj.temperature;
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(body)
      });
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(await r.text());
    } catch (e) { return res.status(502).json({ error: { message: 'Groq error: ' + e.message } }); }
  }

  // ── DeepSeek ─────────────────────────────────────────────────────────────────
  if (model.startsWith('deepseek-')) {
    const key = process.env.DEEPSEEK_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'DEEPSEEK_API_KEY not set in Vercel Environment Variables.' } });
    try {
      const r = await callCompat('https://api.deepseek.com/v1/chat/completions', key);
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(await r.text());
    } catch (e) { return res.status(502).json({ error: { message: 'DeepSeek error: ' + e.message } }); }
  }

  // ── Google Gemini (OpenAI-compat endpoint) ────────────────────────────────────
  if (model.startsWith('gemini-')) {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    if (!key) return res.status(401).json({ error: { message: 'GEMINI_API_KEY not set in Vercel Environment Variables.' } });
    try {
      const r = await callCompat('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key);
      return res.status(r.status).setHeader('Content-Type', 'application/json').send(await r.text());
    } catch (e) { return res.status(502).json({ error: { message: 'Gemini error: ' + e.message } }); }
  }

  // No provider matched — inform the user
  return res.status(400).json({
    error: {
      message: 'Unsupported model. Select a Mimo (mimo-*), Claude (claude-*), Grok (grok-*), OpenAI (gpt-*/o1/o3/o4), Groq (groq-*), DeepSeek (deepseek-*), or Gemini (gemini-*) model.'
    }
  });
};
