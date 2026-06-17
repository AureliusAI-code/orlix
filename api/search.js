// /api/search — proxies Brave Search API
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const key = process.env.BRAVE_SEARCH_API_KEY || '';
  if (!key) return res.status(401).json({ error: 'BRAVE_SEARCH_API_KEY not configured' });

  try {
    const r = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5&search_lang=en`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': key } }
    );
    if (!r.ok) return res.status(r.status).json({ error: 'Brave Search error' });
    const data = await r.json();
    const results = (data.web?.results || []).slice(0, 5).map(item => ({
      title: item.title,
      url: item.url,
      description: item.description || ''
    }));
    return res.json({ results });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
