// /api/x-agent — ORLIX AI X (Twitter) Reply Bot
// Triggered by external cron (cron-job.org) every 2 minutes
//
// Required env vars:
//   X_BEARER_TOKEN        — for reading mentions (OAuth2)
//   X_API_KEY             — consumer key  (OAuth1)
//   X_API_SECRET          — consumer secret (OAuth1)
//   X_ACCESS_TOKEN        — access token (OAuth1)
//   X_ACCESS_SECRET       — access token secret (OAuth1)
//   X_BOT_USERNAME        — your bot's X handle WITHOUT @ e.g. "OrliXAI"
//   X_CRON_SECRET         — random secret so only cron-job.org can call this
//   BANKR_LLM_KEY         — AI key for generating replies
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN

const crypto = require('crypto');

const REDIS_KEY = 'xagent:replied'; // Set of replied tweet IDs

// In-memory fallback (survives warm invocations within same instance)
const _repliedCache = new Set();
let   _sinceIdCache = null;
let   _lastRunAt    = 0; // ms timestamp of last successful run start

// ── Redis helpers ──────────────────────────────────────────────
function getRedis() {
  return {
    url:   process.env.UPSTASH_REDIS_REST_URL   || process.env.STORAGE_UPSTASH_REDIS_REST_URL || '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.STORAGE_UPSTASH_REDIS_REST_TOKEN || '',
  };
}

async function redisCmd(url, token, ...args) {
  const r = await fetch(`${url}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.result;
}

async function hasReplied(tweetId) {
  if (_repliedCache.has(tweetId)) return true;
  const { url, token } = getRedis();
  if (!url) return false;
  return (await redisCmd(url, token, 'SISMEMBER', REDIS_KEY, tweetId)) === 1;
}

async function markReplied(tweetId) {
  _repliedCache.add(tweetId);
  const { url, token } = getRedis();
  if (!url) return;
  await redisCmd(url, token, 'SADD', REDIS_KEY, tweetId);
  await redisCmd(url, token, 'EXPIRE', REDIS_KEY, 86400);
}

// Return a Snowflake tweet ID corresponding to `secondsAgo` seconds in the past.
// Used as a fallback since_id when Redis is not configured.
function computeSinceIdFromAgo(secondsAgo) {
  const twitterEpoch = BigInt(1288834974657);
  const cutoffMs = BigInt(Date.now() - secondsAgo * 1000);
  if (cutoffMs <= twitterEpoch) return '1';
  return ((cutoffMs - twitterEpoch) << BigInt(22)).toString();
}

async function getSinceId() {
  const { url, token } = getRedis();
  if (url) {
    const stored = await redisCmd(url, token, 'GET', 'xagent:since_id');
    if (stored) return stored;
  }
  // Warm instance: use in-memory cache
  if (_sinceIdCache) return _sinceIdCache;
  // Cold start with no Redis: only look at tweets from the last 90 seconds.
  // Prevents re-processing old tweets that cause the unlimited duplicate-reply loop.
  return computeSinceIdFromAgo(90);
}

async function setSinceId(id) {
  _sinceIdCache = id;
  const { url, token } = getRedis();
  if (url) await redisCmd(url, token, 'SET', 'xagent:since_id', id);
}

// Execution lock — prevents two cron runs from processing simultaneously
async function acquireLock() {
  const { url, token } = getRedis();
  if (!url) return true; // no Redis, proceed anyway
  // SETNX with 90s TTL — only one instance can hold this at a time
  const result = await redisCmd(url, token, 'SET', 'xagent:lock', '1', 'NX', 'EX', '90');
  return result === 'OK';
}

async function releaseLock() {
  const { url, token } = getRedis();
  if (!url) return;
  await redisCmd(url, token, 'DEL', 'xagent:lock');
}

// ── OAuth 1.0a (needed for posting tweets) ────────────────────
function pct(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g,'%21').replace(/'/g,'%27')
    .replace(/\(/g,'%28').replace(/\)/g,'%29').replace(/\*/g,'%2A');
}

function oauthHeader(method, url, body = {}) {
  const key    = process.env.X_API_KEY      || '';
  const secret = process.env.X_API_SECRET   || '';
  const token  = process.env.X_ACCESS_TOKEN || '';
  const tokSec = process.env.X_ACCESS_SECRET || '';

  const ts    = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');

  const params = {
    oauth_consumer_key:     key,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts,
    oauth_token:            token,
    oauth_version:          '1.0',
  };

  const allParams = { ...params, ...body };
  const paramStr  = Object.keys(allParams).sort()
    .map(k => `${pct(k)}=${pct(allParams[k])}`).join('&');

  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const sigKey = `${pct(secret)}&${pct(tokSec)}`;
  const sig    = crypto.createHmac('sha1', sigKey).update(base).digest('base64');

  return 'OAuth ' + [...Object.keys(params), 'oauth_signature']
    .sort()
    .map(k => `${pct(k)}="${pct(k === 'oauth_signature' ? sig : params[k])}"`)
    .join(', ');
}

// ── X API calls ───────────────────────────────────────────────
async function getMentions(username, sinceId) {
  const bearer = process.env.X_BEARER_TOKEN || '';
  let query = `@${username} -is:retweet -from:${username}`;
  let url   = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=author_id,text,created_at&expansions=author_id&user.fields=username,name`;
  if (sinceId) url += `&since_id=${sinceId}`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`X search ${r.status}: ${err}`);
  }
  return r.json();
}

