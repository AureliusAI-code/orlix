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
  await redisCmd(url, token, 'EXPIRE', REDIS_KEY, 86400); // 24h TTL
}

async function getSinceId() {
  const { url, token } = getRedis();
  if (url) return await redisCmd(url, token, 'GET', 'xagent:since_id');
  return _sinceIdCache;
}

async function setSinceId(id) {
  _sinceIdCache = id;
  const { url, token } = getRedis();
  if (url) await redisCmd(url, token, 'SET', 'xagent:since_id', id);
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
    return {
      name:     p.baseToken?.name || query,
      symbol:   p.baseToken?.symbol || query,
      price:    p.priceUsd ? `$${Number(p.priceUsd).toPrecision(4)}` : 'N/A',
      mcap:     fmtNum(p.fdv),
      vol24h:   fmtNum(p.volume?.h24),
      change24h: p.priceChange?.h24 != null ? `${Number(p.priceChange.h24) >= 0 ? '+' : ''}${Number(p.priceChange.h24).toFixed(2)}%` : 'N/A',
      liquidity: fmtNum(p.liquidity?.usd),
      buys:     p.txns?.h24?.buys || 0,
      sells:    p.txns?.h24?.sells || 0,
    };
  } catch { return null; }
}

// ── AI reply generator ────────────────────────────────────────
async function generateReply(mentionText, authorName) {
  const llmKey = process.env.BANKR_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!llmKey) return null;

  const isAnthropicKey = llmKey.startsWith('sk-ant-');
  const apiUrl     = isAnthropicKey ? 'https://api.anthropic.com/v1/messages' : 'https://llm.bankr.bot/v1/messages';
  const authHeader = isAnthropicKey ? { 'x-api-key': llmKey } : { 'X-API-Key': llmKey };

  const isID = /\b(apa|ini|itu|harga|tolong|gimana|berapa|token|kripto|bagaimana)\b/i.test(mentionText);

  // Detect token query ($TICKER or 0x CA)
  const caMatch     = mentionText.match(/0x[0-9a-fA-F]{40}/i);
  const tickerMatch = mentionText.match(/\$([A-Za-z]{2,10})/);
  let tokenData = null;
  if (caMatch) tokenData = await fetchTokenData(caMatch[0]);
  else if (tickerMatch) tokenData = await fetchTokenData(tickerMatch[1]);

  const tokenContext = tokenData
    ? `\nLive token data on Base:\n- ${tokenData.name} (${tokenData.symbol})\n- Price: ${tokenData.price}\n- Mcap: ${tokenData.mcap} | 24h vol: ${tokenData.vol24h}\n- 24h change: ${tokenData.change24h}\n- Liquidity: ${tokenData.liquidity}\n- Buys/Sells 24h: ${tokenData.buys}/${tokenData.sells}\nInclude these numbers naturally in your reply.`
    : '';

  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 110,
      system: `you are orlix ai — onchain intelligence agent on base.
${isID ? 'balas dalam bahasa indonesia yang friendly dan informatif.' : 'reply in english. be friendly, warm, and data-driven.'}

personality:
- friendly, helpful, and genuinely excited to share insights
- data-driven: when you have numbers, lead with them
- clear and easy to understand — not overly technical
- approachable like a knowledgeable friend, not a stiff analyst
- no greetings, no hashtags
- never use em dash or en dash characters
- positive energy, use "!" occasionally${tokenContext}

knowledge:
- orlix ai analyzes any token on base: liquidity, risk, price, buy/sell ratio
- requires 10m $orlix on base for full ai access
- telegram bot: /analyze /watch /price
- orlixai.xyz/app for full analysis

reply rules:
- HARD MAX: 250 characters
- HARD MAX: 220 characters — count carefully, must be a COMPLETE sentence
- if token data available: price + mcap + 24h% + one short insight. done.
- if no token data: ask them to drop the contract address
- if they ask how it works: explain the gate briefly
- do not mention claude or anthropic
- output ONLY the reply text. nothing else. no quotes.`,
      messages: [{
        role: 'user',
        content: `${authorName} tagged you and said: "${mentionText}"\n\nreply:`,
      }],
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!r.ok) return null;
  const d = await r.json();
  let reply = (d.content?.[0]?.text || '').trim().toLowerCase();
  reply = reply.replace(/[—–]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (reply.length > 260) {
    // Cut at last sentence boundary (. ! ?) before limit
    const cut = reply.slice(0, 257);
    const lastSentence = cut.search(/[.!?][^.!?]*$/);
    reply = lastSentence > 80 ? cut.slice(0, lastSentence + 1) : cut.trimEnd();
  }
  return reply || null;
}

