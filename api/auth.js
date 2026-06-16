// Vercel Serverless Function — /api/auth
// Proxies Privy authentication API — keeps App Secret server-side
// Env vars required: PRIVY_APP_SECRET

const crypto = require('crypto');

const APP_ID     = 'cmqh5fvyg00co0ci68birz0s2';
const CLIENT_ID  = 'client-WY6aRspZ68mzwa8hexMRYu9xiCKWRkscPMKYYu3oayZ99';
const APP_ORIGIN = 'https://orlixai.xyz';
const BASE       = 'https://auth.privy.io/api/v1';

// Server-to-server (admin) headers — uses App Secret
function adminHeaders(secret) {
  const creds = Buffer.from(`${APP_ID}:${secret}`).toString('base64');
  return {
    'Content-Type':    'application/json',
    'Authorization':   `Basic ${creds}`,
    'privy-app-id':    APP_ID,
    'privy-client-id': CLIENT_ID,
  };
}

// Client-facing headers — NO secret, just app-id + client-id
function clientHeaders(extra = {}) {
  return {
    'Content-Type':    'application/json',
    'privy-app-id':    APP_ID,
    'privy-client-id': CLIENT_ID,
    ...extra,
  };
}

// PKCE helpers
function pkceVerifier()   { return crypto.randomBytes(32).toString('base64url'); }
function pkceChallenge(v) { return crypto.createHash('sha256').update(v).digest('base64url'); }

function parseCookies(h) {
  return Object.fromEntries(
    (h || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), decodeURIComponent(v.join('='))];
    }).filter(([k]) => k)
  );
}

module.exports = async function handler(req, res) {
  res.setHeader('x-orlix-proxy', '1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SECRET = process.env.PRIVY_APP_SECRET || '';
  if (!SECRET) {
    return res.status(503).json({
      error: 'PRIVY_APP_SECRET not set.',
      hint:  'Add PRIVY_APP_SECRET to Vercel Environment Variables and redeploy.',
    });
  }

  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  // ── Verify token ──────────────────────────────────────────────────────────────
  if (action === 'verify') {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
      const r    = await fetch(`${BASE}/users/me`, {
        headers: { ...adminHeaders(SECRET), Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── SIWE init ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'siwe-init') {
    const { address } = req.body || {};
    if (!address) return res.status(400).json({ error: 'Missing: address' });
    try {
      const r    = await fetch(`${BASE}/siwe/init`, {
        method:  'POST',
        headers: clientHeaders(),
        body:    JSON.stringify({ address }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || 'siwe-init failed', privy_raw: data });
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── SIWE authenticate ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'siwe-authenticate') {
    const { message, signature, chainId } = req.body || {};
    if (!message || !signature) return res.status(400).json({ error: 'Missing: message, signature' });
    try {
      const r    = await fetch(`${BASE}/siwe/authenticate`, {
        method:  'POST',
        headers: clientHeaders(),
        body:    JSON.stringify({ message, signature, chainId: chainId || 8453 }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data.error || 'siwe-authenticate failed', privy_raw: data });
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── OAuth init ────────────────────────────────────────────────────────────────
  if (req.method === 'POST' && action === 'oauth-init') {
    const { provider } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'Missing: provider' });

    const redirectTo = `${APP_ORIGIN}/api/auth?action=oauth-callback`;
    const state      = crypto.randomBytes(16).toString('hex');
    const verifier   = pkceVerifier();
    const challenge  = pkceChallenge(verifier);

    // Store verifier in cookie so callback can read it
    res.setHeader('Set-Cookie', [
      `orlix_cv=${verifier}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
      `orlix_st=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    ]);

    try {
      const r = await fetch(`${BASE}/oauth/init`, {
        method:  'POST',
        headers: clientHeaders({ 'Origin': APP_ORIGIN }),
        body:    JSON.stringify({
          type:                  'oauth',
          provider,
          redirect_to:           redirectTo,
          state,
          code_challenge:        challenge,
          code_challenge_method: 'S256',
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        return res.status(r.status).json({
          error:      data.error || data.message || data.cause || 'OAuth init failed',
          privy_raw:  data,
        });
      }
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── OAuth callback ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'oauth-callback') {
    const { state, code } = req.query || {};
    if (!state || !code) {
      return res.status(400).send('<p>Missing OAuth params. <a href="/login">Try again.</a></p>');
    }
    const cookies      = parseCookies(req.headers.cookie);
    const codeVerifier = cookies['orlix_cv'] || '';
    if (!codeVerifier) {
      return res.status(400).send('<p>Session expired (cookie missing). <a href="/login">Try again.</a></p>');
    }
    try {
      const r = await fetch(`${BASE}/oauth/authenticate`, {
        method:  'POST',
        headers: clientHeaders(),
        body:    JSON.stringify({ state, code, code_verifier: codeVerifier }),
      });
      const data = await r.json();
      if (data.token) {
        const user  = encodeURIComponent(JSON.stringify(data.user || {}));
        const token = encodeURIComponent(data.token);
        res.writeHead(302, { Location: `/app?privy_token=${token}&privy_user=${user}` });
        return res.end();
      }
      return res.status(400).send(
        `<p>Auth failed: ${data.error || JSON.stringify(data)}. <a href="/login">Try again.</a></p>`
      );
    } catch (e) {
      return res.status(502).send(`<p>Error: ${e.message}. <a href="/login">Try again.</a></p>`);
    }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
