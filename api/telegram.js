// Orlix AI — Telegram Bot Webhook
// Setup: set TELEGRAM_BOT_TOKEN env var, then:
// GET https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://orlixai.xyz/api/telegram

const ANTHROPIC_KEY = () => process.env.ANTHROPIC_API_KEY || '';
const TG_TOKEN      = () => process.env.TELEGRAM_BOT_TOKEN || '';
const BASE_RPC      = 'https://mainnet.base.org';

// ── Telegram helpers ──────────────────────────────────────────────────────────

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
  const r = await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
  if (r && !r.ok) {
    const j = await r.json().catch(() => ({}));
    if (j.description?.includes('parse')) {
      await tg('sendMessage', { chat_id: chatId, text, ...extra });
    }
  }
}

async function sendLong(chatId, text) {
  const MAX = 3900;
  if (text.length <= MAX) return send(chatId, text);
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > MAX) { chunks.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) chunks.push(buf);
  for (const chunk of chunks) await send(chatId, chunk);
}

// ── On-chain / DexScreener helpers ───────────────────────────────────────────

async function baseRpc(method, params = []) {
  const r = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

function decodeStr(hex) {
  try {
    if (!hex || hex === '0x') return '';
    const raw = hex.slice(2);
    if (raw.length < 128) return '';
    const len = parseInt(raw.slice(64, 128), 16);
    return Buffer.from(raw.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return ''; }
}

async function getTokenInfo(address) {
  const [name, symbol, supply, dec] = await Promise.allSettled([
    baseRpc('eth_call', [{ to: address, data: '0x06fdde03' }, 'latest']),
    baseRpc('eth_call', [{ to: address, data: '0x95d89b41' }, 'latest']),
    baseRpc('eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']),
    baseRpc('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
  ]);
  const decimals = dec.status === 'fulfilled' && dec.value !== '0x'
    ? parseInt(dec.value, 16) : 18;
  const rawSupply = supply.status === 'fulfilled' && supply.value !== '0x'
    ? BigInt(supply.value).toString() : '0';
  const totalSupply = rawSupply !== '0'
    ? (Number(BigInt(rawSupply)) / Math.pow(10, decimals)).toLocaleString()
    : 'Unknown';
  return {
    name:        name.status   === 'fulfilled' ? decodeStr(name.value)   : 'Unknown',
    symbol:      symbol.status === 'fulfilled' ? decodeStr(symbol.value) : '?',
    decimals,
    totalSupply,
  };
}

async function getDex(address) {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) return null;
  const data = await r.json();
  const basePairs = (data.pairs || []).filter(p => p.chainId === 'base');
  const pool = basePairs.length ? basePairs : (data.pairs || []);
  if (!pool.length) return null;
  const best = pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const priceRaw = best.priceUsd ? Number(best.priceUsd) : 0;
  return {
    priceUsd:       priceRaw > 0 ? best.priceUsd : null,
    priceChange24h: best.priceChange?.h24 ?? 0,
    liquidityUsd:   best.liquidity?.usd   || 0,
    volume24h:      best.volume?.h24      || 0,
    buys24h:        best.txns?.h24?.buys  || 0,
    sells24h:       best.txns?.h24?.sells || 0,
    dexId:          best.dexId            || 'unknown',
    pairName:       (best.baseToken?.symbol || '?') + '/' + (best.quoteToken?.symbol || '?'),
    fdv:            best.fdv              || 0,
    pairsCount:     pool.length,
    url:            best.url              || '',
  };
}

// ── Token Analyzer command ────────────────────────────────────────────────────

async function cmdAnalyze(chatId, address) {
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  const [tokR, dexR] = await Promise.allSettled([getTokenInfo(address), getDex(address)]);
  const token = tokR.status === 'fulfilled' ? tokR.value : null;
  const dex   = dexR.status === 'fulfilled' ? dexR.value : null;

  // ── Build data card ──
  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const priceStr  = dex?.priceUsd
    ? `$${Number(dex.priceUsd).toFixed(dex.priceUsd < 0.001 ? 8 : 6)}`
    : '—';
  const changeStr = dex
    ? (dex.priceChange24h >= 0 ? `+${dex.priceChange24h}` : `${dex.priceChange24h}`) + '%'
    : '—';
  const liqStr    = dex ? `$${Number(dex.liquidityUsd).toLocaleString()}` : '—';
  const volStr    = dex ? `$${Number(dex.volume24h).toLocaleString()}`    : '—';
  const fdvStr    = dex ? `$${Number(dex.fdv).toLocaleString()}`          : '—';

  let card = `🔍 *TOKEN ANALYSIS*\n`;
  card    += `\`${shortAddr}\` · Base Mainnet\n`;
  card    += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (token?.name && token.name !== 'Unknown') {
    card += `*${token.name}* (${token.symbol})\n`;
    card += `Supply: ${token.totalSupply} · Decimals: ${token.decimals}\n\n`;
  }

  if (dex) {
    card += `*Price:* ${priceStr}  ${changeStr} 24h\n`;
    card += `*Liquidity:* ${liqStr}\n`;
    card += `*Volume 24h:* ${volStr}\n`;
    card += `*Buys / Sells:* ${dex.buys24h} / ${dex.sells24h}\n`;
    card += `*FDV:* ${fdvStr}\n`;
    card += `*DEX:* ${dex.dexId} — ${dex.pairName}\n`;
    if (dex.url) card += `[View Chart](${dex.url})\n`;
    card += `\n`;
  } else {
    card += `_⚠️ Not listed on any DEX_\n\n`;
  }

  // ── AI analysis ──
  const key = ANTHROPIC_KEY();
  if (key) {
    tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const ctx = [
      token ? `Token: ${token.name} (${token.symbol}), Supply: ${token.totalSupply}` : '',
      dex
        ? `Price: ${priceStr}, Liq: ${liqStr}, Vol: ${volStr}, Buys/Sells: ${dex.buys24h}/${dex.sells24h}, FDV: ${fdvStr}`
        : 'No DEX listing.',
    ].filter(Boolean).join('\n');

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          system: 'You are a crypto security analyst. Use Telegram markdown: *bold* for headers, bullet points for lists. No ## headers. Be direct, 3–4 lines max per section.',
          messages: [{
            role: 'user',
            content: `Analyze this Base token. Reply in this exact format:\n\n*📊 Overview*\n[1 sentence]\n\n*🚩 Red Flags*\n• [each flag, or: None detected]\n\n*⚖️ Verdict: SAFE / CAUTION / HIGH RISK / SCAM LIKELY*\n[1 sentence reason]\n\nData:\n${ctx}`,
          }],
        }),
      });
      const d = await r.json();
      const verdict = d.content?.[0]?.text;
      if (verdict) card += verdict;
    } catch { card += `_AI analysis unavailable_`; }
  }

  await sendLong(chatId, card);
}

