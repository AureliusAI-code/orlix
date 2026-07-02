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

// ── AI access gate via the agent wallet ──────────────────────────────────────
// No /connect needed: a user unlocks AI simply by holding ≥10M $ORLIX in THEIR
// own agent wallet (from /wallet). We read that balance on demand and cache a
// positive result briefly to avoid an RPC on every message.
const gateCache = new Map(); // userId → { ok, t }
async function aiAllowed(chatId, userId) {
  if (isVerified(chatId)) return { ok: true };            // legacy /connect session still works
  const w = agentWallet(userId);
  if (!w) return { ok: false, address: null, bal: 0n };
  const cached = gateCache.get(userId);
  if (cached && cached.ok && Date.now() - cached.t < 180000) return { ok: true, address: w.address };
  const bal = await getOrlixBalance(w.address);
  const ok  = bal >= GATE_MIN;
  gateCache.set(userId, { ok, t: Date.now() });
  return { ok, address: w.address, bal };
}
async function denyAiGate(chatId, lang, gate) {
  const isID = lang === 'id';
  if (!gate.address) {
    return send(chatId, isID ? '⚠️ Agent wallet belum dikonfigurasi.' : '⚠️ Agent wallet is not configured yet.');
  }
  const held = Number(gate.bal / 10n ** 15n) / 1000;
  const heldFmt = held.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return send(chatId, isID
    ? `🔒 *Akses AI Terkunci*\n\nFitur AI perlu *10,000,000 $ORLIX* di agent wallet kamu.\n\nSetor ke:\n\`${gate.address}\`\n\nSaldo kamu: *${heldFmt} ORLIX*\n\n_Cek: /balance · Beli: [orlixai.xyz/token](https://orlixai.xyz/token)_`
    : `🔒 *AI Access Locked*\n\nAI features need *10,000,000 $ORLIX* in your agent wallet.\n\nDeposit to:\n\`${gate.address}\`\n\nYour balance: *${heldFmt} ORLIX*\n\n_Check: /balance · Buy: [orlixai.xyz/token](https://orlixai.xyz/token)_`);
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

// ERC-20 balanceOf(holder) → raw bigint
async function erc20BalanceOf(token, holder) {
  const data = '0x70a08231' + holder.replace('0x', '').toLowerCase().padStart(64, '0');
  const hex = await baseRpc('eth_call', [{ to: token, data }, 'latest']);
  return (!hex || hex === '0x') ? 0n : BigInt(hex);
}

// pretty-print a decimal-string amount
function fmtAmt(str) {
  const n = Number(str);
  if (!isFinite(n)) return str;
  if (n === 0) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1 ? 4 : 8 });
}

