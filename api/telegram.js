// Orlix AI — Telegram Bot Webhook
// Setup: add TELEGRAM_BOT_TOKEN to Vercel env vars, then set webhook:
// https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://orlixai.xyz/api/telegram

const ANTHROPIC_KEY = () => process.env.ANTHROPIC_API_KEY || '';
const TG_TOKEN      = () => process.env.TELEGRAM_BOT_TOKEN || '';

async function tg(method, body) {
  const token = TG_TOKEN();
  if (!token) return;
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function send(chatId, text, extra = {}) {
  // Try with Markdown first, fall back to plain text
  const r = await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
  if (r && !r.ok) {
    // Markdown parse error — retry as plain text
    const j = await r.json().catch(() => ({}));
    if (j.description?.includes('parse')) {
      await tg('sendMessage', { chat_id: chatId, text, ...extra });
    }
  }
}

async function sendLong(chatId, text) {
  const MAX = 3900;
  if (text.length <= MAX) return send(chatId, text);
  // Split on double newline to keep paragraphs intact when possible
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > MAX) { chunks.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);
  for (const chunk of chunks) await send(chatId, chunk);
}

module.exports = async function handler(req, res) {
  // Health check
  if (req.method === 'GET') {
    const token = TG_TOKEN();
    return res.status(200).json({
      ok: true,
      configured: !!token,
      webhook_url: `https://${req.headers.host}/api/telegram`,
      setup: token
        ? `Webhook URL to set: https://api.telegram.org/bot${token}/setWebhook?url=https://${req.headers.host}/api/telegram`
        : 'Add TELEGRAM_BOT_TOKEN to Vercel environment variables first.'
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const token = TG_TOKEN();
  if (!token) return res.status(200).json({ ok: true }); // silently ignore

  const update  = req.body || {};
  const message = update.message || update.edited_message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId    = message.chat?.id;
  const firstName = message.from?.first_name || 'friend';
  const text      = (message.text || '').trim();

  if (!chatId) return res.status(200).json({ ok: true });

  // Typing indicator (fire & forget)
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  // ── Commands ─────────────────────────────────────────────────────────────
  if (text === '/start' || text.startsWith('/start ')) {
    await send(chatId,
      `👋 Hey ${firstName}! Welcome to *Orlix AI*\n\n` +
      `I'm your AI assistant powered by *Claude Sonnet 4.6*.\n` +
      `Ask me anything — code, crypto, research, analysis.\n\n` +
      `*Commands:*\n` +
      `/help — Show this help\n` +
      `/web — Open full dashboard\n` +
      `/clear — Start fresh conversation\n\n` +
      `_Orlix AI — Neural Command Layer_`
    );
    return res.status(200).json({ ok: true });
  }

  if (text === '/help') {
    await send(chatId,
      `*Orlix AI Bot* 🤖\n\n` +
      `*Model:* Claude Sonnet 4.6\n\n` +
      `*Capabilities:*\n` +
      `• Answer any question\n` +
      `• Write & debug code\n` +
      `• Analyze blockchain / crypto\n` +
      `• Research & summarize topics\n` +
      `• Explain complex concepts\n\n` +
      `*Full app:* orlixai.xyz/app\n` +
      `_(Streaming, chat history, web search, image upload, 19 models)_`
    );
    return res.status(200).json({ ok: true });
  }

  if (text === '/web') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '🌐 Open the full Orlix AI dashboard:',
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 Open Orlix AI', url: 'https://orlixai.xyz/app' }]]
      }
    });
    return res.status(200).json({ ok: true });
  }

  if (text === '/clear') {
    await send(chatId, '🗑 Conversation cleared. Starting fresh!');
    return res.status(200).json({ ok: true });
  }

  // Handle photo — basic response for now
  if (message.photo) {
    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const caption = message.caption || 'Describe this image';
    // Get the largest photo file_id
    const photo = message.photo[message.photo.length - 1];
    const fileRes = await tg('getFile', { file_id: photo.file_id }).then(r => r?.json()).catch(() => null);
    if (!fileRes?.result?.file_path) {
      await send(chatId, '📸 Received your image! For full vision analysis, visit orlixai.xyz/app (drag & drop images supported).');
      return res.status(200).json({ ok: true });
    }
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileRes.result.file_path}`;
    const imgBuf  = await fetch(fileUrl).then(r => r.arrayBuffer()).catch(() => null);
    if (!imgBuf) {
      await send(chatId, '📸 Could not download image. Please try again.');
      return res.status(200).json({ ok: true });
    }
    const b64 = Buffer.from(imgBuf).toString('base64');
    const ext = fileRes.result.file_path.split('.').pop() || 'jpeg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: 'You are Orlix AI running in a Telegram bot. Be helpful and concise. Use Telegram markdown (*bold*, _italic_, `code`).',
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
              { type: 'text', text: caption }
            ]
          }]
        })
      });
      const data = await r.json();
      const reply = data.content?.[0]?.text || 'Could not analyze image.';
      await sendLong(chatId, reply);
    } catch (e) {
      await send(chatId, `⚠️ Vision error: ${e.message}`);
    }
    return res.status(200).json({ ok: true });
  }

  if (!text) return res.status(200).json({ ok: true });

  // ── Regular message → Claude ──────────────────────────────────────────────
  const anthropicKey = ANTHROPIC_KEY();
  if (!anthropicKey) {
    await send(chatId, '⚠️ Bot not fully configured. ANTHROPIC_API_KEY missing.');
    return res.status(200).json({ ok: true });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system:
          'You are Orlix AI, an intelligent assistant running in a Telegram bot. ' +
          'Be helpful, accurate, and concise. Keep responses under 3000 characters when possible. ' +
          'You can use Telegram markdown: *bold*, _italic_, `inline code`, ```code blocks```. ' +
          'For crypto/blockchain questions you have expertise. ' +
          'If users want more features (streaming, image upload, web search, 19 AI models), ' +
          'invite them to visit orlixai.xyz/app',
        messages: [{ role: 'user', content: text }],
      }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${r.status}`);
    }

    const data  = await r.json();
    const reply = data.content?.[0]?.text || 'I could not generate a response.';
    await sendLong(chatId, reply);

  } catch (e) {
    await send(chatId, `⚠️ Error: ${e.message}`);
  }

  return res.status(200).json({ ok: true });
};
