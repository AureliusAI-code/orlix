// Cloudflare Pages Function — auto-deployed at /api/chat
// Proxies requests to bankr.bot server-side (no CORS issues)
export async function onRequestPost(context) {
  try {
    const body   = await context.request.text();
    const apiKey = context.request.headers.get('x-api-key') || '';

    const upstream = await fetch('https://api.bankr.bot/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body,
    });

    const text = await upstream.text();

    return new Response(text, {
      status:  upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message } }), {
      status:  502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    },
  });
}