// ── Gate check ────────────────────────────────────────────────────────────────
function isVerified(chatId) {
  return sessions.get(chatId)?.verified === true;
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
  const supported = (data.pairs || []).filter(p => p.chainId === 'base' || p.chainId === 'robinhood');
  const pool = supported.length ? supported : (data.pairs || []);
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
    chainId:        best.chainId          || 'base',
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
          system: `You are an expert crypto security analyst for Base and Robinhood Chain tokens. ${langInstruction} ONLY use Telegram markdown: *bold* and _italic_. NEVER use ## headers, ---, > blockquotes, or any unsupported markdown. Use *bold text* on its own line for section titles. Be concise but specific — cite actual numbers from the data.`,
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
  const pairs = (data.pairs || []).filter(p => p.chainId === 'base' || p.chainId === 'robinhood');
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

FORMATTING RULES (STRICT):
- ONLY use Telegram-compatible markdown: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`
- NEVER use ## headers, ### headers, ---, >, or any other markdown syntax — Telegram does NOT render them
- For section titles, use *bold text* on its own line instead of ## headers
- For separators, use a blank line instead of ---
- For quotes or warnings, write them as plain bold text instead of > blockquotes
- Write clean, professional responses without raw markdown symbols showing
- When relevant, mention /analyze, /swap, /top, /watch, $TICKER
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

// ── Ticker Search ────────────────────────────────────────────────────────────

async function searchTicker(ticker) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(ticker)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const supported = (data.pairs || []).filter(p => p.chainId === 'base' || p.chainId === 'robinhood');
    if (!supported.length) return null;
    const exact = supported.filter(p => (p.baseToken?.symbol || '').toUpperCase() === ticker.toUpperCase());
    const pool = exact.length ? exact : supported;
    return pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  } catch { return null; }
}

async function cmdTickerPrice(chatId, ticker, lang) {
  typing(chatId);
  const isID = lang === 'id';
  const pair = await searchTicker(ticker);
  if (!pair) {
    return send(chatId, `⚠️ *$${ticker.toUpperCase()}* ${isID ? 'tidak ditemukan di Base / Robinhood Chain.' : 'not found on Base / Robinhood Chain.'}`);
  }

  const sym   = pair.baseToken?.symbol || ticker.toUpperCase();
  const name  = pair.baseToken?.name || '';
  const addr  = pair.baseToken?.address || '';
  const price = pair.priceUsd ? `$${Number(pair.priceUsd) < 0.0001 ? Number(pair.priceUsd).toFixed(10) : Number(pair.priceUsd) < 0.01 ? Number(pair.priceUsd).toFixed(8) : Number(pair.priceUsd).toFixed(6)}` : '—';
  const ch1h  = pair.priceChange?.h1;
  const ch24h = pair.priceChange?.h24;
  const liq   = pair.liquidity?.usd || 0;
  const vol   = pair.volume?.h24 || 0;
  const mcap  = pair.marketCap || pair.fdv || 0;
  const chain = pair.chainId === 'robinhood' ? '🟣 Robinhood' : '🔵 Base';
  const arrow = (v) => v == null ? '—' : v >= 0 ? `🟢 +${v}%` : `🔴 ${v}%`;

  let msg = `💰 *$${sym}*`;
  if (name) msg += ` — ${name}`;
  msg += `\n${chain}\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `*${isID ? 'Harga' : 'Price'}:* ${price}\n`;
  msg += `*1h:* ${arrow(ch1h)} | *24h:* ${arrow(ch24h)}\n`;
  msg += `*Liq:* $${liq.toLocaleString()} | *Vol 24h:* $${vol.toLocaleString()}\n`;
  if (mcap > 0) msg += `*MCap:* $${mcap.toLocaleString()}\n`;

  const buttons = [];
  if (addr) {
    buttons.push([{ text: `🔍 ${isID ? 'Analisa Lengkap' : 'Full Analysis'}`, callback_data: `analyze:${addr}` }]);
  }
  if (pair.url) buttons.push([{ text: '📈 Chart', url: pair.url }]);
  if (sym.toUpperCase() === 'ORLIX') {
    buttons.push([
      { text: '🔄 Swap ORLIX ↔ ETH', callback_data: 'swap_menu' },
    ]);
  }

  await tg('sendMessage', {
    chat_id: chatId, text: msg, parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  });
}

// ── Swap ─────────────────────────────────────────────────────────────────────