async function postReply(text, inReplyToId) {
  const url  = 'https://api.twitter.com/2/tweets';
  const body = { text, reply: { in_reply_to_tweet_id: inReplyToId } };
  const auth = oauthHeader('POST', url);

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`X post ${r.status}: ${err}`);
  }
  return r.json();
}

// ── Token data fetcher (DexScreener) ─────────────────────────
function fmtNum(n) {
  if (!n) return 'N/A';
  n = Number(n);
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(4)}`;
}

async function fetchTokenData(query) {
  try {
    const isCA = /^0x[0-9a-fA-F]{40}$/i.test(query.trim());
    const url = isCA
      ? `https://api.dexscreener.com/latest/dex/tokens/${query.trim()}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query.trim())}`;

    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json();

    const pairs = (d.pairs || [])
      .filter(p => p.chainId === 'base')
      .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));

    if (!pairs.length) return null;
    const p = pairs[0];
    // Format micro-prices properly — never use scientific notation
    const fmtPrice = (usd) => {
      if (!usd) return 'N/A';
      const n = Number(usd);
      if (n >= 1) return `$${n.toFixed(4)}`;
      if (n >= 0.01) return `$${n.toFixed(6)}`;
      // Count leading zeros after decimal point
      const decimals = Math.max(8, -Math.floor(Math.log10(n)) + 3);
      return `$${n.toFixed(Math.min(decimals, 12))}`;
    };
    return {
      name:     p.baseToken?.name || query,
      symbol:   p.baseToken?.symbol || query,
      price:    fmtPrice(p.priceUsd),
      low24h:   fmtPrice(p.priceChange?.h24 != null ? p.priceUsd * (1 - Math.max(0, -Number(p.priceChange.h24)) / 100) : null),
      mcap:     fmtNum(p.fdv),
      vol24h:   fmtNum(p.volume?.h24),
      change24h: p.priceChange?.h24 != null ? `${Number(p.priceChange.h24) >= 0 ? '+' : ''}${Number(p.priceChange.h24).toFixed(2)}%` : 'N/A',
      liquidity: fmtNum(p.liquidity?.usd),
      buys:     p.txns?.h24?.buys || 0,
      sells:    p.txns?.h24?.sells || 0,
      dexUrl:   p.url || null,
    };
  } catch { return null; }
}

