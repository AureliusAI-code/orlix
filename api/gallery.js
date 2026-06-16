// Vercel Serverless Function — /api/gallery
// Requires Vercel KV (Redis) — add via Vercel Dashboard → Storage → Create KV
// Env vars set automatically: KV_REST_API_URL, KV_REST_API_TOKEN

const KEY = 'orlix:gallery';
const MAX = 100;

async function kvPipeline(url, token, cmds) {
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('KV error: ' + r.status);
  return r.json();
}

async function kvGet(url, token, cmd) {
  const path = cmd.map(c => encodeURIComponent(c)).join('/');
  const r = await fetch(`${url}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error('KV error: ' + r.status);
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('x-orlix-proxy', '1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Support both Upstash direct env vars and Vercel KV (which uses Upstash under the hood)
  const KV_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL   || '';
  const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN  || process.env.KV_REST_API_TOKEN  || '';

  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({
      error: 'Redis not configured. Go to Vercel Dashboard → Storage → Upstash → Create Redis, then redeploy.',
    });
  }

  // ── GET — fetch latest builds ────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { result } = await kvGet(KV_URL, KV_TOKEN, ['lrange', KEY, '0', '99']);
      const builds = (result || [])
        .map(s => { try { return JSON.parse(s); } catch { return null; } })
        .filter(Boolean);
      return res.status(200).json({ builds });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── POST — publish a new build ───────────────────────────────────────────────
  if (req.method === 'POST') {
    const { id, code, title } = req.body || {};
    if (!id || !code || !title) {
      return res.status(400).json({ error: 'Missing required fields: id, code, title' });
    }
    const build = {
      id:    String(id).slice(0, 64),
      title: String(title).slice(0, 120),
      code:  String(code).slice(0, 300000), // 300KB max per build
      ts:    Date.now(),
    };
    try {
      await kvPipeline(KV_URL, KV_TOKEN, [
        ['LPUSH', KEY, JSON.stringify(build)],
        ['LTRIM', KEY, 0, MAX - 1],
      ]);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // ── DELETE — remove a build by id ───────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
      const { result } = await kvGet(KV_URL, KV_TOKEN, ['lrange', KEY, '0', '99']);
      const items = (result || []).filter(s => {
        try { return JSON.parse(s).id !== id; } catch { return true; }
      });
      // Rebuild list: clear then push all in reverse order
      if (items.length === 0) {
        await kvPipeline(KV_URL, KV_TOKEN, [['DEL', KEY]]);
      } else {
        // RPUSH preserves order, then trim
        const cmds = [['DEL', KEY], ...items.reverse().map(v => ['RPUSH', KEY, v])];
        await kvPipeline(KV_URL, KV_TOKEN, cmds);
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