async function cmdSwap(chatId, args, lang) {
  typing(chatId);
  const isID = lang === 'id';
  const parts = args.trim().split(/\s+/).filter(Boolean);

  let amount = null, fromSym, toSym;
  if (parts.length >= 3 && !isNaN(parts[0])) {
    amount = parseFloat(parts[0]);
    fromSym = parts[1].toUpperCase();
    toSym = parts[2].toUpperCase();
  } else if (parts.length >= 2) {
    fromSym = parts[0].toUpperCase();
    toSym = parts[1].toUpperCase();
  } else {
    return tg('sendMessage', {
      chat_id: chatId, parse_mode: 'Markdown', disable_web_page_preview: true,
      text: isID
        ? `🔄 *Swap $ORLIX*\n\n*Format:*\n\`/swap ORLIX ETH\` — Swap ORLIX ke ETH\n\`/swap ETH ORLIX\` — Swap ETH ke ORLIX\n\`/swap 1000000 ORLIX ETH\` — Estimasi harga\n\n_Swap via DEX di Base network_`
        : `🔄 *Swap $ORLIX*\n\n*Usage:*\n\`/swap ORLIX ETH\` — Swap ORLIX to ETH\n\`/swap ETH ORLIX\` — Swap ETH to ORLIX\n\`/swap 1000000 ORLIX ETH\` — Price estimate\n\n_Swap via DEX on Base network_`,
      reply_markup: { inline_keyboard: [
        [{ text: '🔄 Swap ORLIX → ETH', url: `https://app.uniswap.org/swap?chain=base&inputCurrency=${ORLIX_CA}&outputCurrency=ETH` }],
        [{ text: '🔄 Swap ETH → ORLIX', url: `https://app.uniswap.org/swap?chain=base&inputCurrency=ETH&outputCurrency=${ORLIX_CA}` }],
        [{ text: '📊 ORLIX Chart', url: `https://dexscreener.com/base/${ORLIX_CA}` }],
      ] },
    });
  }

  const isOrlixToEth = fromSym === 'ORLIX' && (toSym === 'ETH' || toSym === 'WETH');
  const isEthToOrlix = (fromSym === 'ETH' || fromSym === 'WETH') && toSym === 'ORLIX';

  if (!isOrlixToEth && !isEthToOrlix) {
    return send(chatId, isID
      ? `🔄 Saat ini swap mendukung *ORLIX ↔ ETH*.\n\nContoh: \`/swap ORLIX ETH\` atau \`/swap ETH ORLIX\``
      : `🔄 Currently swap supports *ORLIX ↔ ETH*.\n\nExample: \`/swap ORLIX ETH\` or \`/swap ETH ORLIX\``);
  }

  const orlixPair = await searchTicker('ORLIX');
  if (!orlixPair || !orlixPair.priceUsd) {
    return send(chatId, `⚠️ ${isID ? 'Gagal mendapatkan harga ORLIX.' : 'Could not fetch ORLIX price.'}`);
  }

  const orlixPrice = Number(orlixPair.priceUsd);
  let ethPrice = 0;
  try {
    if (orlixPair.priceNative && Number(orlixPair.priceNative) > 0) {
      ethPrice = orlixPrice / Number(orlixPair.priceNative);
    }
    if (!ethPrice || ethPrice < 100) {
      const wethPair = await searchTicker('WETH');
      if (wethPair?.priceUsd) ethPrice = Number(wethPair.priceUsd);
    }
  } catch { /* use fallback */ }
  if (!ethPrice) ethPrice = 3500;

  const fmtPrice = (p) => p < 0.0001 ? p.toFixed(10) : p < 0.01 ? p.toFixed(8) : p.toFixed(6);
  let estimate = '';
  if (amount && amount > 0) {
    if (isOrlixToEth) {
      const ethOut = (amount * orlixPrice) / ethPrice;
      estimate = `\n*${isID ? 'Estimasi' : 'Estimate'}:*\n📥 ${amount.toLocaleString()} ORLIX → *${ethOut.toFixed(6)} ETH* (~$${(amount * orlixPrice).toFixed(2)})\n`;
    } else {
      const orlixOut = (amount * ethPrice) / orlixPrice;
      estimate = `\n*${isID ? 'Estimasi' : 'Estimate'}:*\n📥 ${amount} ETH → *${orlixOut.toLocaleString(undefined, { maximumFractionDigits: 0 })} ORLIX* (~$${(amount * ethPrice).toFixed(2)})\n`;
    }
  }

  const direction = isOrlixToEth ? 'ORLIX → ETH' : 'ETH → ORLIX';
  const inputCurrency = isOrlixToEth ? ORLIX_CA : 'ETH';
  const outputCurrency = isOrlixToEth ? 'ETH' : ORLIX_CA;

  let msg = `🔄 *Swap ${direction}*\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `*ORLIX:* $${fmtPrice(orlixPrice)}\n`;
  msg += `*ETH:* $${ethPrice.toFixed(2)}\n`;
  if (estimate) msg += estimate;
  msg += `\n_⚠️ ${isID ? 'Harga estimasi — slippage bisa terjadi saat swap.' : 'Estimated price — slippage may apply during swap.'}_`;

  await tg('sendMessage', {
    chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [
      [{ text: `🦄 Swap on Uniswap`, url: `https://app.uniswap.org/swap?chain=base&inputCurrency=${inputCurrency}&outputCurrency=${outputCurrency}` }],
      [{ text: `🔵 Swap on Aerodrome`, url: `https://aerodrome.finance/swap?from=${inputCurrency === 'ETH' ? 'eth' : ORLIX_CA}&to=${outputCurrency === 'ETH' ? 'eth' : ORLIX_CA}` }],
      [{ text: `📊 ORLIX Chart`, url: orlixPair.url || `https://dexscreener.com/base/${ORLIX_CA}` }],
    ] },
  });
}

// ── Top Tokens ───────────────────────────────────────────────────────────────

