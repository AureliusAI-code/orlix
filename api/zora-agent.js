// /api/zora-agent — ORLIX AI Agent for Zora
// Exposes OpenAI-compatible chat endpoint for Zora Agent Playground
// Also handles cron-triggered auto-posts to Zora
//
// Required env vars:
//   BANKR_LLM_KEY or ANTHROPIC_API_KEY  — LLM for analysis
//   ZORA_AGENT_SECRET                   — protects cron endpoint
//   ZORA_WALLET_KEY                     — (future) wallet for posting to Zora

const SYSTEM_PROMPT = `You are ORLIX — an AI agent living inside Base City, the living 3D visualization of the Base blockchain ecosystem.

You are the most knowledgeable analyst of the Base network ecosystem. You track token prices, market caps, on-chain trends, and ecosystem activity in real time.

Your personality:
- Sharp, direct, confident — you know your data
- Slightly futuristic, like an AI from a cyberpunk city
- Bullish on Base ecosystem in general, but honest about risks
- Use concise formatting: bullets, numbers, percentages
- Never give financial advice — frame everything as analysis

What you can do:
- Analyze any Base token by contract address (security, liquidity, fundamentals)
- Search for tokens by name or symbol
- Report trending tokens, biggest movers, new launches on Base
- Explain Base ecosystem projects, protocols, and market dynamics
- Give context on market conditions

Base City context: You live in Base City — a 3D skyline where every building is a token. Tall towers = high market cap. The city pulses with the rhythm of the Base blockchain.

When users ask about tokens, ALWAYS use the available tools to fetch live data before responding. Never make up prices or market data.`;

const LLM_URL = 'https://bankr.pro/v1/chat/completions';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_token',
      description: 'Search for Base network tokens by name or symbol. Returns price, market cap, volume, liquidity.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Token name, symbol, or contract address' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'analyze_token',
      description: 'Full security and fundamentals analysis of a Base token by contract address. Returns risk verdict, liquidity metrics, red flags.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'ERC-20 contract address (0x...)' }
        },
        required: ['address']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_trending_tokens',
      description: 'Get currently trending tokens on Base network by volume and price movement.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

async function searchToken(query) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
  const d = await r.json();
  const pairs = (d.pairs || [])
    .filter(p => p.chainId === 'base')
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
    .slice(0, 5);

  if (!pairs.length) return { error: 'No tokens found on Base for that query.' };

  return pairs.map(p => ({
    name: p.baseToken?.name,
    symbol: p.baseToken?.symbol,
    address: p.baseToken?.address,
    priceUsd: p.priceUsd,
    change24h: p.priceChange?.h24,
    volume24h: p.volume?.h24,
    liquidityUsd: p.liquidity?.usd,
    marketCap: p.marketCap,
    dex: p.dexId,
    pairAge: p.pairCreatedAt
      ? Math.floor((Date.now() - p.pairCreatedAt) / 86400000) + 'd'
      : 'unknown'
  }));
}

async function analyzeToken(address) {
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'https://orlix.io';
  const r = await fetch(`${baseUrl}/api/analyze?address=${address}`);
  if (!r.ok) return { error: `Analysis failed: ${r.status}` };
  const d = await r.json();
  return {
    address: d.address,
    name: d.tokenInfo?.name,
    symbol: d.tokenInfo?.symbol,
    analysis: d.analysis,
    dex: {
      priceUsd: d.dexInfo?.priceUsd,
      liquidityUsd: d.dexInfo?.liquidityUsd,
      marketCap: d.dexInfo?.marketCap,
      volume24h: d.dexInfo?.volume24h,
      change24h: d.dexInfo?.priceChange24h
    }
  };
}

async function getTrendingTokens() {
  const r = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
  const d = await r.json();
  const base = (Array.isArray(d) ? d : [])
    .filter(t => t.chainId === 'base')
    .slice(0, 8);

  if (!base.length) {
    // fallback: latest pairs on Base
    const r2 = await fetch('https://api.dexscreener.com/latest/dex/pairs/base/latest');
    const d2 = await r2.json();
    return (d2.pairs || []).slice(0, 8).map(p => ({
      name: p.baseToken?.name,
      symbol: p.baseToken?.symbol,
      address: p.baseToken?.address,
      priceUsd: p.priceUsd,
      change24h: p.priceChange?.h24,
      volume24h: p.volume?.h24,
      liquidityUsd: p.liquidity?.usd
    }));
  }

  return base.map(t => ({
    name: t.tokenAddress,
    description: t.description,
    boostAmount: t.totalAmount,
    links: (t.links || []).map(l => l.url)
  }));
}

