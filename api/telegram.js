// Orlix AI — Telegram Bot Webhook (upgraded: smarter AI, deeper onchain analysis)
// Setup: set TELEGRAM_BOT_TOKEN env var, then:
// GET https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://orlixai.xyz/api/telegram

const ANTHROPIC_KEY = () => process.env.BANKR_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';
const TG_TOKEN      = () => process.env.TELEGRAM_BOT_TOKEN || '';

function aiEndpoint(key) {
  const isAnthropicKey = key.startsWith('sk-ant-');
  return {
    url:     isAnthropicKey ? 'https://api.anthropic.com/v1/messages' : 'https://llm.bankr.bot/v1/messages',
    headers: { 'Content-Type': 'application/json', ...(isAnthropicKey ? { 'x-api-key': key } : { 'X-API-Key': key }), 'anthropic-version': '2023-06-01' },
  };
}
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
      await tg('sendMessage', { chat_id: chatId, text: text.replace(/[*_`\[\]]/g, ''), ...extra });
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

function typing(chatId) {
  return tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

// ── Detect language from text ────────────────────────────────────────────────
function detectLang(text) {
  const idWords = /\b(apa|ini|itu|dan|yang|di|ke|dari|untuk|dengan|tidak|bisa|mau|tolong|gimana|kenapa|berapa|siapa|kapan|dimana|bagaimana|adalah|saya|aku|kamu|kita|mereka|harga|token|analisa|dompet|kripto)\b/i;
  return idWords.test(text) ? 'id' : 'en';
}

// ── On-chain helpers ─────────────────────────────────────────────────────────

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
  const liq  = best.liquidity?.usd || 0;
  const mcap = best.marketCap || best.fdv || 0;
  const liqMcapRatio = mcap > 0 ? ((liq / mcap) * 100).toFixed(1) : null;
  const buys  = best.txns?.h24?.buys  || 0;
  const sells = best.txns?.h24?.sells || 0;
  return {
    priceUsd:       best.priceUsd ? Number(best.priceUsd) : null,
    priceChange1h:  best.priceChange?.h1  ?? null,
    priceChange6h:  best.priceChange?.h6  ?? null,
    priceChange24h: best.priceChange?.h24 ?? 0,
    liquidityUsd:   liq,
    volume1h:       best.volume?.h1  || 0,
    volume6h:       best.volume?.h6  || 0,
    volume24h:      best.volume?.h24 || 0,
    buys24h:        buys,
    sells24h:       sells,
    buySellRatio:   sells > 0 ? (buys / sells).toFixed(2) : buys > 0 ? '∞' : '0',
    dexId:          best.dexId            || 'unknown',
    pairName:       (best.baseToken?.symbol || '?') + '/' + (best.quoteToken?.symbol || '?'),
    fdv:            best.fdv              || 0,
    marketCap:      best.marketCap        || 0,
    liqMcapRatio,
    pairsCount:     pool.length,
    url:            best.url              || '',
    pairCreatedAt:  best.pairCreatedAt    || null,
  };
}

// ── Token Analyzer ────────────────────────────────────────────────────────────

async function cmdAnalyze(chatId, address, lang = 'en') {
  typing(chatId);

  const [tokR, dexR] = await Promise.allSettled([getTokenInfo(address), getDex(address)]);
  const token = tokR.status === 'fulfilled' ? tokR.value : null;
  const dex   = dexR.status === 'fulfilled' ? dexR.value : null;

  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const fmt = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtUsd = (n) => `$${fmt(n, 0)}`;
  const priceStr = dex?.priceUsd
    ? `$${dex.priceUsd < 0.0001 ? dex.priceUsd.toFixed(10) : dex.priceUsd < 0.01 ? dex.priceUsd.toFixed(8) : dex.priceUsd.toFixed(6)}`
    : '—';
  const fmtChange = (v) => v == null ? '—' : (v >= 0 ? `+${v}%` : `${v}%`);
  const ageStr = dex?.pairCreatedAt
    ? `${Math.floor((Date.now() - dex.pairCreatedAt) / 86400000)}d`
    : '?';

  // Build card
  let card = `🔍 *TOKEN ANALYSIS*\n`;
  card    += `\`${shortAddr}\` · Base Network\n`;
  card    += `━━━━━━━━━━━━━━━━━━━━\n`;

  if (token?.name && token.name !== 'Unknown') {
    card += `*${token.name}* (${token.symbol})\n`;
    card += `Supply: ${token.totalSupply} · Decimals: ${token.decimals}\n`;
  }

  if (dex) {
    card += `\n*💵 Price:* ${priceStr}\n`;
    card += `*📊 Change:* 1h ${fmtChange(dex.priceChange1h)} | 6h ${fmtChange(dex.priceChange6h)} | 24h ${fmtChange(dex.priceChange24h)}\n`;
    card += `*💧 Liquidity:* ${fmtUsd(dex.liquidityUsd)}\n`;
    card += `*📦 Volume:* 1h ${fmtUsd(dex.volume1h)} | 24h ${fmtUsd(dex.volume24h)}\n`;
    card += `*🔄 Buys/Sells 24h:* ${dex.buys24h} / ${dex.sells24h} (ratio ${dex.buySellRatio})\n`;
    card += `*📈 FDV:* ${fmtUsd(dex.fdv)}`;
    if (dex.marketCap > 0) card += ` | *MCap:* ${fmtUsd(dex.marketCap)}`;
    card += '\n';
    if (dex.liqMcapRatio) {
      const rugRisk = Number(dex.liqMcapRatio) < 3 ? '🔴 HIGH RUG RISK' : Number(dex.liqMcapRatio) < 8 ? '🟡 MODERATE' : '🟢 HEALTHY';
      card += `*💦 Liq/MCap:* ${dex.liqMcapRatio}% ${rugRisk}\n`;
    }
    card += `*🏦 DEX:* ${dex.dexId} · ${dex.pairName} · Age: ${ageStr}\n`;
    if (dex.url) card += `[📊 View Chart](${dex.url})\n`;
  } else {
    card += `\n_⚠️ Not listed on any DEX — token may be very new or unlisted_\n`;
  }

  // AI deep analysis
  const key = ANTHROPIC_KEY();
  if (key) {
    typing(chatId);
    const langInstruction = lang === 'id'
      ? 'IMPORTANT: Reply entirely in Bahasa Indonesia.'
      : 'Reply in English.';

    const ctx = [
      token ? `Token: ${token.name} (${token.symbol}), Supply: ${token.totalSupply}` : 'Token info unavailable',
      dex ? [
        `Price: ${priceStr} | Change: 1h ${fmtChange(dex.priceChange1h)} / 6h ${fmtChange(dex.priceChange6h)} / 24h ${fmtChange(dex.priceChange24h)}`,
        `Liquidity: ${fmtUsd(dex.liquidityUsd)} | Volume 24h: ${fmtUsd(dex.volume24h)}`,
        `Buys/Sells 24h: ${dex.buys24h}/${dex.sells24h} (ratio: ${dex.buySellRatio})`,
        `FDV: ${fmtUsd(dex.fdv)} | MCap: ${fmtUsd(dex.marketCap)}`,
        dex.liqMcapRatio ? `Liq/MCap Ratio: ${dex.liqMcapRatio}%` : '',
        `Pair age: ${ageStr} | DEX: ${dex.dexId}`,
      ].filter(Boolean).join('\n') : 'No DEX listing.',
    ].join('\n');

    try {
      const { url: aiUrl, headers: aiHdr } = aiEndpoint(key);
      const r = await fetch(aiUrl, {
        method: 'POST',
        headers: aiHdr,
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 700,
          system: `You are an expert crypto security analyst for Base network tokens with deep knowledge of rug pulls, honeypots, wash trading, and DeFi risks. ${langInstruction}
Use Telegram markdown: *bold* for headers. Be concise but specific — cite actual numbers from the data.`,
          messages: [{
            role: 'user',
            content: `Analyze this Base token. Use this exact format:\n\n*🚩 Red Flags*\n• [specific flags with data, or: None detected]\n\n*✅ Green Flags*\n• [specific positives with data, or: None detected]\n\n*📉 Risk Assessment*\n[liquidity risk, price manipulation risk, rug pull probability — cite Liq/MCap ratio and buy/sell data]\n\n*⚖️ Verdict: SAFE / CAUTION / HIGH RISK / SCAM LIKELY*\n[One sentence with the key reason]\n\nData:\n${ctx}`,
          }],
        }),
      });
      const d = await r.json();
      const verdict = d.content?.[0]?.text;
      if (verdict) card += '\n' + verdict;
    } catch { card += `\n_AI analysis unavailable_`; }
  }

  await sendLong(chatId, card);
}

// ── Wallet Watcher ────────────────────────────────────────────────────────────

async function cmdWatch(chatId, address, lang = 'en') {
  typing(chatId);

  const [balR, txR, tokenTxR] = await Promise.allSettled([
    baseRpc('eth_getBalance', [address, 'latest']),
    fetch(`https://base.blockscout.com/api/v2/addresses/${address}/transactions?limit=5`, {
      headers: { Accept: 'application/json' },
    }).then(r => r.json()),
    fetch(`https://base.blockscout.com/api/v2/addresses/${address}/token-transfers?limit=5`, {
      headers: { Accept: 'application/json' },
    }).then(r => r.json()),
  ]);

  const ethBal = balR.status === 'fulfilled'
    ? (Number(BigInt(balR.value)) / 1e18).toFixed(4) : '?';
  const txns = txR.status === 'fulfilled' ? (txR.value?.items || []) : [];
  const tokenTxns = tokenTxR.status === 'fulfilled' ? (tokenTxR.value?.items || []) : [];

  const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const isID = lang === 'id';

  let msg = `👁 *${isID ? 'PELACAK DOMPET' : 'WALLET WATCHER'}*\n`;
  msg    += `\`${shortAddr}\` · Base Network\n`;
  msg    += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg    += `*${isID ? 'Saldo ETH' : 'ETH Balance'}:* ${ethBal} ETH\n`;

  if (txns.length) {
    msg += `\n*${isID ? 'Transaksi Terakhir' : 'Recent Transactions'}:*\n`;
    for (const tx of txns) {
      const isIn   = tx.to?.hash?.toLowerCase() === address.toLowerCase();
      const dir    = isIn ? '📥' : '📤';
      const status = tx.status === 'ok' ? '✅' : '❌';
      const val    = tx.value ? (Number(BigInt(tx.value)) / 1e18).toFixed(4) : '0.0000';
      const peer   = isIn ? tx.from?.hash : tx.to?.hash;
      const peerS  = peer ? `${peer.slice(0, 6)}...${peer.slice(-4)}` : '?';
      msg += `${dir} ${status} *${val} ETH* ${isIn ? (isID ? 'dari' : 'from') : (isID ? 'ke' : 'to')} \`${peerS}\`\n`;
    }
  }

  if (tokenTxns.length) {
    msg += `\n*${isID ? 'Transfer Token Terakhir' : 'Recent Token Transfers'}:*\n`;
    for (const tx of tokenTxns.slice(0, 4)) {
      const isIn  = tx.to?.hash?.toLowerCase() === address.toLowerCase();
      const sym   = tx.token?.symbol || '?';
      const val   = tx.total?.value && tx.token?.decimals
        ? (Number(tx.total.value) / Math.pow(10, tx.token.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 })
        : '?';
      msg += `${isIn ? '📥' : '📤'} *${val} ${sym}* ${isIn ? (isID ? 'masuk' : 'in') : (isID ? 'keluar' : 'out')}\n`;
    }
  }

  if (!txns.length && !tokenTxns.length) {
    msg += `\n_${isID ? 'Tidak ada transaksi ditemukan.' : 'No recent transactions found.'}_`;
  }

  msg += `\n[${isID ? '📊 Lihat di Basescan' : '📊 View on Basescan'}](https://basescan.org/address/${address})`;
  msg += `\n\n_${isID ? '💡 Untuk notifikasi real-time, kunjungi' : '💡 For real-time alerts, visit'} [orlixai.xyz/app](https://orlixai.xyz/app)_`;

  await sendLong(chatId, msg);
}

// ── Quick Price Lookup ────────────────────────────────────────────────────────

async function cmdPrice(chatId, address) {
  typing(chatId);
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { Accept: 'application/json' },
  }).catch(() => null);
  if (!r?.ok) {
    return send(chatId, '⚠️ Could not fetch price. Check the address and try again.');
  }
  const data = await r.json();
  const pairs = (data.pairs || []).filter(p => p.chainId === 'base');
  const best  = (pairs.length ? pairs : (data.pairs || [])).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!best) return send(chatId, '⚠️ Token not listed on any DEX.');

  const price   = best.priceUsd ? `$${Number(best.priceUsd).toFixed(8)}` : '—';
  const ch24    = best.priceChange?.h24;
  const chStr   = ch24 == null ? '—' : (ch24 >= 0 ? `🟢 +${ch24}%` : `🔴 ${ch24}%`);
  const liq     = `$${Number(best.liquidity?.usd || 0).toLocaleString()}`;
  const vol     = `$${Number(best.volume?.h24 || 0).toLocaleString()}`;
  const sym     = best.baseToken?.symbol || '?';

  let msg = `💵 *${sym} PRICE*\n`;
  msg    += `*Price:* ${price}\n`;
  msg    += `*24h Change:* ${chStr}\n`;
  msg    += `*Liquidity:* ${liq}\n`;
  msg    += `*Volume 24h:* ${vol}\n`;
  if (best.url) msg += `[📊 Chart](${best.url})`;

  await send(chatId, msg);
}

