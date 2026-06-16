// Vercel Serverless Function — /api/auth
// Proxies Privy authentication API — keeps App Secret server-side
// Env vars required: PRIVY_APP_SECRET
// App ID is public and hardcoded below

const APP_ID  = 'cmqh5fvyg00co0ci68birz0s2';
const BASE    = 'https://auth.privy.io/api/v1';

function privyHeaders(secret) {
  const creds = Buffer.from(`${APP_ID}:${secret}`).toString('base64');
  return {
    'Content-Type':  'application/json',
    'Authorization': `Basic ${creds}`,
    'privy-app-id':  APP_ID,
  };
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
      hint: 'Add PRIVY_APP_SECRET to Vercel Environment Variables and redeploy.',
    });
  }

  const action = (req.query && req.query.action) || (req.body && req.body.action) || '';

  // ── Verify token ─────────────────────────────────────────────────────────────
  if (action === 'verify') {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
      const r = await fetch(`${BASE}/users/me`, {
        headers: { ...privyHeaders(SECRET), Authorization: `Bearer ${token}` },
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── SIWE init — get nonce for wallet login ────────────────────────────────────
  if (req.method === 'POST' && action === 'siwe-init') {
    const { address } = req.body || {};
    if (!address) return res.status(400).json({ error: 'Missing: address' });
    try {
      const r = await fetch(`${BASE}/siwe/init`, {
        method: 'POST',
        headers: privyHeaders(SECRET),
        body: JSON.stringify({ address }),
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── SIWE authenticate — verify wallet signature ───────────────────────────────
  if (req.method === 'POST' && action === 'siwe-authenticate') {
    const { message, signature, chainId } = req.body || {};
    if (!message || !signature) return res.status(400).json({ error: 'Missing: message, signature' });
    try {
      const r = await fetch(`${BASE}/siwe/authenticate`, {
        method: 'POST',
        headers: privyHeaders(SECRET),
        body: JSON.stringify({ message, signature, chainId: chainId || 8453, walletClientType: 'metamask' }),
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── OAuth init — get Twitter redirect URL ─────────────────────────────────────
  if (req.method === 'POST' && action === 'oauth-init') {
    const { provider, redirectUri } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'Missing: provider' });
    const origin = `https://${req.headers.host || 'orlixai.xyz'}`;
    try {
      const r = await fetch(`${BASE}/oauth/init`, {
        method: 'POST',
        headers: privyHeaders(SECRET),
        body: JSON.stringify({
          provider,
          redirect_uri: redirectUri || `${origin}/api/auth?action=oauth-callback`,
          origin,
        }),
      });
      const data = await r.json();
      // Surface Privy errors clearly
      if (!r.ok) {
        return res.status(r.status).json({
          error: data.error || data.message || data.cause || 'Privy OAuth init failed',
          privy_response: data,
        });
      }
      return res.status(200).json(data);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── OAuth callback — exchange code for token ──────────────────────────────────
  if (req.method === 'GET' && action === 'oauth-callback') {
    const { state, code } = req.query || {};
    if (!state || !code) {
      return res.status(400).send('<p>Missing OAuth params. <a href="/login">Try again.</a></p>');
    }
    try {
      const r = await fetch(`${BASE}/oauth/authenticate`, {
        method: 'POST',
        headers: privyHeaders(SECRET),
        body: JSON.stringify({ state, code }),
      });
      const data = await r.json();
      if (data.token) {
        const user = encodeURIComponent(JSON.stringify(data.user || {}));
        const token = encodeURIComponent(data.token);
        res.writeHead(302, { Location: `/app?privy_token=${token}&privy_user=${user}` });
        return res.end();
      }
      return res.status(400).send(`<p>Auth failed: ${data.error || 'Unknown error'}. <a href="/login">Try again.</a></p>`);
    } catch (e) {
      return res.status(502).send(`<p>Error: ${e.message}. <a href="/login">Try again.</a></p>`);
    }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
};