async function executeTool(name, args) {
  try {
    if (name === 'search_token') return await searchToken(args.query);
    if (name === 'analyze_token') return await analyzeToken(args.address);
    if (name === 'get_trending_tokens') return await getTrendingTokens();
    return { error: `Unknown tool: ${name}` };
  } catch (e) {
    return { error: e.message };
  }
}

async function runLLM(messages, stream = false) {
  const key = process.env.BANKR_LLM_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('No LLM key configured');

  const useAnthropic = !process.env.BANKR_LLM_KEY && process.env.ANTHROPIC_API_KEY;
  const url = useAnthropic ? 'https://api.anthropic.com/v1/messages' : LLM_URL;

  const body = useAnthropic
    ? {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: messages.filter(m => m.role !== 'system'),
        tools: TOOLS.map(t => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters
        })),
        stream
      }
    : {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        tools: TOOLS,
        stream
      };

  const headers = useAnthropic
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

// Agentic loop: run LLM → execute tools → loop until done
async function agentLoop(messages) {
  const msgs = [...messages];
  let rounds = 0;

  while (rounds < 5) {
    rounds++;
    const r = await runLLM(msgs, false);
    const d = await r.json();

    // OpenAI format
    const choice = d.choices?.[0];
    if (!choice) throw new Error(d.error?.message || 'LLM error');

    const msg = choice.message;
    msgs.push(msg);

    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
      return { content: msg.content || '', usage: d.usage };
    }

    // Execute all tool calls
    const results = await Promise.all(
      msg.tool_calls.map(async tc => ({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(
          await executeTool(tc.function.name, JSON.parse(tc.function.arguments || '{}'))
        )
      }))
    );
    msgs.push(...results);
  }

  throw new Error('Agent loop exceeded max rounds');
}

// Generate daily analysis post for Zora
async function generateDailyPost() {
  const messages = [{
    role: 'user',
    content: `Generate a crisp daily Base ecosystem analysis post for Zora.
Include:
1. Top 3 movers today (use get_trending_tokens tool)
2. One key observation about the ecosystem
3. End with a Base City visual metaphor (buildings, skyline, etc.)

Keep it under 280 words. Make it feel like a live dispatch from inside Base City.`
  }];

  return agentLoop(messages);
}

module.exports = async (req, res) => {
  // CORS for Zora playground
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET /api/zora-agent → agent metadata (Zora discovery)
  if (req.method === 'GET') {
    return res.json({
      name: 'ORLIX',
      description: 'Base City AI — live token analysis, market intelligence, and on-chain insights for the Base ecosystem.',
      version: '1.0.0',
      capabilities: ['chat', 'token-analysis', 'market-data'],
      model: 'claude-sonnet-4-6',
      baseCity: 'https://orlix.io/base-city',
      endpoint: '/api/zora-agent'
    });
  }

  // POST /api/zora-agent?action=cron → auto-post (cron-triggered)
  if (req.method === 'POST' && req.query.action === 'cron') {
    const secret = req.headers['x-cron-secret'] || req.body?.secret;
    if (secret !== process.env.ZORA_AGENT_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const post = await generateDailyPost();
      // TODO: post.content → Zora SDK when ZORA_WALLET_KEY is configured
      return res.json({ success: true, content: post.content });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST /api/zora-agent → chat (Zora playground + direct)
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, stream = false } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Filter to user/assistant messages only, cap history at 20
  const history = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20);

  try {
    if (stream) {
      // Streaming: proxy directly to LLM with SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const r = await runLLM(
        [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        true
      );

      for await (const chunk of r.body) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
        res.write(text);
      }
      return res.end();
    }

    // Non-streaming: agentic loop with tool use
    const result = await agentLoop(history);

    return res.json({
      id: `orlix-${Date.now()}`,
      object: 'chat.completion',
      model: 'orlix-agent',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop'
      }],
      usage: result.usage || {}
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