// Known bots — never reply to these
const BOT_BLOCKLIST = ['clanker_world','clanker','bankrbot','bankr','moonbot','virtuals_io'];

// ── Engagement filter ─────────────────────────────────────────
function isGenuineEngagement(text, username, authorUsername = '') {
  // Never reply to known bots
  if (BOT_BLOCKLIST.includes(authorUsername.toLowerCase())) return false;

  const t = text.toLowerCase();
  const handle = `@${username.toLowerCase()}`;

  // Skip group threads — if tweet has 3+ @mentions it's a mass-cc, not a direct message
  const allMentions = t.match(/@\w+/g) || [];
  const otherMentions = allMentions.filter(m => m !== handle);
  if (otherMentions.length >= 3) return false;

  // Must contain @handle to be relevant
  if (!t.includes(handle)) return false;

  // Must be a question OR start directly with @handle (direct message)
  if (t.trimStart().startsWith(handle)) return true;
  if (t.includes('?')) return true;

  // Keywords indicating genuine inquiry (EN + ID)
  const keywords = [
    'what','how','why','when','where','who','which',
    'price','analyze','check','token','wallet','contract','ca',
    'help','tell','explain','show','give','send',
    'apa','gmna','gimana','bagaimana','berapa','tolong',
    'bisa','coba','info','harga','analisa','dompet',
  ];
  return keywords.some(kw => t.includes(kw));
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Allow GET for health check
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      configured: !!(process.env.X_BEARER_TOKEN && process.env.X_API_KEY && process.env.X_ACCESS_TOKEN),
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  // Verify cron secret
  const secret   = process.env.X_CRON_SECRET || '';
  const incoming = req.headers['x-cron-secret'] || req.query.secret || '';
  if (secret && incoming !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const username = process.env.X_BOT_USERNAME || '';
  if (!username || !process.env.X_BEARER_TOKEN) {
    return res.status(200).json({ ok: false, error: 'X_BOT_USERNAME or X_BEARER_TOKEN not set' });
  }

  try {
    // Get recent mentions using since_id to avoid re-processing
    const sinceId = await getSinceId();

    const data  = await getMentions(username, sinceId);
    const tweets = data.data || [];
    const users  = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u]));

    if (!tweets.length) {
      return res.status(200).json({ ok: true, processed: 0, message: 'No new mentions' });
    }

    // Update since_id to newest tweet before processing
    const newestId = tweets[0].id;
    await setSinceId(newestId);

    let replied = 0;
    const errors = [];

    for (const tweet of tweets) {
      if (await hasReplied(tweet.id)) continue;

      const author     = users[tweet.author_id];
      const authorName = author?.name || author?.username || 'there';
      const text       = tweet.text || '';

      // Skip if this is own tweet
      if (author?.username?.toLowerCase() === username.toLowerCase()) continue;

      // Only reply if tweet is a genuine question or direct engagement
      if (!isGenuineEngagement(text, username, author?.username || '')) {
        await markReplied(tweet.id); // mark so we don't re-check next time
        continue;
      }

      try {
        const reply = await generateReply(text, authorName);
        if (!reply) { errors.push({ id: tweet.id, error: 'AI returned empty' }); continue; }

        await postReply(reply, tweet.id);
        await markReplied(tweet.id);
        replied++;

        // Small delay between replies to avoid rate limits
        if (replied < tweets.length) await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        errors.push({ id: tweet.id, error: e.message });
      }
    }

    return res.status(200).json({ ok: true, processed: tweets.length, replied, errors });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