// ── Wallet Watcher command ────────────────────────────────────────────────────

async function cmdWatch(chatId, address) {
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  // ETH balance via RPC + recent txns via Blockscout (no API key needed)
  const [balR, txR] = await Promise.allSettled([
    baseRpc('eth_getBalance', [address, 'latest']),
    fetch(`https://base.blockscout.com/api/v2/addresses/${address}/transactions?limit=5`, {
      headers: { Accept: 'application/json' },
    }).then(r => r.json()),
  ]);

  const ethBal = balR.status === 'fulfilled'
    ? (Number(BigInt(balR.value)) / 1e18).toFixed(4)
    : '?';

  const txns = txR.status === 'fulfilled' ? (txR.value?.items || []) : [];

  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;

  let msg = `👁 *WALLET WATCHER*\n`;
  msg    += `\`${shortAddr}\` · Base Mainnet\n`;
  msg    += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg    += `*ETH Balance:* ${ethBal} ETH\n`;

  if (!txns.length) {
    msg += `\n_No recent transactions found._`;
  } else {
    msg += `\n*Last ${txns.length} Transactions:*\n`;
    for (const tx of txns) {
      const isIn   = tx.to?.hash?.toLowerCase() === address.toLowerCase();
      const dir    = isIn ? '📥' : '📤';
      const status = tx.status === 'ok' ? '✅' : '❌';
      const val    = tx.value ? (Number(BigInt(tx.value)) / 1e18).toFixed(4) : '0.0000';
      const peer   = isIn ? tx.from?.hash : tx.to?.hash;
      const peerS  = peer ? `${peer.slice(0, 6)}...${peer.slice(-4)}` : '?';
      msg += `${dir} ${status} *${val} ETH* ${isIn ? 'from' : 'to'} \`${peerS}\`\n`;
    }
  }

  msg += `\n[View on Basescan](https://basescan.org/address/${address})`;
  msg += `\n\n_💡 For real-time wallet alerts, visit_ [orlixai.xyz/app](https://orlixai.xyz/app)`;

  await sendLong(chatId, msg);
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const token = TG_TOKEN();
    return res.status(200).json({
      ok: true,
      configured: !!token,
      setup: token
        ? `Set webhook: https://api.telegram.org/bot${token}/setWebhook?url=https://${req.headers.host}/api/telegram`
        : 'Add TELEGRAM_BOT_TOKEN to Vercel environment variables first.',
    });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const token = TG_TOKEN();
  if (!token) return res.status(200).json({ ok: true });

  const update  = req.body || {};
  const message = update.message || update.edited_message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId    = message.chat?.id;
  const firstName = message.from?.first_name || 'friend';
  const text      = (message.text || '').trim();

  if (!chatId) return res.status(200).json({ ok: true });

  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  // ── /start ────────────────────────────────────────────────────────────────
  if (text === '/start' || text.startsWith('/start ')) {
    await send(chatId,
      `👋 Welcome to *Orlix AI*, ${firstName}.\n\n` +
      `Your AI-powered command layer — ask anything, analyze any token, or track any wallet on Base.\n\n` +
      `*Commands*\n` +
      `/analyze \`0x...\` — Token security analysis\n` +
      `/watch \`0x...\` — Wallet activity on Base\n` +
      `/help — Full command list\n` +
      `/web — Open Orlix dashboard\n\n` +
      `_Powered by Claude · orlixai.xyz_`
    );
    return res.status(200).json({ ok: true });
  }

  // ── /help ─────────────────────────────────────────────────────────────────
  if (text === '/help') {
    await send(chatId,
      `*Orlix AI — Command Reference*\n\n` +
      `*🤖 AI Assistant*\n` +
      `Just type any message — I'll answer using Claude.\n\n` +
      `*🪙 Token Analyzer*\n` +
      `/analyze \`0x...\`\n` +
      `Price, liquidity, volume, buy/sell pressure & AI security verdict.\n\n` +
      `*👁 Wallet Watcher*\n` +
      `/watch \`0x...\`\n` +
      `ETH balance + last 5 transactions on Base.\n\n` +
      `*Other*\n` +
      `/web — Open full dashboard _(streaming, 19 models, web search)_\n` +
      `/clear — Reset conversation\n\n` +
      `[orlixai.xyz](https://orlixai.xyz)`
    );
    return res.status(200).json({ ok: true });
  }

  // ── /web ──────────────────────────────────────────────────────────────────
  if (text === '/web') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '🌐 Open the Orlix AI dashboard for streaming, image upload, web search, and 19 AI models:',
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 Launch Orlix AI', url: 'https://orlixai.xyz/app' }]],
      },
    });
    return res.status(200).json({ ok: true });
  }

  // ── /clear ────────────────────────────────────────────────────────────────
  if (text === '/clear') {
    await send(chatId, '🗑 Conversation cleared. Ready for a fresh start.');
    return res.status(200).json({ ok: true });
  }

  // ── /analyze 0x... ────────────────────────────────────────────────────────
  if (text.startsWith('/analyze')) {
    const parts = text.split(/\s+/);
    const addr  = (parts[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId,
        `⚠️ *Invalid address*\n\nUsage: /analyze \`0x...\`\n\nPaste the contract address (42 characters starting with 0x).`
      );
      return res.status(200).json({ ok: true });
    }
    await send(chatId, `🔍 Fetching on-chain data for \`${addr.slice(0, 6)}...${addr.slice(-4)}\`…`);
    try { await cmdAnalyze(chatId, addr); }
    catch (e) { await send(chatId, `⚠️ Analysis failed: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /watch 0x... ─────────────────────────────────────────────────────────
  if (text.startsWith('/watch')) {
    const parts = text.split(/\s+/);
    const addr  = (parts[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId,
        `⚠️ *Invalid address*\n\nUsage: /watch \`0x...\`\n\nPaste the wallet address (42 characters starting with 0x).`
      );
      return res.status(200).json({ ok: true });
    }
    await send(chatId, `👁 Looking up wallet \`${addr.slice(0, 6)}...${addr.slice(-4)}\`…`);
    try { await cmdWatch(chatId, addr); }
    catch (e) { await send(chatId, `⚠️ Wallet lookup failed: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── Photo (vision) ────────────────────────────────────────────────────────
  if (message.photo) {
    const caption = message.caption || 'Describe this image';
    const photo   = message.photo[message.photo.length - 1];
    const fileRes = await tg('getFile', { file_id: photo.file_id }).then(r => r?.json()).catch(() => null);
    if (!fileRes?.result?.file_path) {
      await send(chatId, '📸 For full image analysis with drag-and-drop, visit [orlixai.xyz/app](https://orlixai.xyz/app).');
      return res.status(200).json({ ok: true });
    }
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileRes.result.file_path}`;
    const imgBuf  = await fetch(fileUrl).then(r => r.arrayBuffer()).catch(() => null);
    if (!imgBuf) {
      await send(chatId, '⚠️ Could not download image. Please try again.');
      return res.status(200).json({ ok: true });
    }
    const b64  = Buffer.from(imgBuf).toString('base64');
    const ext  = fileRes.result.file_path.split('.').pop() || 'jpeg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY(), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: 'You are Orlix AI in a Telegram bot. Use Telegram markdown (*bold*, _italic_, `code`). Be concise and professional.',
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
              { type: 'text', text: caption },
            ],
          }],
        }),
      });
      const data = await r.json();
      await sendLong(chatId, data.content?.[0]?.text || 'Could not analyze image.');
    } catch (e) {
      await send(chatId, `⚠️ Vision error: ${e.message}`);
    }
    return res.status(200).json({ ok: true });
  }

  if (!text) return res.status(200).json({ ok: true });

  // ── Regular message → Claude ──────────────────────────────────────────────
  const key = ANTHROPIC_KEY();
  if (!key) {
    await send(chatId, '⚠️ Bot not fully configured. ANTHROPIC_API_KEY is missing.');
    return res.status(200).json({ ok: true });
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system:
          'You are Orlix AI — an intelligent assistant inside Telegram. ' +
          'Be accurate, concise, and professional. Use Telegram markdown (*bold*, _italic_, `code`). ' +
          'Keep replies under 3000 characters when possible. ' +
          'You have deep expertise in crypto, DeFi, and blockchain. ' +
          'For token analysis use /analyze, for wallet tracking use /watch. ' +
          'For more features (streaming, web search, image upload, 19 AI models) recommend orlixai.xyz/app.',
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${r.status}`);
    }
    const data = await r.json();
    await sendLong(chatId, data.content?.[0]?.text || 'I could not generate a response.');
  } catch (e) {
    await send(chatId, `⚠️ Error: ${e.message}`);
  }

  return res.status(200).json({ ok: true });
};