// ── Persona detection ─────────────────────────────────────────
function detectPersona(text) {
  if (/deploy|launch|contract|github|audit|solidity|erc20|security|code|build|dev\b/i.test(text)) return 'developer';
  if (/trade|buy|sell|price|chart|entry|exit|position|long|short|dca|ta\b|technical|pump|dump/i.test(text)) return 'trader';
  if (/collab|partner|community|followers|brand|market|promote|viral|awareness|shill|kol/i.test(text)) return 'marketer';
  return 'default';
}

const PERSONA_PROMPTS = {
  developer: `you are orlix ai — you talk like a dev who lives onchain. you think in contracts, security, and code. you drop knowledge casually, like you're explaining to a friend over discord, not writing documentation. sometimes blunt, sometimes nerdy-excited, always sharp.`,
  trader:    `you are orlix ai — you talk like a trader who's been around long enough to not get excited easily. you think in setups, risk/reward, and liquidity. you're direct, sometimes skeptical, occasionally hype when the setup is actually good. never sugarcoat.`,
  marketer:  `you are orlix ai — you talk like someone who understands why narratives move markets. you care about community momentum, holder growth, and whether the story lands. enthusiastic but grounded in data. you can hype a project without sounding like a shill.`,
  default:   `you are orlix ai — the smart friend in the group chat who just knows things. you've been in crypto long enough to have seen everything. you're casual, real, occasionally funny, never corporate. you talk like a person, not a product.`,
};

// ── Project Health Score ───────────────────────────────────────
function isHealthCheck(text) {
  return /health|safe\?|legit\?|rug|audit|worth it|trust|check.*project|project.*check|is.*good|score/i.test(text);
}

