// Orlix AI — Telegram Bot Webhook
// Setup: set TELEGRAM_BOT_TOKEN env var, then:
// GET https://api.telegram.org/bot{TOKEN}/setWebhook?url=https://orlixai.xyz/api/telegram

const { ethers } = require('ethers');

const ANTHROPIC_KEY = () => process.env.BANKR_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';
const TG_TOKEN      = () => process.env.TELEGRAM_BOT_TOKEN || '';

const ORLIX_CA   = '0x799c28BAC95B3E0B26534D1e9A586511895EcBA3';
const BASE_RPC   = 'https://mainnet.base.org';
const GATE_MIN   = BigInt('10000000') * (10n ** 18n);

// In-memory session cache (survives warm invocations, resets on cold start)
const sessions = new Map(); // chatId → { wallet, verified, balance }

// ── Agent wallet ───────────────────────────────────────────────────────────────
// Each Telegram user gets a UNIQUE Base wallet, derived deterministically from a
// server-side master secret + their user id — so we never store private keys and
// can always regenerate the same address on demand.
//
// Requires env AGENT_WALLET_SEED (a long random secret — keep it out of git!).
// This is CUSTODIAL: whoever holds AGENT_WALLET_SEED controls every user's agent
// wallet. Spending is intentionally NOT implemented — outgoing transfers stay
// disabled until an explicit approval flow is built. Treat these as receive-only
// deposit addresses for now; don't tell users to park large funds.
function agentWallet(userId) {
  const seed = process.env.AGENT_WALLET_SEED || '';
  if (!seed || userId == null) return null;
  // private key = keccak256("orlix-agent:v1:<seed>:<userId>") — 32 bytes, stable
  const pk = ethers.keccak256(ethers.toUtf8Bytes(`orlix-agent:v1:${seed}:${userId}`));
  return new ethers.Wallet(pk);
}

function aiEndpoint(key) {
  const isAnthropicKey = key.startsWith('sk-ant-');
  return {
    url:     isAnthropicKey ? 'https://api.anthropic.com/v1/messages' : 'https://llm.bankr.bot/v1/messages',
    headers: { 'Content-Type': 'application/json', ...(isAnthropicKey ? { 'x-api-key': key } : { 'X-API-Key': key }), 'anthropic-version': '2023-06-01' },
  };
}

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

// ── Language detection ────────────────────────────────────────────────────────
function detectLang(text) {
  const idWords = /\b(apa|ini|itu|dan|yang|di|ke|dari|untuk|dengan|tidak|bisa|mau|tolong|gimana|kenapa|berapa|siapa|kapan|dimana|bagaimana|adalah|saya|aku|kamu|kita|mereka|harga|token|analisa|dompet|kripto)\b/i;
  return idWords.test(text) ? 'id' : 'en';
}

// ── ORLIX balance check ───────────────────────────────────────────────────────
async function getOrlixBalance(wallet) {
  try {
    const data = '0x70a08231' + wallet.replace('0x', '').toLowerCase().padStart(64, '0');
    const r = await fetch(BASE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ORLIX_CA, data }, 'latest'] }),
      signal: AbortSignal.timeout(6000),
    });
    const d   = await r.json();
    const hex = d.result || '0x0';
    return hex === '0x' ? 0n : BigInt(hex);
  } catch { return 0n; }
}

// ── Gate check ────────────────────────────────────────────────────────────────
function isVerified(chatId) {
  return sessions.get(chatId)?.verified === true;
}

async function requireGate(chatId, lang) {
  const isID = lang === 'id';
  await send(chatId,
    isID
      ? `🔒 *Akses Terkunci*\n\nFitur AI memerlukan minimal *10,000,000 $ORLIX* di wallet Base.\n\nKirim wallet kamu:\n\`/connect 0xALAMAT_WALLET\`\n\n_Beli $ORLIX: [orlixai.xyz/token](https://orlixai.xyz/token)_`
      : `🔒 *Access Locked*\n\nAI features require holding at least *10,000,000 $ORLIX* on Base.\n\nSend your wallet:\n\`/connect 0xYOUR_WALLET\`\n\n_Get $ORLIX: [orlixai.xyz/token](https://orlixai.xyz/token)_`
  );
}

