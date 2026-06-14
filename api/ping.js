// Simple health check — GET /api/ping → {"ok":true}
module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ ok: true, ts: Date.now() });
};