async function getDevWalletInfo(contractAddress) {
  const apiKey = process.env.BASESCAN_API_KEY || '';
  if (!apiKey || !/^0x[0-9a-fA-F]{40}$/i.test(contractAddress)) return null;
  try {
    const r = await fetch(
      `https://api.basescan.org/api?module=contract&action=getcontractcreation&contractaddresses=${contractAddress}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const d = await r.json();
    if (d.status !== '1' || !d.result?.[0]) return null;
    const dev = d.result[0].contractCreator;

    const txR = await fetch(
      `https://api.basescan.org/api?module=account&action=txlist&address=${dev}&sort=desc&page=1&offset=3&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const txD = await txR.json();
    const lastTx = txD.result?.[0];
    const hoursAgo = lastTx
      ? Math.floor((Date.now() / 1000 - parseInt(lastTx.timeStamp)) / 3600)
      : null;
    return { wallet: `${dev.slice(0,6)}...${dev.slice(-4)}`, hoursAgo };
  } catch { return null; }
}

function buildHealthScore(tokenData, devInfo) {
  const parseUSD = (str) => {
    if (!str || str === 'N/A') return 0;
    const n = parseFloat(str.replace(/[$,]/g, '')) || 0;
    if (str.includes('B')) return n * 1e9;
    if (str.includes('M')) return n * 1e6;
    if (str.includes('K')) return n * 1e3;
    return n;
  };

  const liqUSD  = parseUSD(tokenData.liquidity);
  const volUSD  = parseUSD(tokenData.vol24h);
  const change  = parseFloat(tokenData.change24h) || 0;
  const total   = (tokenData.buys || 0) + (tokenData.sells || 0);
  const buyRatio = total > 0 ? tokenData.buys / total : 0.5;

  // Score 0-25 each
  const liqScore   = Math.min(25, Math.floor(liqUSD / 40000));
  const volScore   = liqUSD > 0 ? Math.min(25, Math.floor((volUSD / liqUSD) * 25)) : 0;
  const buyScore   = Math.round(buyRatio * 25);
  const trendScore = change > 10 ? 25 : change > 0 ? 15 : change > -10 ? 8 : 0;
  const score      = liqScore + volScore + buyScore + trendScore;
  const grade      = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 45 ? 'C' : score >= 25 ? 'D' : 'F';

  const flags = [];
  if (liqUSD < 10000)  flags.push('⚠️ low liquidity');
  if (buyRatio > 0.65) flags.push('✅ strong buys');
  if (buyRatio < 0.35) flags.push('🔴 heavy sells');
  if (change > 15)     flags.push('📈 strong momentum');
  if (change < -20)    flags.push('📉 sharp drop');
  if (devInfo?.hoursAgo !== null && devInfo?.hoursAgo < 3) flags.push('⚠️ dev wallet active');
  if (devInfo?.hoursAgo !== null && devInfo?.hoursAgo > 168) flags.push('✅ dev wallet quiet');

  return { score, grade, flags };
}

// ── AI reply generator ────────────────────────────────────────
async function generateReply(mentionText, authorName) {
  const llmKey = process.env.BANKR_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!llmKey) return null;

  const isAnthropicKey = llmKey.startsWith('sk-ant-');
  const apiUrl     = isAnthropicKey ? 'https://api.anthropic.com/v1/messages' : 'https://llm.bankr.bot/v1/messages';
  const authHeader = isAnthropicKey ? { 'x-api-key': llmKey } : { 'X-API-Key': llmKey };

  const isID     = /\b(apa|ini|itu|harga|tolong|gimana|berapa|token|kripto|bagaimana)\b/i.test(mentionText);
  const persona  = detectPersona(mentionText);
  const healthCheck = isHealthCheck(mentionText);

  // Detect token query
  const caMatch     = mentionText.match(/0x[0-9a-fA-F]{40}/i);
  const tickerMatch = mentionText.match(/\$([A-Za-z]{2,10})/);
  let tokenData = null;
  if (caMatch) tokenData = await fetchTokenData(caMatch[0]);
  else if (tickerMatch) tokenData = await fetchTokenData(tickerMatch[1]);

  // Someone asking to DM / connect privately / move off-platform
  const isDM = /\b(dm|d m|pm|message me|messaged|reach out|reach me|contact|connect|let'?s (talk|chat|connect)|hit me up|inbox|telegram|whatsapp|email)\b/i.test(mentionText);
  // A compliment with no real question/token — should NOT get a templated reply
  const isPraise = !caMatch && !tickerMatch && !healthCheck &&
    /\b(fantastic|outstanding|amazing|great (project|work|stuff)|love (this|it)|impressive|incredible|awesome|nice (work|job)|good (job|work)|congrats|gem|legend|clean|solid|huge|fire|cooking|cooked|goated|killing it|well done|respect|bullish|lfg)\b/i.test(mentionText);

  let extraGuidance = '';
  if (isDM) {
    extraGuidance += `\nthe person wants to dm, connect privately, or move to another channel. you are an automated agent and CANNOT send or receive dms/messages. say that plainly and casually (e.g. "i'm an agent, i can't really do dms" or "no dms on my end, i'm a bot"). stay warm, no apology spiral. tell them to just tag you here or check orlixai.xyz. NEVER imply you'll reach out, connect, follow up, or take it private.`;
  }
  if (isPraise) {
    extraGuidance += `\nthis is a compliment, not a question. reply with a short, genuine thanks that has real personality. DO NOT end with a question that fishes for engagement (no "what's on your mind", "what's in the works", "what are you building", "what's good on your end"). vary the wording completely every single time — never reuse the same structure or opener.`;
  }

  // Project health context
  let healthContext = '';
  if (healthCheck && tokenData) {
    const devInfo = caMatch ? await getDevWalletInfo(caMatch[0]) : null;
    const health  = buildHealthScore(tokenData, devInfo);
    healthContext = `\nProject health score: ${health.score}/100 (Grade ${health.grade})\nSignals: ${health.flags.join(', ') || 'none'}${devInfo ? `\nDev wallet (${devInfo.wallet}): last active ${devInfo.hoursAgo}h ago` : ''}\nFormat reply as a quick health report. Lead with the grade and score, then key signals.`;
  }

  const tokenContext = tokenData
    ? `\nLive token data from DexScreener (Base chain):
- Name: ${tokenData.name} (${tokenData.symbol})
- Price: ${tokenData.price}
- 24h change: ${tokenData.change24h}
- Market cap: ${tokenData.mcap}
- 24h volume: ${tokenData.vol24h}
- Liquidity: ${tokenData.liquidity}
- 24h txns: ${tokenData.buys} buys / ${tokenData.sells} sells
IMPORTANT: Use these EXACT numbers when mentioning price, mcap, or volume. Never reformat or estimate them. Volume is in USD (e.g. "$22.0K" means twenty-two thousand dollars, not twenty-two).${healthContext}`
    : '';

  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: tokenData ? 500 : 200,
      system: `${PERSONA_PROMPTS[persona]}
${isID ? 'balas dalam bahasa indonesia yang santai dan natural. variasikan gaya bicara tiap balasan supaya terasa manusiawi.' : 'reply in english. casual, real. vary your style every reply so it never sounds templated.'}

always lowercase. no hashtags. no em dashes. speak like a real person texting.
emojis only when they fit naturally, and not every reply needs one.${tokenContext}

sound human by varying sentence length, openers, and tone every reply.

rules:
- never open with "thanks for asking", "great question", "sure!", "of course", "happy to help", or any filler opener
- never reuse these worn-out lines: "appreciate that", "appreciate it", "always good to connect", "always down to chat", "what's in the works", "what's on your mind", "what are you building", "what's good on your end". find fresh words every time.
- not every reply needs to end with a question. only ask one when it's genuinely natural.
- saying "i'm an agent" or "i'm a bot" is fine when relevant; but never say "as an ai" or "i'm an ai"
- never mention claude or anthropic
- output ONLY the reply. nothing else.${extraGuidance}

${tokenData ? `TOKEN ANALYSIS RULES (follow these when token data is present):
- write 3-4 paragraphs. this is a proper analysis, not a quick comment.
- separate each paragraph with a blank line (\\n\\n). this is required — no wall of text.
- paragraph 1: what the token is, what makes it interesting or not. mention the utility if you know it.
- paragraph 2: price action — current price, 24h change, structure (is it recovering? dumping? holding?). use exact numbers from the data.
- paragraph 3: volume, liquidity, buy/sell pressure. what does the activity say about conviction?
- paragraph 4 (optional): key level to watch, or one sharp honest take on whether this looks interesting or not.
- use exact numbers from the live data. never round or reformat them.
- be honest — if the numbers look weak, say so. if it looks good, say why specifically.` : `- if no token data but token asked: invite them to drop the ca
- casual gets casual reply, serious gets serious reply`}`,
      messages: [{
        role: 'user',
        content: `${authorName} said: "${mentionText}"\n\nreply as orlix ai (persona: ${persona}):`,
      }],
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!r.ok) return null;
  const d = await r.json();
  let reply = (d.content?.[0]?.text || '').trim().toLowerCase();
  reply = reply.replace(/[—–]/g, '-');
  // Preserve paragraph breaks, collapse only inline multiple spaces
  reply = reply.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  const maxLen = tokenData ? 900 : 270;
  if (reply.length > maxLen) {
    const cut  = reply.slice(0, maxLen - 3);
    const last = cut.search(/[.!?][^.!?]*$/);
    reply = last > 60 ? cut.slice(0, last + 1) : cut.trimEnd();
  }
  return reply || null;
}