// ── /connect ──────────────────────────────────────────────────────────────────
async function cmdConnect(chatId, wallet, lang) {
  const isID = lang === 'id';
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return send(chatId, isID
      ? `⚠️ Alamat tidak valid.\n\nContoh:\n\`/connect 0xALAMAT_WALLET_KAMU\``
      : `⚠️ Invalid address.\n\nExample:\n\`/connect 0xYOUR_WALLET_ADDRESS\``
    );
  }

  typing(chatId);
  await send(chatId, isID ? '⏳ Memeriksa saldo $ORLIX...' : '⏳ Checking $ORLIX balance...');

  const balance = await getOrlixBalance(wallet);
  const balNum  = Number(balance / 10n ** 15n) / 1000;
  const balFmt  = balNum.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const short   = `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;

  if (balance >= GATE_MIN) {
    sessions.set(chatId, { wallet, verified: true, balance: balFmt });
    await send(chatId,
      isID
        ? `✅ *Akses Diberikan!*\n\nWallet: \`${short}\`\nSaldo: *${balFmt} ORLIX*\n\nKamu sekarang punya akses penuh ke Orlix AI Bot 🎉\n\n_Ketik apa saja atau gunakan /help_`
        : `✅ *Access Granted!*\n\nWallet: \`${short}\`\nBalance: *${balFmt} ORLIX*\n\nYou now have full access to Orlix AI Bot 🎉\n\n_Type anything or use /help_`
    );
  } else {
    sessions.set(chatId, { wallet, verified: false, balance: balFmt });
    const needed = Number((GATE_MIN - balance) / 10n ** 15n) / 1000;
    await send(chatId,
      isID
        ? `❌ *Saldo Tidak Cukup*\n\nWallet: \`${short}\`\nSaldo: *${balFmt} ORLIX*\nDibutuhkan: *10,000,000 ORLIX*\nKurang: *${needed.toLocaleString('en-US', { maximumFractionDigits: 0 })} ORLIX*\n\n_Beli $ORLIX: [orlixai.xyz/token](https://orlixai.xyz/token)_`
        : `❌ *Insufficient Balance*\n\nWallet: \`${short}\`\nBalance: *${balFmt} ORLIX*\nRequired: *10,000,000 ORLIX*\nShortfall: *${needed.toLocaleString('en-US', { maximumFractionDigits: 0 })} ORLIX*\n\n_Get $ORLIX: [orlixai.xyz/token](https://orlixai.xyz/token)_`
    );
  }
}

