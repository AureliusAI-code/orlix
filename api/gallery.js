// Vercel Serverless Function — /api/gallery
// Backed by Upstash Redis (connect via Vercel Dashboard → Storage → Upstash)

const KEY = 'orlix_gallery';
const MAX = 100;

// Find whichever env var set is present
function getCredentials() {
  const candidates = [
    { url: process.env.UPSTASH_REDIS_REST_URL,   token: process.env.UPSTASH_REDIS_REST_TOKEN },
    { url: process.env.KV_REST_API_URL,            token: process.env.KV_REST_API_TOKEN },
    { url: process.env.STORAGE_UPSTASH_REDIS_REST_URL,   token: process.env.STORAGE_UPSTASH_REDIS_REST_TOKEN },
    { url: process.env.STORAGE_URL,               token: process.env.STORAGE_TOKEN },
  ];
  return candidates.find(c => c.url && c.token) || null;
}

async function redisCmd(url, token, ...args) {
  // Use POST pipeline for all commands — most reliable with Upstash
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([args]),
  });
  const json = await r.json();
  // Pipeline returns array of results
  if (Array.isArray(json) && json[0]) return json[0].result;
  if (json.error) throw new Error('Redis: ' + json.error);
  return json.result ?? null;
}

module.exports = async function handler(req, res) {
  res.setHeader('x-orlix-proxy', '1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Debug endpoint — GET ?debug=1 ───────────────────────────────────────────
  if (req.method === 'GET' && req.query && req.query.debug === '1') {
    const creds = getCredentials();
    return res.status(200).json({
      configured: !!creds,
      url_found: creds ? creds.url.slice(0, 40) + '…' : null,
      env_keys: Object.keys(process.env).filter(k =>
        k.includes('UPSTASH') || k.includes('KV_REST') || k.includes('STORAGE')
      ),
    });
  }

  const creds = getCredentials();
  if (!creds) {
    return res.status(503).json({
      error: 'Upstash Redis not configured.',
      hint: 'Vercel Dashboard → Storage → Upstash → connect to orlix → Redeploy',
      env_keys_found: Object.keys(process.env).filter(k =>
        k.includes('UPSTASH') || k.includes('REDIS') || k.includes('KV')
      ),
    });
  }

  const { url, token } = creds;

  // ── GET — return all builds ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const raw = await redisCmd(url, token, 'GET', KEY);
      const builds = raw ? JSON.parse(raw) : [];
      return res.status(200).json({ builds: Array.isArray(builds) ? builds : [] });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── POST — save a new build ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { id, code, title } = req.body || {};
    if (!id || !code || !title) {
      return res.status(400).json({ error: 'Missing id, code, or title' });
    }
    try {
      // Read current list
      const raw = await redisCmd(url, token, 'GET', KEY);
      const builds = Array.isArray(raw ? JSON.parse(raw) : []) ? JSON.parse(raw || '[]') : [];
      // Dedupe by id
      const filtered = builds.filter(b => b.id !== id);
      const newBuild = {
        id:    String(id).slice(0, 64),
        title: String(title).slice(0, 120),
        code:  String(code).slice(0, 300000),
        ts:    Date.now(),
      };
      const updated = [newBuild, ...filtered].slice(0, MAX);
      await redisCmd(url, token, 'SET', KEY, JSON.stringify(updated));
      return res.status(200).json({ ok: true, total: updated.length });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── DELETE — remove build by id ──────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
      const raw = await redisCmd(url, token, 'GET', KEY);
      const builds = JSON.parse(raw || '[]');
      const updated = builds.filter(b => b.id !== id);
      await redisCmd(url, token, 'SET', KEY, JSON.stringify(updated));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