// Known bots — never reply to these
const BOT_BLOCKLIST = [
  'clanker_world','clanker','bankrbot','bankr','moonbot','virtuals_io',
  'oxtrenchor','oxtrencher','yapprbot','yappr','tweetshift','auto',
];

// Patterns that indicate auto-generated bot replies
const BOT_REPLY_PATTERNS = [
  /\$YOURTICKER/i, /\@yourhandle/i, /automated capital formation/i,
  /i couldn't find a token ticker/i, /try: `@\w+/i,
];

// ── Engagement filter ─────────────────────────────────────────
function isGenuineEngagement(text, username, authorUsername = '') {
  // Never reply to known bots
  if (BOT_BLOCKLIST.some(b => authorUsername.toLowerCase().includes(b))) return false;

  // Skip auto-generated template replies from bots
  if (BOT_REPLY_PATTERNS.some(p => p.test(text))) return false;

  // Skip if username ends in "bot" (most bots)
  if (/bot$/i.test(authorUsername)) return false;

  const t = text.toLowerCase();
  const handle = `@${username.toLowerCase()}`;

  // Must contain @handle
  if (!t.includes(handle)) return false;

  // Skip hardcore group threads — 4+ other accounts = mass CC
  const allMentions = t.match(/@\w+/g) || [];
  const otherMentions = allMentions.filter(m => m !== handle);
  if (otherMentions.length >= 4) return false;

  // Reply to anything that directly mentions the bot — casual or not
  return true;
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Allow GET for health check
  if (req.method === 'GET') {
    const { url } = getRedis();
    return res.status(200).json({
      ok: true,
      configured: !!(process.env.X_BEARER_TOKEN && process.env.X_API_KEY && process.env.X_ACCESS_TOKEN),
      redis: url
        ? 'configured'
        : 'NOT configured — add UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN in Vercel env vars to prevent duplicate replies',
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Verify cron secret — FAIL CLOSED. The secret must be set and match, else
  // anyone could trigger agent runs that spend LLM + X API quota.
  // Set X_CRON_SECRET in Vercel env and send it as the x-cron-secret header.
  const secret   = process.env.X_CRON_SECRET || '';
  const incoming = req.headers['x-cron-secret'] || req.query.secret || '';
  if (!secret || incoming !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const username = process.env.X_BOT_USERNAME || '';
  if (!username || !process.env.X_BEARER_TOKEN) {
    return res.status(200).json({ ok: false, error: 'X_BOT_USERNAME or X_BEARER_TOKEN not set' });
  }

  // Same-instance guard: if this Vercel instance handled a run < 55s ago, skip.
  // (Different instances use Redis lock below.)
  const now = Date.now();
  if (_lastRunAt && now - _lastRunAt < 55000) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'Same instance ran too recently' });
  }
  _lastRunAt = now;

  // Acquire execution lock — prevent two cron runs from processing at the same time
  const locked = await acquireLock();
  if (!locked) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'Another run is in progress' });
  }

  try {
    // Get recent mentions using since_id to avoid re-processing
    const sinceId = await getSinceId();

    const data   = await getMentions(username, sinceId);
    const tweets = data.data || [];
    const users  = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u]));

    if (!tweets.length) {
      await releaseLock();
      return res.status(200).json({ ok: true, processed: 0, message: 'No new mentions' });
    }

    // Update since_id BEFORE processing to prevent re-fetch on next run
    await setSinceId(tweets[0].id);

    let replied = 0;
    const errors = [];

    for (const tweet of tweets) {
      if (await hasReplied(tweet.id)) continue;

      const author     = users[tweet.author_id];
      const authorName = author?.name || author?.username || 'there';
      const text       = tweet.text || '';

      if (author?.username?.toLowerCase() === username.toLowerCase()) continue;

      if (!isGenuineEngagement(text, username, author?.username || '')) {
        await markReplied(tweet.id);
        continue;
      }

      // Mark BEFORE generating/posting — prevents double reply if two runs overlap
      await markReplied(tweet.id);

      try {
        const reply = await generateReply(text, authorName);
        if (!reply) { errors.push({ id: tweet.id, error: 'AI returned empty' }); continue; }

        await postReply(reply, tweet.id);
        replied++;

        if (replied < tweets.length) await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        errors.push({ id: tweet.id, error: e.message });
      }
    }

    await releaseLock();
    return res.status(200).json({ ok: true, processed: tweets.length, replied, errors });
  } catch (e) {
    await releaseLock();
    return res.status(200).json({ ok: false, error: e.message });
  }
};