// ── On-chain helpers ──────────────────────────────────────────────────────────

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

  const key = ANTHROPIC_KEY();
  if (key) {
    typing(chatId);
    const langInstruction = lang === 'id' ? 'IMPORTANT: Reply entirely in Bahasa Indonesia.' : 'Reply in English.';
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
          system: `You are an expert crypto security analyst for Base network tokens. ${langInstruction} Use Telegram markdown: *bold* for headers. Be concise but specific — cite actual numbers from the data.`,
          messages: [{
            role: 'user',
            content: `Analyze this Base token. Format:\n\n*🚩 Red Flags*\n• [specific flags or: None detected]\n\n*✅ Green Flags*\n• [specific positives or: None detected]\n\n*📉 Risk Assessment*\n[liquidity risk, price manipulation, rug pull probability — cite Liq/MCap ratio and buy/sell data]\n\n*⚖️ Verdict: SAFE / CAUTION / HIGH RISK / SCAM LIKELY*\n[One sentence with key reason]\n\nData:\n${ctx}`,
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
  await sendLong(chatId, msg);
}

// ── Quick Price ───────────────────────────────────────────────────────────────

async function cmdPrice(chatId, address) {
  typing(chatId);
  const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
    headers: { Accept: 'application/json' },
  }).catch(() => null);
  if (!r?.ok) return send(chatId, '⚠️ Could not fetch price. Check the address and try again.');
  const data = await r.json();
  const pairs = (data.pairs || []).filter(p => p.chainId === 'base');
  const best  = (pairs.length ? pairs : (data.pairs || [])).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  if (!best) return send(chatId, '⚠️ Token not listed on any DEX.');

  const price = best.priceUsd ? `$${Number(best.priceUsd).toFixed(8)}` : '—';
  const ch24  = best.priceChange?.h24;
  const chStr = ch24 == null ? '—' : (ch24 >= 0 ? `🟢 +${ch24}%` : `🔴 ${ch24}%`);
  const sym   = best.baseToken?.symbol || '?';

  let msg = `💵 *${sym} PRICE*\n`;
  msg    += `*Price:* ${price}\n`;
  msg    += `*24h Change:* ${chStr}\n`;
  msg    += `*Liquidity:* $${Number(best.liquidity?.usd || 0).toLocaleString()}\n`;
  msg    += `*Volume 24h:* $${Number(best.volume?.h24 || 0).toLocaleString()}\n`;
  if (best.url) msg += `[📊 Chart](${best.url})`;
  await send(chatId, msg);
}

// ── AI Chat ───────────────────────────────────────────────────────────────────

