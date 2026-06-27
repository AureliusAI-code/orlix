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
  const { url, token } = getRedis();
  if (!url) return false;
  return (await redisCmd(url, token, 'SISMEMBER', REDIS_KEY, tweetId)) === 1;
}

async function markReplied(tweetId) {
  const { url, token } = getRedis();
  if (!url) return;
  await redisCmd(url, token, 'SADD', REDIS_KEY, tweetId);
  await redisCmd(url, token, 'EXPIRE', REDIS_KEY, 86400); // 24h TTL
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

// ── AI reply generator ────────────────────────────────────────
async function generateReply(mentionText, authorName, lang = 'en') {
  const llmKey = process.env.BANKR_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';
  if (!llmKey) return null;

  const isAnthropicKey = llmKey.startsWith('sk-ant-');
  const apiUrl     = isAnthropicKey ? 'https://api.anthropic.com/v1/messages' : 'https://llm.bankr.bot/v1/messages';
  const authHeader = isAnthropicKey ? { 'x-api-key': llmKey } : { 'X-API-Key': llmKey };

  const isID = /\b(apa|ini|itu|harga|tolong|gimana|berapa|token|kripto|bagaimana)\b/i.test(mentionText);
  const langNote = isID
    ? 'Balas dalam Bahasa Indonesia yang singkat dan natural.'
    : 'Reply in English. Be concise.';

  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: `you are orlix ai — the most advanced onchain intelligence on base.
${isID ? 'balas dalam bahasa indonesia yang profesional, percaya diri, dan berkesan.' : 'reply in english. be sharp, confident, and impressive.'}

personality:
- professional, authoritative, and polished — like a top-tier analyst
- confident without being arrogant — you know your stuff and it shows
- every reply sounds like it came from someone who sees the market differently
- clear and precise — no fluff, every word earns its place
- occasionally drop a sharp insight that makes them think twice
- cool and composed — never flustered, always in control
- no greetings, no hashtags, no exclamation marks
- speak like the smartest person in the room who doesn't need to prove it

knowledge:
- orlix ai analyzes any token on base — liquidity, risk, price, buy/sell ratio
- wallets can be tracked with on-chain activity
- requires 5m $orlix on base to unlock full ai access (gate is the product)
- telegram bot: /analyze /watch /price
- built on base network. powered by advanced ai
- orlixai.xyz — app at orlixai.xyz/app

reply rules:
- HARD MAX: 220 characters
- if they ask about price → "check orlixai.xyz/token for live data"
- if they ask to analyze a token → "send the contract address"
- if they ask how it works → explain the gate confidently, make it sound elite
- if they're rude → respond with pure class and professionalism
- do not mention claude or anthropic
- output ONLY the reply text. nothing else. no quotes around it.`,
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
  if (reply.length > 270) reply = reply.slice(0, 267) + '...';
  return reply || null;
}

// ── Engagement filter ─────────────────────────────────────────
function isGenuineEngagement(text, username) {
  const t = text.toLowerCase();
  const handle = `@${username.toLowerCase()}`;

  // Direct reply to the bot (starts with @handle)
  if (t.startsWith(handle)) return true;

  // Contains a question mark
  if (t.includes('?')) return true;

  // Contains keywords indicating genuine inquiry (EN + ID)
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
    // Get recent mentions (last ~2 minutes via since_id or last 10 tweets)
    const { url, token } = getRedis();
    let sinceId = url ? await redisCmd(url, token, 'GET', 'xagent:since_id') : null;

    const data  = await getMentions(username, sinceId);
    const tweets = data.data || [];
    const users  = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u]));

    if (!tweets.length) {
      return res.status(200).json({ ok: true, processed: 0, message: 'No new mentions' });
    }

    // Update since_id to newest tweet
    const newestId = tweets[0].id;
    if (url) await redisCmd(url, token, 'SET', 'xagent:since_id', newestId);

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
      if (!isGenuineEngagement(text, username)) {
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
