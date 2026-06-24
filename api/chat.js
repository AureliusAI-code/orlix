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
  },
  {
    name: 'dexscreener_search',
    description: 'Search for tokens on DexScreener by name or symbol. Returns price, liquidity, volume, and market data for Base tokens.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Token name, symbol, or contract address to search for (e.g. "ORLIX", "pepe", "0x...")' }
      },
      required: ['query']
    }
  },
  {
    name: 'dexscreener_token',
    description: 'Get full market data for a specific token on Base: price, liquidity, volume, price changes 1h/6h/24h, buy/sell txns, market cap, FDV',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Token contract address on Base (0x...)' }
      },
      required: ['address']
    }
  },
  {
    name: 'flaunch_new_tokens',
    description: 'Get the newest token launches on Flaunch on Base mainnet. Returns recently launched meme tokens with price and market cap.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of tokens to return, default 10, max 20' }
      }
    }
  },
  {
    name: 'flaunch_top_tokens',
    description: 'Get top tokens by market cap on Flaunch (Base). Returns ranked tokens with price, volume, and market data.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of tokens to return, default 10, max 20' }
      }
    }
  },
  {
    name: 'uniswap_quote',
    description: 'Get a real swap quote from Uniswap on Base. Returns best price, estimated output amount, gas fee, and price impact for any token pair.',
    input_schema: {
      type: 'object',
      properties: {
        token_in:          { type: 'string', description: 'Input token address. Use 0x0000000000000000000000000000000000000000 for native ETH' },
        token_out:         { type: 'string', description: 'Output token address (e.g. 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 for USDC)' },
        amount_in:         { type: 'string', description: 'Input amount in human-readable units, e.g. "0.1" for 0.1 ETH or "100" for 100 USDC' },
        token_in_decimals: { type: 'number', description: 'Decimals of input token: 18 for ETH/WETH, 6 for USDC. Default 18.' }
      },
      required: ['token_in', 'token_out', 'amount_in']
    }
  },
  {
    name: 'moonwell_markets',
    description: 'Get lending and borrowing markets on Moonwell (Base). Returns supply APY, borrow APY, total supply, total borrows, and liquidity for each asset.',
    input_schema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: 'Optional: specific asset to query, e.g. "USDC", "WETH", "ETH". Omit to get all markets.' }
      }
    }
  },
  {
    name: 'moonwell_user_position',
    description: 'Get a user\'s lending/borrowing position on Moonwell Base. Returns what they have supplied, borrowed, and their account health factor.',
    input_schema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string', description: 'User wallet address (0x...)' }
      },
      required: ['wallet_address']
    }
  },
  {
    name: 'base_erc20_info',
    description: 'Get ERC20 token details on Base: name, symbol, decimals, total supply. Optionally check a wallet\'s balance of that token.',
    input_schema: {
      type: 'object',
      properties: {
        token_address:  { type: 'string', description: 'ERC20 token contract address on Base (0x...)' },
        wallet_address: { type: 'string', description: 'Optional: wallet address to check token balance for' }
      },
      required: ['token_address']
    }
  },
  {
    name: 'uniswap_prepare_swap',
    description: 'Prepare an unsigned swap transaction on Uniswap Base. Returns the exact calldata the user must sign with their wallet to execute the swap. Always call uniswap_quote first to confirm the price.',
    input_schema: {
      type: 'object',
      properties: {
        token_in:          { type: 'string', description: 'Input token address. Use 0x0000000000000000000000000000000000000000 for native ETH' },
        token_out:         { type: 'string', description: 'Output token address' },
        amount_in:         { type: 'string', description: 'Input amount in human-readable units, e.g. "0.1" for 0.1 ETH' },
        token_in_decimals: { type: 'number', description: 'Decimals of input token: 18 for ETH/WETH, 6 for USDC. Default 18.' },
        wallet_address:    { type: 'string', description: 'User wallet address that will sign and execute the swap (0x...)' }
      },
      required: ['token_in', 'token_out', 'amount_in', 'wallet_address']
    }
  },
  {
    name: 'flaunch_prepare_launch',
    description: 'Prepare an unsigned transaction to launch a new meme token on Flaunch (Base). Returns calldata the user signs to deploy and launch the token. Image must be a valid URL or base64.',
    input_schema: {
      type: 'object',
      properties: {
        name:           { type: 'string', description: 'Token full name, e.g. "Doge on Base"' },
        symbol:         { type: 'string', description: 'Token symbol, max 8 chars alphanumeric, e.g. "DOGEB"' },
        description:    { type: 'string', description: 'Short description of the token' },
        image_url:      { type: 'string', description: 'Image URL for the token logo' },
        wallet_address: { type: 'string', description: 'Creator wallet address (0x...)' },
        twitter_url:    { type: 'string', description: 'Optional: Twitter/X URL' },
        telegram_url:   { type: 'string', description: 'Optional: Telegram URL' },
        website_url:    { type: 'string', description: 'Optional: Website URL' }
      },
      required: ['name', 'symbol', 'description', 'image_url', 'wallet_address']
    }
  },
  {
    name: 'moonwell_prepare_supply',
    description: 'Prepare unsigned transactions to supply (deposit) an asset into Moonwell lending on Base. Returns calldata the user signs to earn lending yield.',
    input_schema: {
      type: 'object',
      properties: {
        asset:          { type: 'string', description: 'Asset symbol to supply, e.g. "USDC", "WETH", "ETH"' },
        amount:         { type: 'string', description: 'Amount to supply in human-readable units, e.g. "100" for 100 USDC' },
        wallet_address: { type: 'string', description: 'User wallet address (0x...)' }
      },
      required: ['asset', 'amount', 'wallet_address']
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
      case 'dexscreener_search': {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(input.query)}`, {
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return { error: `DexScreener error: ${r.status}` };
        const data = await r.json();
        const pairs = (data.pairs || [])
          .filter(p => p.chainId === 'base')
          .slice(0, 8)
          .map(p => ({
            name:             p.baseToken?.name,
            symbol:           p.baseToken?.symbol,
            address:          p.baseToken?.address,
            price_usd:        p.priceUsd,
            liquidity_usd:    p.liquidity?.usd,
            volume_24h:       p.volume?.h24,
            price_change_24h: p.priceChange?.h24,
            market_cap:       p.marketCap,
            pair_url:         p.url
          }));
        return { query: input.query, results: pairs, chain: 'Base', source: 'DexScreener' };
      }
      case 'dexscreener_token': {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${input.address}`, {
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return { error: `DexScreener error: ${r.status}` };
        const data = await r.json();
        const basePairs = (data.pairs || []).filter(p => p.chainId === 'base');
        if (!basePairs.length) return { error: 'Token not found on Base', address: input.address };
        const best = basePairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        const age  = best.pairCreatedAt ? Math.floor((Date.now() - best.pairCreatedAt) / 86400000) + ' days' : null;
        const buys = best.txns?.h24?.buys || 0;
        const sells = best.txns?.h24?.sells || 0;
        return {
          name:             best.baseToken?.name,
          symbol:           best.baseToken?.symbol,
          address:          input.address,
          price_usd:        best.priceUsd,
          price_change_1h:  best.priceChange?.h1,
          price_change_6h:  best.priceChange?.h6,
          price_change_24h: best.priceChange?.h24,
          liquidity_usd:    best.liquidity?.usd,
          volume_1h:        best.volume?.h1,
          volume_6h:        best.volume?.h6,
          volume_24h:       best.volume?.h24,
          buys_24h:         buys,
          sells_24h:        sells,
          buy_sell_ratio:   sells > 0 ? (buys / sells).toFixed(2) : buys > 0 ? 'inf' : '0',
          market_cap:       best.marketCap,
          fdv:              best.fdv,
          dex:              best.dexId,
          pair_age:         age,
          pair_url:         best.url,
          chain:            'Base'
        };
      }
      case 'flaunch_new_tokens': {
        const limit = Math.min(input.limit || 10, 20);
        const r = await fetch('https://mcp.flaunch.gg/v1/base/coins/new', {
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return { error: `Flaunch error: ${r.status}` };
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.tokens || data.coins || []);
        const tokens = list.slice(0, limit).map(t => ({
          name:           t.name,
          symbol:         t.symbol,
          address:        t.tokenAddress || t.address,
          price_usd:      t.priceUSD,
          market_cap_usd: t.marketCapUSD,
          volume_24h:     t.volume24h,
          change_24h:     t.twentyFourHourChangePercentage
        }));
        return { tokens, count: tokens.length, source: 'Flaunch', chain: 'Base' };
      }
      case 'flaunch_top_tokens': {
        const limit = Math.min(input.limit || 10, 20);
        const r = await fetch('https://mcp.flaunch.gg/v1/base/coins/market-cap', {
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return { error: `Flaunch error: ${r.status}` };
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.tokens || data.coins || []);
        const tokens = list.slice(0, limit).map(t => ({
          name:           t.name,
          symbol:         t.symbol,
          address:        t.tokenAddress || t.address,
          price_usd:      t.priceUSD,
          market_cap_usd: t.marketCapUSD,
          volume_24h:     t.volume24h,
          change_24h:     t.twentyFourHourChangePercentage
        }));
        return { tokens, count: tokens.length, source: 'Flaunch', chain: 'Base' };
      }
      case 'uniswap_quote': {
        const decimalsIn = input.token_in_decimals ?? 18;
        const amtFloat   = parseFloat(input.amount_in);
        if (isNaN(amtFloat) || amtFloat <= 0) return { error: 'Invalid amount_in' };
        const amountIn   = BigInt(Math.round(amtFloat * Math.pow(10, decimalsIn))).toString();
        const body = {
          type: 'EXACT_INPUT',
          amount: amountIn,
          tokenIn: input.token_in,
          tokenOut: input.token_out,
          tokenInChainId: 8453,
          tokenOutChainId: 8453,
          swapper: '0x0000000000000000000000000000000000000000',
          autoSlippage: 'DEFAULT',
          protocols: ['V4', 'V3', 'V2'],
          routingPreference: 'BEST_PRICE'
        };
        const r = await fetch('https://trade-api.gateway.uniswap.org/v1/quote', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'NeoYO3V50_koJAipDEalYWbMO1XMaFPAQmpOm6_Npo0',
            'x-permit2-disabled': 'true'
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(12000)
        });
        if (!r.ok) {
          const err = await r.text().catch(() => '');
          return { error: `Uniswap API ${r.status}`, detail: err.slice(0, 300) };
        }
        const d = await r.json();
        // Handle multiple possible response shapes from Uniswap API
        const outAmt = d.output?.amount ?? d.outputAmount ?? d.quote?.outputAmount ?? d.quote?.output?.amount ?? null;
        const gasFee = d.gasFeeUSD ?? d.gasFee?.usd ?? d.gasUseEstimateUSD ?? null;
        const impact = d.priceImpact ?? d.quote?.priceImpact ?? null;
        return {
          token_in:       input.token_in,
          token_out:      input.token_out,
          amount_in:      input.amount_in,
          amount_out_raw: outAmt,
          route_type:     d.routeType ?? d.routing ?? null,
          price_impact:   impact,
          gas_fee_usd:    gasFee,
          note:           'amount_out_raw is in the token\'s smallest unit. Divide by 10^decimals for human-readable. USDC has 6 decimals, ETH/WETH has 18.',
          _raw_keys:      Object.keys(d).join(','),
          chain:          'Base'
        };
      }
      case 'moonwell_markets': {
        const url = input.asset
          ? `https://api.moonwell.fi/v1/markets/${input.asset.toUpperCase()}?chain=base`
          : 'https://api.moonwell.fi/v1/markets?chain=base';
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return { error: `Moonwell API error: ${r.status}` };
        const data = await r.json();
        const markets = Array.isArray(data) ? data : (data.markets || [data]);
        return {
          markets: markets.slice(0, 15).map(m => ({
            asset:          m.symbol || m.asset,
            supply_apy:     m.supplyApy || m.supplyAPY,
            borrow_apy:     m.borrowApy || m.borrowAPY,
            total_supply:   m.totalSupply,
            total_borrows:  m.totalBorrows,
            liquidity:      m.liquidity,
            price_usd:      m.underlyingPrice || m.price
          })),
          source: 'Moonwell',
          chain: 'Base'
        };
      }
      case 'moonwell_user_position': {
        const r = await fetch(`https://api.moonwell.fi/v1/positions/${input.wallet_address}?chain=base`, {
          signal: AbortSignal.timeout(8000)
        });
        if (!r.ok) return { error: `Moonwell API error: ${r.status}` };
        const data = await r.json();
        return { wallet: input.wallet_address, position: data, source: 'Moonwell', chain: 'Base' };
      }
      case 'base_erc20_info': {
        function decodeStrLocal(hex) {
          try {
            if (!hex || hex === '0x') return '';
            const raw = hex.slice(2);
            if (raw.length < 128) return '';
            const len = parseInt(raw.slice(64, 128), 16);
            return Buffer.from(raw.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
          } catch { return ''; }
        }
        const [nameHex, symHex, decHex, supHex] = await Promise.allSettled([
          rpc('eth_call', [{ to: input.token_address, data: '0x06fdde03' }, 'latest']),
          rpc('eth_call', [{ to: input.token_address, data: '0x95d89b41' }, 'latest']),
          rpc('eth_call', [{ to: input.token_address, data: '0x313ce567' }, 'latest']),
          rpc('eth_call', [{ to: input.token_address, data: '0x18160ddd' }, 'latest']),
        ]);
        const decimals  = decHex.status === 'fulfilled' ? (parseInt(decHex.value, 16) || 18) : 18;
        const supplyRaw = supHex.status === 'fulfilled' && supHex.value && supHex.value !== '0x' ? BigInt(supHex.value) : 0n;
        const result = {
          address:      input.token_address,
          name:         nameHex.status === 'fulfilled' ? decodeStrLocal(nameHex.value) : 'Unknown',
          symbol:       symHex.status  === 'fulfilled' ? decodeStrLocal(symHex.value)  : '?',
          decimals,
          total_supply: supplyRaw > 0n ? (Number(supplyRaw) / Math.pow(10, decimals)).toLocaleString() : 'Unknown',
          chain:        'Base',
          chain_id:     8453
        };
        if (input.wallet_address) {
          const balData = '0x70a08231' + input.wallet_address.replace('0x', '').padStart(64, '0');
          const balHex  = await rpc('eth_call', [{ to: input.token_address, data: balData }, 'latest']).catch(() => null);
          if (balHex) {
            const raw = parseInt(balHex, 16);
            result.wallet_balance     = (raw / Math.pow(10, decimals)).toLocaleString();
            result.wallet_balance_raw = raw.toString();
          }
        }
        return result;
      }
      case 'uniswap_prepare_swap': {
        const decimalsIn = input.token_in_decimals ?? 18;
        const amtFloat   = parseFloat(input.amount_in);
        if (isNaN(amtFloat) || amtFloat <= 0) return { error: 'Invalid amount_in' };
        const amountIn   = BigInt(Math.round(amtFloat * Math.pow(10, decimalsIn))).toString();
        const uniHeaders = {
          'Content-Type': 'application/json',
          'x-api-key': 'NeoYO3V50_koJAipDEalYWbMO1XMaFPAQmpOm6_Npo0',
          'x-permit2-disabled': 'true'
        };
        // Use real wallet as swapper so the quote is valid for this wallet
        const quoteBody = {
          type: 'EXACT_INPUT',
          amount: amountIn,
          tokenIn: input.token_in,
          tokenOut: input.token_out,
          tokenInChainId: 8453,
          tokenOutChainId: 8453,
          swapper: input.wallet_address,
          autoSlippage: 'DEFAULT',
          protocols: ['V4', 'V3', 'V2'],
          routingPreference: 'BEST_PRICE'
        };
        const qr = await fetch('https://trade-api.gateway.uniswap.org/v1/quote', {
          method: 'POST', headers: uniHeaders,
          body: JSON.stringify(quoteBody), signal: AbortSignal.timeout(12000)
        });
        if (!qr.ok) { const t = await qr.text(); return { error: `Uniswap quote failed: ${qr.status}`, detail: t.slice(0, 400) }; }
        const quote = await qr.json();
        // /swap: send the full quote response as-is, only strip fields that are null/undefined
        const swapPayload = { ...quote };
        if (!swapPayload.permitData)        delete swapPayload.permitData;
        if (!swapPayload.permitTransaction) delete swapPayload.permitTransaction;
        if (!swapPayload.signature)         delete swapPayload.signature;
        const sr = await fetch('https://trade-api.gateway.uniswap.org/v1/swap', {
          method: 'POST', headers: uniHeaders,
          body: JSON.stringify(swapPayload), signal: AbortSignal.timeout(12000)
        });
        if (!sr.ok) { const t = await sr.text(); return { error: `Uniswap swap prepare failed: ${sr.status}`, detail: t.slice(0, 500) }; }
        const swapData = await sr.json();
        return {
          __action:      'sign_transaction',
          protocol:      'Uniswap',
          description:   `Swap ${input.amount_in} ${input.token_in === '0x0000000000000000000000000000000000000000' ? 'ETH' : input.token_in} on Uniswap (Base)`,
          transactions:  [swapData.swap ?? swapData.transaction ?? swapData].filter(Boolean),
          amount_out_raw: quote.output?.amount ?? quote.outputAmount ?? quote.quote?.outputAmount ?? null,
          gas_fee_usd:   swapData.gasFee ?? swapData.gasFeeUSD ?? null,
          chain_id:      8453,
          wallet:        input.wallet_address
        };
      }
      case 'flaunch_prepare_launch': {
        // Upload image to Flaunch IPFS first if it's a URL
        let imageIpfs = input.image_url;
        if (!imageIpfs.startsWith('Qm') && !imageIpfs.startsWith('baf')) {
          // It's a URL, not an IPFS hash — Flaunch needs us to fetch & upload
          const imgFetch = await fetch(input.image_url, { signal: AbortSignal.timeout(8000) });
          if (!imgFetch.ok) return { error: 'Could not fetch image URL' };
          const imgBuf    = await imgFetch.arrayBuffer();
          const b64       = Buffer.from(imgBuf).toString('base64');
          const mimeMatch = (await imgFetch.headers.get('content-type') || 'image/png');
          const uploadR   = await fetch('https://mcp.flaunch.gg/v1/upload-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base64Image: `data:${mimeMatch};base64,${b64}` }),
            signal: AbortSignal.timeout(15000)
          });
          if (!uploadR.ok) return { error: `Flaunch image upload failed: ${uploadR.status}` };
          const uploadData = await uploadR.json();
          imageIpfs = uploadData.ipfsHash || uploadData.tokenUri || imageIpfs;
        }
        const launchPayload = {
          name:           input.name,
          symbol:         input.symbol.slice(0, 8).toUpperCase(),
          description:    input.description,
          imageIpfs,
          creatorAddress: input.wallet_address,
          ...(input.website_url  ? { websiteUrl:  input.website_url  } : {}),
          ...(input.twitter_url  ? { twitterUrl:  input.twitter_url  } : {}),
          ...(input.telegram_url ? { telegramUrl: input.telegram_url } : {})
        };
        const lr = await fetch('https://mcp.flaunch.gg/v1/base/launch/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(launchPayload),
          signal: AbortSignal.timeout(15000)
        });
        if (!lr.ok) { const t = await lr.text(); return { error: `Flaunch prepare failed: ${lr.status}`, detail: t.slice(0, 200) }; }
        const launchData = await lr.json();
        return {
          __action:     'sign_transaction',
          protocol:     'Flaunch',
          description:  `Launch token ${input.name} (${input.symbol}) on Flaunch (Base)`,
          transactions: Array.isArray(launchData) ? launchData : [launchData],
          token_name:   input.name,
          token_symbol: input.symbol,
          chain_id:     8453,
          wallet:       input.wallet_address
        };
      }
      case 'moonwell_prepare_supply': {
        const url = `https://api.moonwell.fi/v1/prepare/supply?chain=base&asset=${encodeURIComponent(input.asset.toUpperCase())}&amountDecimal=${input.amount}&from=${input.wallet_address}`;
        const r   = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) { const t = await r.text(); return { error: `Moonwell prepare failed: ${r.status}`, detail: t.slice(0, 200) }; }
        const data = await r.json();
        const txs  = data.data?.transactions || data.transactions || [];
        return {
          __action:     'sign_transaction',
          protocol:     'Moonwell',
          description:  `Supply ${input.amount} ${input.asset} to Moonwell on Base`,
          transactions: txs,
          asset:        input.asset,
          amount:       input.amount,
          chain_id:     8453,
          wallet:       input.wallet_address
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
        // Base MCP remote server — gives Claude a Base Account wallet with
        // send_calls, swap, get_wallets, and 20+ DeFi plugin tools.
        // User approves via Base Account approval link (no MetaMask needed).
        mcp_servers: [
          { type: 'url', url: 'https://mcp.base.org/sse', name: 'base' }
        ],
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