async function cmdTop(chatId, lang) {
  typing(chatId);
  const isID = lang === 'id';
  const searches = ['BRETT','VIRTUAL','AERO','DEGEN','TOSHI','HIGHER','MOG','WELL','ORLIX','AIXBT','PEPE','BONK','WIF','POPCAT','CLANKER'];
  const STABLES = new Set(['USDT','USDC','DAI','WETH','WBTC','CBETH','USDBC','USDB','EURC','RETH','STETH','WSTETH','ETH','FRAX']);

  try {
    const results = await Promise.all(
      searches.map(q =>
        fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) })
          .then(r => r.ok ? r.json() : null).catch(() => null)
      )
    );
    const seen = {};
    for (const r of results) {
      for (const p of (r?.pairs || [])) {
        if (p.chainId !== 'base' && p.chainId !== 'robinhood') continue;
        if (!p.baseToken?.address || STABLES.has((p.baseToken.symbol || '').toUpperCase())) continue;
        if ((p.liquidity?.usd || 0) < 5000) continue;
        const key = p.baseToken.address.toLowerCase();
        if (!seen[key] || (p.liquidity?.usd || 0) > (seen[key].liquidity?.usd || 0)) seen[key] = p;
      }
    }
    const top = Object.values(seen).sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0)).slice(0, 10);
    if (!top.length) return send(chatId, `⚠️ ${isID ? 'Gagal memuat data market.' : 'Failed to load market data.'}`);

    let msg = `🏆 *${isID ? 'Top Token — Base & Robinhood' : 'Top Tokens — Base & Robinhood'}*\n━━━━━━━━━━━━━━━━━━━━\n`;
    for (let i = 0; i < top.length; i++) {
      const p = top[i];
      const sym = p.baseToken?.symbol || '?';
      const pr  = p.priceUsd ? `$${Number(p.priceUsd) < 0.01 ? Number(p.priceUsd).toFixed(6) : Number(p.priceUsd).toFixed(4)}` : '—';
      const ch  = p.priceChange?.h24;
      const arr = ch == null ? '' : ch >= 0 ? ` 🟢+${ch}%` : ` 🔴${ch}%`;
      const vol = p.volume?.h24 || 0;
      const icon = p.chainId === 'robinhood' ? '🟣' : '🔵';
      msg += `${icon} *${i + 1}. $${sym}* ${pr}${arr}\n`;
      msg += `   Vol $${(vol / 1000).toFixed(0)}K · Liq $${((p.liquidity?.usd || 0) / 1000).toFixed(0)}K\n`;
    }
    msg += `\n🔵 Base  🟣 Robinhood\n_${isID ? 'Ketik $TICKER untuk detail · /swap untuk trade' : 'Type $TICKER for details · /swap to trade'}_`;
    await send(chatId, msg);
  } catch (e) {
    await send(chatId, `⚠️ ${isID ? 'Gagal memuat data' : 'Failed to load data'}: ${e.message}`);
  }
}

// ── Smart Detect (auto-detect address / $TICKER) ─────────────────────────────