async function cmdChat(chatId, text, lang) {
  const key = ANTHROPIC_KEY();
  if (!key) return send(chatId, '⚠️ Bot not fully configured.');

  const isID = lang === 'id';
  const { url: aiUrl, headers: aiHdr } = aiEndpoint(key);
  const r = await fetch(aiUrl, {
    method: 'POST',
    headers: aiHdr,
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are Orlix AI — a highly intelligent, versatile AI assistant running inside Telegram.

${isID ? 'PENTING: Pengguna menulis dalam Bahasa Indonesia. Balas SELALU dalam Bahasa Indonesia yang baik dan natural.' : 'Reply in English.'}

Your capabilities:
- Answer ANY question on ANY topic: science, coding, math, history, writing, business, health, law, philosophy, creative writing, and more
- Analyze crypto tokens, wallets, DeFi protocols, and onchain data
- Write code in any programming language
- Help with research, analysis, calculations, and problem-solving
- Translate between languages

Guidelines:
- Be accurate, thoughtful, and comprehensive
- Use Telegram markdown: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`
- When relevant, mention /analyze 0x... for token analysis and /watch 0x... for wallets
- Keep replies under 3000 characters when possible`,
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

// ── One-time setup: register the command list + the blue "Menu" button ──────────
// The native Telegram Menu button appears automatically once commands are set.
// Trigger once after deploy:  GET /api/telegram?setup=<TELEGRAM_WEBHOOK_SECRET>
async function setupBot() {
  const post = async (method, body) => {
    const r = await tg(method, body);
    return r ? await r.json().catch(() => ({ ok: false })) : { ok: false, error: 'no token' };
  };
  // Single English command set for everyone (matches the English website/brand).
  const en = [
    { command: 'start',   description: 'About Orlix + get started' },
    { command: 'menu',    description: 'Quick actions' },
    { command: 'wallet',  description: 'Your Base agent wallet' },
    { command: 'price',   description: 'Quick token price' },
    { command: 'watch',   description: 'Wallet activity tracker' },
    { command: 'analyze', description: 'Deep token analysis' },
    { command: 'web',     description: 'Open the full dashboard' },
    { command: 'connect', description: 'Verify 10M $ORLIX for AI access' },
    { command: 'help',    description: 'Full command list' },
  ];
  return {
    commands:   (await post('setMyCommands', { commands: en })).ok,
    // remove any old Indonesian override so ID-language users also see English
    clearedID:  (await post('deleteMyCommands', { language_code: 'id' })).ok,
    menuButton: (await post('setChatMenuButton', { menu_button: { type: 'commands' } })).ok,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const token = TG_TOKEN();
    const llmKey = ANTHROPIC_KEY();
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    // one-time: register commands + Menu button
    if (req.query && req.query.setup !== undefined) {
      if (secret && req.query.setup !== secret) {
        return res.status(403).json({ ok: false, error: 'bad setup key' });
      }
      const setup = await setupBot();
      return res.status(200).json({ ok: true, setup });
    }
    return res.status(200).json({
      ok: true,
      configured: !!token,
      status: {
        TELEGRAM_BOT_TOKEN: token ? `set (${token.slice(0,8)}...)` : 'MISSING',
        BANKR_LLM_KEY: llmKey ? `set (${llmKey.slice(0,8)}...)` : 'MISSING',
        TELEGRAM_WEBHOOK_SECRET: secret ? 'set' : 'not set',
      }
    });
  }
  if (req.method !== 'POST') return res.status(405).end();

  const token = TG_TOKEN();
  if (!token) return res.status(200).json({ ok: true });

  // Fail CLOSED: the webhook secret MUST be configured and match. Without this,
  // anyone could forge Telegram updates and drain LLM credits.
  // Set TELEGRAM_WEBHOOK_SECRET in Vercel env AND on the Telegram webhook.
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const incoming = req.headers['x-telegram-bot-api-secret-token'] || '';
  if (!webhookSecret || incoming !== webhookSecret) return res.status(200).json({ ok: true });

  const update  = req.body || {};
  const message = update.message || update.edited_message;
  if (!message) return res.status(200).json({ ok: true });

  const chatId    = message.chat?.id;
  const userId    = message.from?.id ?? chatId;
  const firstName = message.from?.first_name || 'friend';
  const text      = (message.text || '').trim();
  if (!chatId) return res.status(200).json({ ok: true });

  typing(chatId);
  const lang = detectLang(text);
  const isID = lang === 'id';

  // ── /start ────────────────────────────────────────────────────────────────
  if (text === '/start' || text.startsWith('/start ')) {
    const session = sessions.get(chatId);
    const accessLine = session?.verified
      ? (isID ? `\n✅ _Wallet terverifikasi · ${session.balance} ORLIX_` : `\n✅ _Wallet verified · ${session.balance} ORLIX_`)
      : (isID ? `\n🔒 _Fitur AI memerlukan 10M $ORLIX — gunakan /connect 0xWALLET_` : `\n🔒 _AI features require 10M $ORLIX — use /connect 0xWALLET_`);

    await send(chatId,
      `👋 ${isID ? `Selamat datang di *Orlix AI*, ${firstName}!` : `Welcome to *Orlix AI*, ${firstName}!`}\n\n` +
      (isID
        ? `Asisten AI yang bisa menjawab *apa saja* — plus analisa token & dompet Base.\n\n*Perintah:*\n`
        : `Your AI assistant for *anything* — plus Base token & wallet analysis.\n\n*Commands:*\n`) +
      `/connect \`0x...\` — ${isID ? 'Verifikasi wallet (butuh 10M $ORLIX)' : 'Verify wallet (need 10M $ORLIX)'}\n` +
      `/analyze \`0x...\` — ${isID ? 'Analisa keamanan token' : 'Token security analysis'}\n` +
      `/watch \`0x...\` — ${isID ? 'Cek aktivitas dompet' : 'Wallet activity tracker'}\n` +
      `/price \`0x...\` — ${isID ? 'Harga token cepat' : 'Quick token price'}\n` +
      `/help — ${isID ? 'Panduan lengkap' : 'Full command list'}\n` +
      `/web — ${isID ? 'Buka dashboard Orlix' : 'Open Orlix dashboard'}\n` +
      accessLine + `\n\n_Powered by Claude · orlixai.xyz_`
    );
    return res.status(200).json({ ok: true });
  }

  // ── /connect ──────────────────────────────────────────────────────────────
  if (text.startsWith('/connect')) {
    const wallet = (text.split(/\s+/)[1] || '').trim();
    try { await cmdConnect(chatId, wallet, lang); }
    catch (e) { await send(chatId, `⚠️ Error: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /menu ─────────────────────────────────────────────────────────────────
  if (text === '/menu') {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      text: isID
        ? `*⚡ Menu Orlix AI*\n\nTap perintah:\n/wallet — Agent wallet Base kamu\n/price \`0x…\` — Harga token\n/watch \`0x…\` — Aktivitas dompet\n/analyze \`0x…\` — Analisa token _(10M $ORLIX)_\n/connect — Verifikasi akses\n/help — Bantuan lengkap\n\n_Atau ketik pertanyaan apa saja ke AI._`
        : `*⚡ Orlix AI Menu*\n\nTap a command:\n/wallet — Your Base agent wallet\n/price \`0x…\` — Token price\n/watch \`0x…\` — Wallet activity\n/analyze \`0x…\` — Token analysis _(10M $ORLIX)_\n/connect — Verify access\n/help — Full help\n\n_Or just type any question to the AI._`,
      reply_markup: { inline_keyboard: [
        [{ text: '🚀 Open Dashboard', url: 'https://orlixai.xyz/app' }],
        [{ text: '🏙 Base City', url: 'https://orlixai.xyz/neural-map.html' },
         { text: '🪙 Buy $ORLIX', url: 'https://orlixai.xyz/token' }],
      ] },
    });
    return res.status(200).json({ ok: true });
  }

  // ── /wallet ─────────────────────────────────────────────────────────────────
  if (text === '/wallet' || text.startsWith('/wallet ')) {
    const w = agentWallet(userId);
    if (!w) {
      await send(chatId, isID
        ? `⚠️ Fitur agent wallet belum dikonfigurasi.`
        : `⚠️ Agent wallet is not configured yet.`);
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID
      ? `👛 *Agent Wallet Base kamu:*\n\`${w.address}\`\n\n_Spending dinonaktifkan sampai approval dikonfigurasi._`
      : `👛 *Your Base agent wallet:*\n\`${w.address}\`\n\n_Spending is disabled until approval is configured._`);
    return res.status(200).json({ ok: true });
  }

  // ── /help ─────────────────────────────────────────────────────────────────
  if (text === '/help') {
    const verified = isVerified(chatId);
    await send(chatId,
      `*Orlix AI — ${isID ? 'Panduan Lengkap' : 'Full Command Reference'}*\n\n` +
      `*🔑 ${isID ? 'Akses' : 'Access'}* ${verified ? '✅' : '🔒'}\n` +
      `/connect \`0x...\` — ${isID ? 'Verifikasi 10M $ORLIX untuk akses AI penuh' : 'Verify 10M $ORLIX for full AI access'}\n\n` +
      `*📊 ${isID ? 'Data Onchain (Gratis)' : 'Onchain Data (Free)'}*\n` +
      `/price \`0x...\` — ${isID ? 'Harga token instan' : 'Instant token price'}\n` +
      `/watch \`0x...\` — ${isID ? 'Saldo & transaksi wallet' : 'Wallet balance & transactions'}\n\n` +
      `*🤖 ${isID ? 'Fitur AI (Perlu 10M $ORLIX)' : 'AI Features (Need 10M $ORLIX)'}*\n` +
      `/analyze \`0x...\` — ${isID ? 'Analisa risiko token mendalam' : 'Deep token risk analysis'}\n` +
      `${isID ? 'Chat bebas' : 'Free chat'} — ${isID ? 'Tanya apa saja' : 'Ask anything'}\n` +
      `${isID ? 'Kirim gambar' : 'Send image'} — ${isID ? 'Analisa visual AI' : 'AI visual analysis'}\n\n` +
      `*🌐 ${isID ? 'Lainnya' : 'Other'}*\n` +
      `/menu — ${isID ? 'Menu aksi cepat' : 'Quick actions menu'}\n` +
      `/wallet — ${isID ? 'Agent wallet Base kamu' : 'Your Base agent wallet'}\n` +
      `/web — ${isID ? 'Dashboard lengkap (19 model AI)' : 'Full dashboard (19 AI models)'}\n\n` +
      `[orlixai.xyz](https://orlixai.xyz)`
    );
    return res.status(200).json({ ok: true });
  }

  // ── /web ──────────────────────────────────────────────────────────────────
  if (text === '/web') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: isID ? '🌐 Buka dashboard Orlix AI:' : '🌐 Open the Orlix AI dashboard:',
      reply_markup: { inline_keyboard: [[{ text: '🚀 Launch Orlix AI', url: 'https://orlixai.xyz/app' }]] },
    });
    return res.status(200).json({ ok: true });
  }

  // ── /price (free) ─────────────────────────────────────────────────────────
  if (text.startsWith('/price')) {
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID ? `⚠️ Contoh: /price \`0x...\`` : `⚠️ Usage: /price \`0x...\``);
      return res.status(200).json({ ok: true });
    }
    try { await cmdPrice(chatId, addr); }
    catch (e) { await send(chatId, `⚠️ ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /watch (free) ─────────────────────────────────────────────────────────
  if (text.startsWith('/watch')) {
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID ? `⚠️ Contoh: /watch \`0x...\`` : `⚠️ Usage: /watch \`0x...\``);
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID ? `👁 Memeriksa dompet...` : `👁 Looking up wallet...`);
    try { await cmdWatch(chatId, addr, lang); }
    catch (e) { await send(chatId, `⚠️ ${isID ? 'Gagal' : 'Failed'}: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /analyze (gated) ──────────────────────────────────────────────────────
  if (text.startsWith('/analyze')) {
    if (!isVerified(chatId)) return requireGate(chatId, lang).then(() => res.status(200).json({ ok: true }));
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID ? `⚠️ Contoh: /analyze \`0x...\`` : `⚠️ Usage: /analyze \`0x...\``);
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID ? `🔍 Menganalisa token...` : `🔍 Analyzing token...`);
    try { await cmdAnalyze(chatId, addr, lang); }
    catch (e) { await send(chatId, `⚠️ ${isID ? 'Analisa gagal' : 'Analysis failed'}: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── Photo / vision (gated) ────────────────────────────────────────────────
  if (message.photo) {
    if (!isVerified(chatId)) return requireGate(chatId, lang).then(() => res.status(200).json({ ok: true }));
    const caption = message.caption || (isID ? 'Jelaskan gambar ini' : 'Describe this image');
    const photo   = message.photo[message.photo.length - 1];
    const fileRes = await tg('getFile', { file_id: photo.file_id }).then(r => r?.json()).catch(() => null);
    if (!fileRes?.result?.file_path) {
      await send(chatId, isID ? '📸 Gagal mengambil file gambar.' : '📸 Could not retrieve image file.');
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
      const { url: aiUrl, headers: aiHdr } = aiEndpoint(ANTHROPIC_KEY());
      const r = await fetch(aiUrl, {
        method: 'POST', headers: aiHdr,
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 1500,
          system: `You are Orlix AI. ${isID ? 'Balas dalam Bahasa Indonesia.' : 'Reply in English.'} Use Telegram markdown. Be detailed and thorough.`,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
            { type: 'text', text: caption },
          ]}],
        }),
      });
      const data = await r.json();
      await sendLong(chatId, data.content?.[0]?.text || (isID ? 'Tidak dapat menganalisa gambar.' : 'Could not analyze image.'));
    } catch (e) { await send(chatId, `⚠️ Vision error: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── Free text → AI chat (gated) ───────────────────────────────────────────
  if (!text) return res.status(200).json({ ok: true });

  if (!isVerified(chatId)) return requireGate(chatId, lang).then(() => res.status(200).json({ ok: true }));

  try { await cmdChat(chatId, text, lang); }
  catch (e) { await send(chatId, `⚠️ Error: ${e.message}`); }

  return res.status(200).json({ ok: true });
};
