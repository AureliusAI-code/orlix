// /api/b20-ai — Parse natural language token description → B20 form fields (Claude Haiku)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SYSTEM = `You are a B20 token parameter extractor for the Base blockchain.
Given a natural language description, extract token parameters and return ONLY valid JSON.
No markdown, no code fences, no explanation — pure JSON only.

Return exactly this JSON structure:
{
  "name": string,
  "symbol": string,
  "variant": "asset" | "stablecoin",
  "decimals": 18 | 6,
  "uncapped": boolean,
  "supply": string | null,
  "allowlist": boolean,
  "blocklist": boolean,
  "freeze": boolean
}

Rules:
- name: Title Case, clean (e.g. "GameFi Token", "Bankr Protocol")
- symbol: UPPERCASE, no spaces, max 11 chars (e.g. "GAMEFI", "BNKR")
- variant: "stablecoin" ONLY if explicitly described as stable/pegged/USD-backed; otherwise "asset"
- decimals: 18 for asset tokens; 6 for stablecoins
- uncapped: true if no supply mentioned, or "unlimited", "no cap", "infinite"
- supply: total supply as digits string if mentioned (500M → "500000000", 1B → "1000000000", 100k → "100000"), null if uncapped
- allowlist: true if "whitelist", "allowlist", "KYC", "approved-only" mentioned
- blocklist: true if "blacklist", "blocklist", "ban" mentioned
- freeze: true if "freeze", "seize", "compliance", "regulatory" mentioned
- When in doubt about policies: false`;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== 'POST') {
    res.writeHead(405, CORS);
    return res.end(JSON.stringify({ error: 'POST only' }));
  }

  let body = '';
  req.on('data', c => body += c);
  await new Promise(r => req.on('end', r));

  let description;
  try { description = JSON.parse(body).description; } catch {
    res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
  if (!description?.trim()) {
    res.writeHead(400, CORS); return res.end(JSON.stringify({ error: 'description required' }));
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.writeHead(500, CORS); return res.end(JSON.stringify({ error: 'API key not configured' }));
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: 'user', content: String(description).slice(0, 500) }],
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const data = await r.json();
    const text = (data.content?.[0]?.text || '').trim();
    const params = JSON.parse(text);

    // Sanitize output
    params.symbol = (params.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0, 11);
    params.decimals = params.variant === 'stablecoin' ? 6 : (Number(params.decimals) || 18);
    if (params.uncapped) params.supply = null;

    res.writeHead(200, CORS);
    res.end(JSON.stringify(params));
  } catch (e) {
    res.writeHead(502, CORS);
    res.end(JSON.stringify({ error: e.message || 'AI generation failed' }));
  }
};