async function smartDetect(chatId, userId, text, lang) {
  const isID = lang === 'id';

  // 1. Bare 0x address → detect contract vs wallet
  const addrMatch = text.match(/^(0x[0-9a-fA-F]{40})$/i);
  if (addrMatch) {
    const addr = addrMatch[1].toLowerCase();
    typing(chatId);
    try {
      const code = await baseRpc('eth_getCode', [addr, 'latest']);
      const isContract = code && code !== '0x' && code.length > 4;

      if (isContract) {
        await send(chatId, isID ? `🔍 *Kontrak terdeteksi* — menganalisa token...` : `🔍 *Contract detected* — analyzing token...`);
        const gate = await aiAllowed(chatId, userId);
        if (gate.ok) {
          await cmdAnalyze(chatId, addr, lang);
        } else {
          const [token, dex] = await Promise.allSettled([getTokenInfo(addr), getDex(addr)]);
          const tok = token.status === 'fulfilled' ? token.value : null;
          const dx  = dex.status === 'fulfilled' ? dex.value : null;
          const chain = dx?.chainId === 'robinhood' ? '🟣 Robinhood' : '🔵 Base';
          let msg = `🔍 *${tok?.name || 'Unknown'} (${tok?.symbol || '?'})*\n`;
          msg += `\`${addr.slice(0,6)}...${addr.slice(-4)}\` · ${chain}\n━━━━━━━━━━━━━━━━━━━━\n`;
          if (dx) {
            const price = dx.priceUsd ? `$${dx.priceUsd < 0.01 ? dx.priceUsd.toFixed(8) : dx.priceUsd.toFixed(6)}` : '—';
            const ch24 = dx.priceChange24h;
            msg += `*${isID ? 'Harga' : 'Price'}:* ${price}\n`;
            msg += `*24h:* ${ch24 >= 0 ? '🟢' : '🔴'} ${ch24}%\n`;
            msg += `*Liq:* $${dx.liquidityUsd.toLocaleString()} | *Vol 24h:* $${dx.volume24h.toLocaleString()}\n`;
            msg += `*B/S 24h:* ${dx.buys24h}/${dx.sells24h} (${dx.buySellRatio})\n`;
            if (dx.fdv > 0) msg += `*FDV:* $${dx.fdv.toLocaleString()}\n`;
          } else {
            msg += `_${isID ? 'Belum listing di DEX manapun' : 'Not listed on any DEX'}_\n`;
          }
          msg += `\n🔒 _${isID ? 'Hold 10M $ORLIX untuk analisa AI lengkap' : 'Hold 10M $ORLIX for full AI analysis'}_`;
          await tg('sendMessage', {
            chat_id: chatId, text: msg, parse_mode: 'Markdown', disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [
              [{ text: `📈 Chart`, url: dx?.url || `https://dexscreener.com/base/${addr}` }],
              [{ text: `🔍 ${isID ? 'Analisa Lengkap' : 'Full Analysis'}`, callback_data: `analyze:${addr}` }],
            ] },
          });
        }
      } else {
        await send(chatId, isID ? `👛 *Dompet terdeteksi* — memuat info...` : `👛 *Wallet detected* — loading info...`);
        await cmdWatch(chatId, addr, lang);
      }
    } catch (e) {
      await send(chatId, `⚠️ ${e.message}`);
    }
    return true;
  }

  // 2. $TICKER (exact match, e.g. "$BRETT" or "$orlix")
  const tickerMatch = text.match(/^\$([A-Za-z]{2,12})$/);
  if (tickerMatch) {
    await cmdTickerPrice(chatId, tickerMatch[1], lang);
    return true;
  }

  return false;
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
    { command: 'swap',    description: 'Swap ORLIX ↔ ETH' },
    { command: 'top',     description: 'Top trending tokens' },
    { command: 'analyze', description: 'Deep token analysis' },
    { command: 'price',   description: 'Quick token price' },
    { command: 'watch',   description: 'Wallet activity tracker' },
    { command: 'wallet',  description: 'Your Base agent wallet' },
    { command: 'balance', description: 'Check agent wallet balance' },
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

  const update = req.body || {};

  // ── Callback queries (inline button presses) ──────────────────────────────
  const callback = update.callback_query;
  if (callback) {
    const cbChat = callback.message?.chat?.id;
    const cbUser = callback.from?.id ?? cbChat;
    const cbData = callback.data || '';
    const cbLang = detectLang(callback.message?.text || '');
    if (cbChat) {
      tg('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
      try {
        if (cbData.startsWith('analyze:')) {
          const addr = cbData.slice(8).toLowerCase();
          const gate = await aiAllowed(cbChat, cbUser);
          if (!gate.ok) { await denyAiGate(cbChat, cbLang, gate); }
          else { await send(cbChat, '🔍 Analyzing...'); await cmdAnalyze(cbChat, addr, cbLang); }
        } else if (cbData.startsWith('watch:')) {
          await cmdWatch(cbChat, cbData.slice(6).toLowerCase(), cbLang);
        } else if (cbData.startsWith('price:')) {
          await cmdPrice(cbChat, cbData.slice(6).toLowerCase());
        } else if (cbData.startsWith('ticker:')) {
          await cmdTickerPrice(cbChat, cbData.slice(7), cbLang);
        } else if (cbData === 'swap_menu') {
          await cmdSwap(cbChat, '', cbLang);
        } else if (cbData === 'top') {
          await cmdTop(cbChat, cbLang);
        }
      } catch (e) { await send(cbChat, `⚠️ ${e.message}`); }
    }
    return res.status(200).json({ ok: true });
  }

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
      : (isID ? `\n🔒 _Fitur AI: hold 10M $ORLIX di agent wallet kamu — /wallet lalu setor, cek /balance_` : `\n🔒 _AI features: hold 10M $ORLIX in your agent wallet — /wallet, deposit, then /balance_`);

    await tg('sendMessage', {
      chat_id: chatId, parse_mode: 'Markdown', disable_web_page_preview: true,
      text: `👋 ${isID ? `Selamat datang di *Orlix AI*, ${firstName}!` : `Welcome to *Orlix AI*, ${firstName}!`}\n\n` +
      (isID
        ? `Asisten AI multi-chain untuk *Base & Robinhood Chain* — analisa token, swap, market data, dan tanya apa saja.\n\n*⚡ Perintah:*\n`
        : `Multi-chain AI assistant for *Base & Robinhood Chain* — token analysis, swap, market data, and ask anything.\n\n*⚡ Commands:*\n`) +
      `/swap — ${isID ? 'Swap ORLIX ↔ ETH' : 'Swap ORLIX ↔ ETH'}\n` +
      `/top — ${isID ? 'Top token trending' : 'Top trending tokens'}\n` +
      `/analyze — ${isID ? 'Analisa keamanan token' : 'Token security analysis'}\n` +
      `/price — ${isID ? 'Harga token cepat' : 'Quick token price'}\n` +
      `/watch — ${isID ? 'Cek aktivitas dompet' : 'Wallet activity tracker'}\n` +
      `/wallet — ${isID ? 'Agent wallet kamu' : 'Your agent wallet'}\n` +
      `/help — ${isID ? 'Panduan lengkap' : 'Full command list'}\n\n` +
      `*🧠 ${isID ? 'Smart Detection' : 'Smart Detection'}:*\n` +
      (isID
        ? `• Tempel alamat 0x → otomatis deteksi kontrak/dompet\n• Ketik $TICKER → langsung lihat harga\n• Tanya apa saja → AI chat\n`
        : `• Paste 0x address → auto-detect contract/wallet\n• Type $TICKER → instant price lookup\n• Ask anything → AI chat\n`) +
      accessLine + `\n\n_Powered by Orlix AI · orlixai.xyz_`,
      reply_markup: { inline_keyboard: [
        [{ text: '🔄 Swap ORLIX', callback_data: 'swap_menu' }, { text: '🏆 Top Tokens', callback_data: 'top' }],
        [{ text: '🚀 Open Dashboard', url: 'https://orlixai.xyz/app' }],
      ] },
    });
    return res.status(200).json({ ok: true });
  }

  // ── /menu ─────────────────────────────────────────────────────────────────
  if (text === '/menu') {
    await tg('sendMessage', {
      chat_id: chatId,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      text: isID
        ? `*⚡ Menu Orlix AI*\n\n*Trading:*\n/swap — Swap ORLIX ↔ ETH\n/top — Top token trending\n/price — Harga token\n\n*Analisa:*\n/analyze — Analisa token _(10M $ORLIX)_\n/watch — Aktivitas dompet\n\n*Wallet:*\n/wallet · /balance · /export\n\n_Atau tempel alamat 0x / ketik $TICKER_`
        : `*⚡ Orlix AI Menu*\n\n*Trading:*\n/swap — Swap ORLIX ↔ ETH\n/top — Top trending tokens\n/price — Token price\n\n*Analysis:*\n/analyze — Token analysis _(10M $ORLIX)_\n/watch — Wallet activity\n\n*Wallet:*\n/wallet · /balance · /export\n\n_Or paste a 0x address / type $TICKER_`,
      reply_markup: { inline_keyboard: [
        [{ text: '🔄 Swap', callback_data: 'swap_menu' }, { text: '🏆 Top', callback_data: 'top' }],
        [{ text: '🚀 Dashboard', url: 'https://orlixai.xyz/app' },
         { text: '🪙 Buy $ORLIX', url: 'https://orlixai.xyz/token' }],
        [{ text: '🏙 Base City', url: 'https://orlixai.xyz/neural-map.html' }],
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
      ? `👛 *Agent Wallet Base kamu:*\n\`${w.address}\`\n\n💎 Setor *10,000,000 $ORLIX* ke sini untuk buka fitur AI.\n\n_Cek saldo: /balance · Ambil kendali penuh / tarik dana: /export (private key)._`
      : `👛 *Your Base agent wallet:*\n\`${w.address}\`\n\n💎 Deposit *10,000,000 $ORLIX* here to unlock AI.\n\n_Check balance: /balance · Take full control / withdraw: /export (private key)._`);
    return res.status(200).json({ ok: true });
  }

  // ── /balance ────────────────────────────────────────────────────────────────
  if (text === '/balance' || text.startsWith('/balance ')) {
    const w = agentWallet(userId);
    if (!w) {
      await send(chatId, isID ? `⚠️ Agent wallet belum dikonfigurasi.` : `⚠️ Agent wallet is not configured yet.`);
      return res.status(200).json({ ok: true });
    }
    const addr = w.address;
    const tokenArg = (text.split(/\s+/)[1] || '').toLowerCase();
    try {
      const [ethHex, orlixRaw] = await Promise.all([
        baseRpc('eth_getBalance', [addr, 'latest']),
        getOrlixBalance(addr),
      ]);
      const lines = [
        `Ξ *ETH:* ${fmtAmt(ethers.formatEther(BigInt(ethHex || '0x0')))}`,
        `🪙 *ORLIX:* ${fmtAmt(ethers.formatUnits(orlixRaw, 18))}`,
      ];
      if (tokenArg && /^0x[0-9a-f]{40}$/i.test(tokenArg)) {
        const [info, raw] = await Promise.all([getTokenInfo(tokenArg), erc20BalanceOf(tokenArg, addr)]);
        lines.push(`💠 *${info.symbol}:* ${fmtAmt(ethers.formatUnits(raw, info.decimals))}`);
      }
      await send(chatId,
        `👛 *${isID ? 'Saldo Agent Wallet' : 'Agent Wallet Balance'}*\n\`${addr}\`\n\n` +
        lines.join('\n') +
        `\n\n_${isID ? 'Read-only · spending dinonaktifkan. Cek token lain: /balance <alamat token>' : 'Read-only · spending disabled. Check another token: /balance <token address>'}_`);
    } catch (e) {
      await send(chatId, `⚠️ ${isID ? 'Gagal cek saldo' : 'Balance check failed'}: ${e.message}`);
    }
    return res.status(200).json({ ok: true });
  }

  // ── /export ── reveal the agent wallet private key (self-custody / withdraw)
  if (text === '/export') {
    const w = agentWallet(userId);
    if (!w) {
      await send(chatId, isID ? '⚠️ Agent wallet belum dikonfigurasi.' : '⚠️ Agent wallet is not configured yet.');
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID
      ? `🔑 *Private key agent wallet kamu*\n\`${w.privateKey}\`\n\nAlamat: \`${w.address}\`\n\n_Import ke wallet apa pun (MetaMask, dll) untuk kontrol penuh & tarik dana._`
      : `🔑 *Your agent wallet private key*\n\`${w.privateKey}\`\n\nAddress: \`${w.address}\`\n\n_Import into any wallet (MetaMask, etc.) for full control & withdrawals._`);
    return res.status(200).json({ ok: true });
  }

  // ── /help ─────────────────────────────────────────────────────────────────
  if (text === '/help') {
    const verified = isVerified(chatId);
    await send(chatId,
      `*Orlix AI — ${isID ? 'Panduan Lengkap' : 'Full Command Reference'}*\n\n` +
      `*🔑 ${isID ? 'Akses' : 'Access'}* ${verified ? '✅' : '🔒'}\n` +
      `${isID ? 'Setor 10M $ORLIX ke agent wallet untuk buka fitur AI' : 'Hold 10M $ORLIX in your agent wallet to unlock AI'} — /wallet\n\n` +
      `*🔄 ${isID ? 'Trading' : 'Trading'}*\n` +
      `/swap — ${isID ? 'Swap ORLIX ↔ ETH (estimasi + link DEX)' : 'Swap ORLIX ↔ ETH (quote + DEX links)'}\n` +
      `/top — ${isID ? 'Top token Base & Robinhood Chain' : 'Top tokens Base & Robinhood Chain'}\n\n` +
      `*📊 ${isID ? 'Data Onchain (Gratis)' : 'Onchain Data (Free)'}*\n` +
      `/price — ${isID ? 'Harga token instan' : 'Instant token price'}\n` +
      `/watch — ${isID ? 'Saldo & transaksi wallet' : 'Wallet balance & transactions'}\n\n` +
      `*🤖 ${isID ? 'Fitur AI (Perlu 10M $ORLIX)' : 'AI Features (Need 10M $ORLIX)'}*\n` +
      `/analyze — ${isID ? 'Analisa risiko token mendalam' : 'Deep token risk analysis'}\n` +
      `${isID ? 'Chat bebas' : 'Free chat'} — ${isID ? 'Tanya apa saja' : 'Ask anything'}\n` +
      `${isID ? 'Kirim gambar' : 'Send image'} — ${isID ? 'Analisa visual AI' : 'AI visual analysis'}\n\n` +
      `*🧠 Smart Detection*\n` +
      (isID
        ? `• Tempel alamat \`0x...\` → otomatis deteksi kontrak atau dompet\n• Ketik \`$BRETT\` → langsung lihat harga\n\n`
        : `• Paste \`0x...\` address → auto-detect contract or wallet\n• Type \`$BRETT\` → instant price lookup\n\n`) +
      `*🌐 ${isID ? 'Lainnya' : 'Other'}*\n` +
      `/menu — ${isID ? 'Menu aksi cepat' : 'Quick actions menu'}\n` +
      `/wallet — ${isID ? 'Agent wallet kamu' : 'Your agent wallet'}\n` +
      `/balance · /export · /web\n\n` +
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
      await send(chatId, isID ? `⚠️ Contoh: /price <alamat token>` : `⚠️ Usage: /price <token address>`);
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
      await send(chatId, isID ? `⚠️ Contoh: /watch <alamat dompet>` : `⚠️ Usage: /watch <wallet address>`);
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID ? `👁 Memeriksa dompet...` : `👁 Looking up wallet...`);
    try { await cmdWatch(chatId, addr, lang); }
    catch (e) { await send(chatId, `⚠️ ${isID ? 'Gagal' : 'Failed'}: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /analyze (gated) ──────────────────────────────────────────────────────
  if (text.startsWith('/analyze')) {
    { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }
    const addr = (text.split(/\s+/)[1] || '').toLowerCase();
    if (!addr || !/^0x[0-9a-f]{40}$/i.test(addr)) {
      await send(chatId, isID ? `⚠️ Contoh: /analyze <alamat token>` : `⚠️ Usage: /analyze <token address>`);
      return res.status(200).json({ ok: true });
    }
    await send(chatId, isID ? `🔍 Menganalisa token...` : `🔍 Analyzing token...`);
    try { await cmdAnalyze(chatId, addr, lang); }
    catch (e) { await send(chatId, `⚠️ ${isID ? 'Analisa gagal' : 'Analysis failed'}: ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /swap (free) ───────────────────────────────────────────────────────────
  if (text.startsWith('/swap')) {
    const args = text.slice(5).trim();
    try { await cmdSwap(chatId, args, lang); }
    catch (e) { await send(chatId, `⚠️ ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── /top (free) ───────────────────────────────────────────────────────────
  if (text === '/top') {
    try { await cmdTop(chatId, lang); }
    catch (e) { await send(chatId, `⚠️ ${e.message}`); }
    return res.status(200).json({ ok: true });
  }

  // ── Photo / vision (gated) ────────────────────────────────────────────────
  if (message.photo) {
    { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }
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
          system: `You are Orlix AI. ${isID ? 'Balas dalam Bahasa Indonesia.' : 'Reply in English.'} ONLY use Telegram markdown: *bold*, _italic_, \`code\`. NEVER use ## headers, ---, > blockquotes. Use *bold text* for section titles. Be detailed and thorough.`,
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

  // ── Smart detection: bare address or $TICKER ──────────────────────────────
  if (!text) return res.status(200).json({ ok: true });

  try {
    const handled = await smartDetect(chatId, userId, text, lang);
    if (handled) return res.status(200).json({ ok: true });
  } catch { /* fall through to AI chat */ }

  // ── Free text → AI chat (gated) ───────────────────────────────────────────
  { const g = await aiAllowed(chatId, userId); if (!g.ok) { await denyAiGate(chatId, lang, g); return res.status(200).json({ ok: true }); } }

  try { await cmdChat(chatId, text, lang); }
  catch (e) { await send(chatId, `⚠️ Error: ${e.message}`); }

  return res.status(200).json({ ok: true });
};
