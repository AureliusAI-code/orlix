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

function getAuthWallet(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer wallet:0x')) return auth.slice(7); // 'wallet:0x...'
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('x-orlix-proxy', '1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Debug endpoint — GET ?debug=1 (internal only) ───────────────────────────
  if (req.method === 'GET' && req.query && req.query.debug === '1') {
    const creds = getCredentials();
    return res.status(200).json({ configured: !!creds });
  }

  const creds = getCredentials();
  if (!creds) {
    return res.status(503).json({ error: 'Service temporarily unavailable.' });
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

  // ── POST — save a new build (requires auth) ──────────────────────────────────
  if (req.method === 'POST') {
    const callerWallet = getAuthWallet(req);
    if (!callerWallet) return res.status(401).json({ error: 'Authentication required' });

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
        id:     String(id).slice(0, 64),
        title:  String(title).slice(0, 120),
        code:   String(code).slice(0, 300000),
        owner:  callerWallet,
        ts:     Date.now(),
      };
      const updated = [newBuild, ...filtered].slice(0, MAX);
      await redisCmd(url, token, 'SET', KEY, JSON.stringify(updated));
      return res.status(200).json({ ok: true, total: updated.length });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to save' });
    }
  }

  // ── DELETE — remove build by id (requires auth + ownership) ──────────────────
  if (req.method === 'DELETE') {
    const callerWallet = getAuthWallet(req);
    if (!callerWallet) return res.status(401).json({ error: 'Authentication required' });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
      const raw = await redisCmd(url, token, 'GET', KEY);
      const builds = JSON.parse(raw || '[]');
      const target = builds.find(b => b.id === id);
      // Allow delete if: caller owns it, or entry has no owner (legacy)
      if (target && target.owner && target.owner !== callerWallet) {
        return res.status(403).json({ error: 'Not authorized to delete this entry' });
      }
      const updated = builds.filter(b => b.id !== id);
      await redisCmd(url, token, 'SET', KEY, JSON.stringify(updated));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: 'Failed to delete' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