// ── AI chat ───────────────────────────────────────────────────────────────────

async function cmdChat(chatId, text, lang) {
  const key = ANTHROPIC_KEY();
  if (!key) {
    return send(chatId, '⚠️ Bot not fully configured.');
  }

  const isID = lang === 'id';

  const { url: aiUrl2, headers: aiHdr2 } = aiEndpoint(key);
  const r = await fetch(aiUrl2, {
    method: 'POST',
    headers: aiHdr2,
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are Orlix AI — a highly intelligent, versatile AI assistant running inside Telegram.

${isID ? 'PENTING: Pengguna menulis dalam Bahasa Indonesia. Balas SELALU dalam Bahasa Indonesia yang baik dan natural.' : 'Reply in English.'}

Your capabilities:
- Answer ANY question on ANY topic: science, coding, math, history, writing, business, health, law, philosophy, creative writing, and more
- Analyze crypto tokens, wallets, DeFi protocols, and onchain data
- Write code in any programming language and explain it clearly
- Help with research, analysis, calculations, and problem-solving
- Translate between languages
- Summarize documents, articles, or any text

Guidelines:
- Be accurate, thoughtful, and comprehensive
- For complex topics, structure your answer clearly
- Use Telegram markdown: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`
- When relevant, mention /analyze 0x... for token analysis and /watch 0x... for wallets
- Keep replies under 3000 characters when possible, but never sacrifice completeness for brevity
- If asked about something you're not sure about, say so clearly`,
      messages: [{ role: 'user', content: text }],
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${r.status}`);
  }
  const data = await r.json();
  await sendLong(chatId, data.content?.[0]?.text || (isID ? 'Tidak dapat menghasilkan respons.' : 'Could not generate a response.'));
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

  typing(chatId);

  const lang = detectLang(text);
  const isID = lang === 'id';

  // ── /start ───────────────────────────────────────────────────────────────
  if (text === '/start' || text.startsWith('/start ')) {
    await send(chatId,
      `👋 ${isID ? `Selamat datang di *Orlix AI*, ${firstName}!` : `Welcome to *Orlix AI*, ${firstName}!`}\n\n` +
      (isID
        ? `Asisten AI pintar yang bisa menjawab *apa saja* — dari coding, sains, matematika, hingga analisa token kripto dan dompet Base.\n\n*Perintah:*\n`
        : `Your intelligent AI assistant for *anything* — coding, science, math, crypto analysis, wallet tracking, and more.\n\n*Commands:*\n`) +
      `/analyze \`0x...\` — ${isID ? 'Analisa keamanan token' : 'Token security analysis'}\n` +
      `/watch \`0x...\` — ${isID ? 'Cek aktivitas dompet' : 'Wallet activity tracker'}\n` +
      `/price \`0x...\` — ${isID ? 'Harga token cepat' : 'Quick token price'}\n` +
      `/help — ${isID ? 'Daftar lengkap perintah' : 'Full command list'}\n` +
      `/web — ${isID ? 'Buka dashboard Orlix' : 'Open Orlix dashboard'}\n\n` +
      `_${isID ? 'Atau ketik apa saja — saya siap menjawab!' : 'Or just type anything — I\'m here to help!'}_\n\n` +
      `_Powered by Claude · orlixai.xyz_`
    );
    return res.status(200).json({ ok: true });
  }

  // ── /help ────────────────────────────────────────────────────────────────
  if (text === '/help') {
    await send(chatId,
      `*Orlix AI — ${isID ? 'Panduan Lengkap' : 'Full Command Reference'}*\n\n` +
      `*🤖 ${isID ? 'Asisten AI' : 'AI Assistant'}*\n` +
      `${isID ? 'Ketik pesan apa saja — saya bisa menjawab pertanyaan tentang:' : 'Type any message — I can answer questions about:'}\n` +
      `${isID ? '• Coding & pemrograman (Python, JS, Rust, dll)' : '• Coding & programming (Python, JS, Rust, etc.)'}\n` +
      `${isID ? '• Sains, matematika, fisika, kimia' : '• Science, math, physics, chemistry'}\n` +
      `${isID ? '• Bisnis, hukum, keuangan, investasi' : '• Business, law, finance, investing'}\n` +
      `${isID ? '• Kripto, DeFi, blockchain, analisa pasar' : '• Crypto, DeFi, blockchain, market analysis'}\n` +
      `${isID ? '• Penulisan, terjemahan, ringkasan' : '• Writing, translation, summarization'}\n` +
      `${isID ? '• Dan masih banyak lagi!' : '• And much more!'}\n\n` +
      `*🪙 ${isID ? 'Analisa Token' : 'Token Analyzer'}*\n` +
      `/analyze \`0x...\`\n` +
      `${isID ? 'Harga, likuiditas, volume, rasio beli/jual, rasio Liq/MCap, analisa risiko AI mendalam.' : 'Price, liquidity, volume, buy/sell ratio, Liq/MCap ratio, deep AI risk analysis.'}\n\n` +
      `*💵 ${isID ? 'Harga Cepat' : 'Quick Price'}*\n` +
      `/price \`0x...\`\n` +
      `${isID ? 'Cek harga token secara instan.' : 'Instant token price check.'}\n\n` +
      `*👁 ${isID ? 'Pelacak Dompet' : 'Wallet Watcher'}*\n` +
      `/watch \`0x...\`\n` +
      `${isID ? 'Saldo ETH + transaksi ETH & token terbaru.' : 'ETH balance + recent ETH & token transactions.'}\n\n` +
      `*🌐 ${isID ? 'Lainnya' : 'Other'}*\n` +
      `/web — ${isID ? 'Dashboard lengkap (19 model AI, streaming)' : 'Full dashboard (19 AI models, streaming)'}\n` +
      `/clear — ${isID ? 'Reset percakapan' : 'Reset conversation'}\n\n` +
      `[orlixai.xyz](https://orlixai.xyz)`
    );
    return res.status(200).json({ ok: true });
  }

  // ── /web ─────────────────────────────────────────────────────────────────
  if (text === '/web') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: isID
        ? '🌐 Buka dashboard Orlix AI untuk streaming, upload gambar, dan 19 model AI:'
        : '🌐 Open the Orlix AI dashboard for streaming, image upload, and 19 AI models:',
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 Launch Orlix AI', url: 'https://orlixai.xyz/app' }]],
      },
    });
    return res.status(200).json({ ok: true });
  }

  // ── /clear ───────────────────────────────────────────────────────────────
  if (text === '/clear') {
    await send(chatId, isID ? '🗑 Percakapan direset. Siap mulai dari awal!' : '🗑 Conversation cleared. Ready for a fresh start!');
    return res.status(200).json({ ok: true });
  }

  // ── /analyze 0x... ───────────────────────────────────────────────────────
  if (text.startsWith('/analyze')) {
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID
        ? `⚠️ *Alamat tidak valid*\n\nContoh: /analyze \`0x...\`\n\nPaste alamat kontrak (42 karakter dimulai dengan 0x).`
        : `⚠️ *Invalid address*\n\nUsage: /analyze \`0x...\`\n\nPaste the contract address (42 chars starting with 0x).`
      );
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID
      ? `🔍 Mengambil data onchain untuk \`${addr.slice(0, 6)}...${addr.slice(-4)}\`…`
      : `🔍 Fetching onchain data for \`${addr.slice(0, 6)}...${addr.slice(-4)}\`…`
    );
    try { await cmdAnalyze(chatId, addr, lang); }
    catch (e) { await send(chatId, `⚠️ ${isID ? 'Analisa gagal' : 'Analysis failed'}: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /price 0x... ─────────────────────────────────────────────────────────
  if (text.startsWith('/price')) {
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID
        ? `⚠️ Contoh: /price \`0x...\``
        : `⚠️ Usage: /price \`0x...\``
      );
      return res.status(200).json({ ok: true });
    }
    try { await cmdPrice(chatId, addr); }
    catch (e) { await send(chatId, `⚠️ ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /watch 0x... ─────────────────────────────────────────────────────────
  if (text.startsWith('/watch')) {
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID
        ? `⚠️ Contoh: /watch \`0x...\``
        : `⚠️ Usage: /watch \`0x...\``
      );
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID
      ? `👁 Memeriksa dompet \`${addr.slice(0, 6)}...${addr.slice(-4)}\`…`
      : `👁 Looking up wallet \`${addr.slice(0, 6)}...${addr.slice(-4)}\`…`
    );
    try { await cmdWatch(chatId, addr, lang); }
    catch (e) { await send(chatId, `⚠️ ${isID ? 'Gagal' : 'Failed'}: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── Photo / vision ────────────────────────────────────────────────────────
  if (message.photo) {
    const caption = message.caption || (isID ? 'Jelaskan gambar ini' : 'Describe this image');
    const photo   = message.photo[message.photo.length - 1];
    const fileRes = await tg('getFile', { file_id: photo.file_id }).then(r => r?.json()).catch(() => null);
    if (!fileRes?.result?.file_path) {
      await send(chatId, isID
        ? '📸 Untuk analisa gambar penuh, kunjungi [orlixai.xyz/app](https://orlixai.xyz/app).'
        : '📸 For full image analysis, visit [orlixai.xyz/app](https://orlixai.xyz/app).'
      );
      return res.status(200).json({ ok: true });
    }
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileRes.result.file_path}`;
    const imgBuf  = await fetch(fileUrl).then(r => r.arrayBuffer()).catch(() => null);
    if (!imgBuf) {
      await send(chatId, '⚠️ ' + (isID ? 'Gagal mengunduh gambar.' : 'Could not download image.'));
      return res.status(200).json({ ok: true });
    }
    const b64  = Buffer.from(imgBuf).toString('base64');
    const ext  = fileRes.result.file_path.split('.').pop() || 'jpeg';
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    try {
      const { url: aiUrl3, headers: aiHdr3 } = aiEndpoint(ANTHROPIC_KEY());
      const r = await fetch(aiUrl3, {
        method: 'POST',
        headers: aiHdr3,
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: `You are Orlix AI. ${isID ? 'Balas dalam Bahasa Indonesia.' : 'Reply in English.'} Use Telegram markdown (*bold*, _italic_, \`code\`). Be detailed and thorough in your analysis.`,
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
      await sendLong(chatId, data.content?.[0]?.text || (isID ? 'Tidak dapat menganalisa gambar.' : 'Could not analyze image.'));
    } catch (e) {
      await send(chatId, `⚠️ Vision error: ${e.message}`);
    }
    return res.status(200).json({ ok: true });
  }

  // ── Regular message → Claude (smart, versatile) ───────────────────────────
  if (!text) return res.status(200).json({ ok: true });

  try {
    await cmdChat(chatId, text, lang);
  } catch (e) {
    await send(chatId, `⚠️ Error: ${e.message}`);
  }

  return res.status(200).json({ ok: true });
};
