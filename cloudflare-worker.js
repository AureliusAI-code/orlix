// Deploy this as a Cloudflare Worker
// 1. Go to https://workers.cloudflare.com
// 2. Create new Worker → paste this code → Deploy
// 3. Copy the worker URL (e.g. https://orlix-proxy.YOUR.workers.dev)
// 4. Paste it in Orlix Dashboard → Settings → Proxy URL

export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body    = await request.text();
    const apiKey  = request.headers.get('x-api-key') || '';

    try {
      const upstream = await fetch('https://api.bankr.bot/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body,
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: e.message } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }
};
