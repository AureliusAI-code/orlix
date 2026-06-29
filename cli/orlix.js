#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────
//  ORLIX CLI — Base Chain Intelligence
//  Zero external dependencies. Pure Node.js.
//  Usage: node orlix.js <command> [args] [--flags]
// ─────────────────────────────────────────────────────────────

const https = require('https');
const readline = require('readline');

const API = 'https://orlix.xyz/api';

// ── ANSI palette ───────────────────────────────────────────────
const tc = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;  // true color

const A = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  // orange brand palette
  o1:      tc(255, 214,  60),  // yellow-gold  (top)
  o2:      tc(255, 178,   0),  // amber
  o3:      tc(255, 140,   0),  // orange       (mid)
  o4:      tc(255,  98,   0),  // deep orange
  o5:      tc(220,  70,   0),  // burnt orange (bottom)
  // UI colors
  green:   '\x1b[92m',
  red:     '\x1b[91m',
  yellow:  '\x1b[93m',
  magenta: '\x1b[95m',
  gray:    '\x1b[90m',
  white:   '\x1b[97m',
  cyan:    '\x1b[96m',
};

// short helpers
const or = s => `${A.o3}${A.bold}${s}${A.reset}`;   // orange (primary brand)
const b  = s => `${A.bold}${s}${A.reset}`;
const cy = s => `${A.o2}${s}${A.reset}`;             // cyan → amber for values
const gr = s => `${A.green}${s}${A.reset}`;
const re = s => `${A.red}${s}${A.reset}`;
const ye = s => `${A.yellow}${s}${A.reset}`;
const mg = s => `${A.magenta}${s}${A.reset}`;
const dm = s => `${A.dim}${A.gray}${s}${A.reset}`;
const wh = s => `${A.white}${A.bold}${s}${A.reset}`;
// keep bl as alias for or (used throughout for prompt colors)
const bl = or;

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// ── Banner ─────────────────────────────────────────────────────
function banner() {
  process.stdout.write('\n');
  // 6-row gradient: yellow-gold → amber → orange → deep orange → burnt
  const rows = [A.o1, A.o1, A.o2, A.o3, A.o4, A.o5];
  const art = [
    ' ██████╗ ██████╗ ██╗     ██╗██╗  ██╗',
    '██╔═══██╗██╔══██╗██║     ██║╚██╗██╔╝',
    '██║   ██║██████╔╝██║     ██║ ╚███╔╝ ',
    '██║   ██║██╔══██╗██║     ██║ ██╔██╗ ',
    '╚██████╔╝██║  ██║███████╗██║██╔╝ ██╗',
    ' ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝',
  ];
  art.forEach((l, i) => console.log(`  ${rows[i]}${A.bold}${l}${A.reset}`));
  console.log(`  ${dm('─'.repeat(38))}`);
  console.log(`  ${dm('Base Chain Intelligence')}  ${A.o3}●${A.reset}  ${dm('orlix.xyz')}`);
  console.log();
}

// ── Spinner ────────────────────────────────────────────────────
const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let _spinTimer = null;
let _spinIdx   = 0;

function spin(msg) {
  if (!process.stdout.isTTY) return;
  _spinIdx = 0;
  process.stdout.write('\x1b[?25l');
  _spinTimer = setInterval(() => {
    const f = FRAMES[_spinIdx++ % FRAMES.length];
    process.stdout.write(`\r  ${A.o3}${f}${A.reset}  ${A.gray}${msg}${A.reset}   `);
  }, 80);
}

function unspin(msg) {
  if (_spinTimer) {
    clearInterval(_spinTimer);
    _spinTimer = null;
    process.stdout.write('\r\x1b[K');
    process.stdout.write('\x1b[?25h');
  }
  if (msg) console.log('  ' + msg);
}

// ── HTTP helpers ───────────────────────────────────────────────
function fetch(endpoint, params, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const qs = params && Object.keys(params).length
      ? '?' + new URLSearchParams(params).toString()
      : '';
    const parsed = new URL(`${API}${endpoint}${qs}`);
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method,
      headers:  {
        'User-Agent':   'orlix-cli/1.0',
        'Accept':       'application/json',
        ...(payload ? {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
      timeout: 20000,
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          reject(new Error(`Non-JSON response (HTTP ${res.statusCode})`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 20s')); });
    req.on('error', e => reject(new Error(`Network error: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// SSE-streaming POST for /api/chat
function streamChat(body, onText) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(`${API}/chat`);

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'orlix-cli/1.0',
        'Accept':         'text/event-stream, application/json',
      },
      timeout: 60000,
    };

    const req = https.request(options, res => {
      let buf = '';
      let full = '';

      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') continue;
          try {
            const ev = JSON.parse(raw);
            // Anthropic SSE
            const txt = ev.delta?.text ||
              // OpenAI-compat SSE
              ev.choices?.[0]?.delta?.content ||
              // plain content
              ev.content?.[0]?.text || '';
            if (txt) { full += txt; onText(txt); }
          } catch { /* skip malformed chunk */ }
        }
      });

      res.on('end', () => {
        // If nothing came through SSE, try parsing the buffer as JSON
        if (!full && buf.trim()) {
          try {
            const d = JSON.parse(buf);
            const txt = d.response || d.message || d.content ||
              d.choices?.[0]?.message?.content || '';
            full = txt;
          } catch { /* ignore */ }
        }
        resolve(full);
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Chat request timed out')); });
    req.on('error', e => reject(new Error(`Network error: ${e.message}`)));
    req.write(payload);
    req.end();
  });
}

// ── Layout helpers ─────────────────────────────────────────────
function row(label, value, pad = 18) {
  return `  ${dm(label.padEnd(pad))} ${value}`;
}

function divider(n = 46) {
  return `  ${dm('─'.repeat(n))}`;
}

function fmtPrice(usd) {
  if (!usd) return dm('N/A');
  const n = Number(usd);
  if (n >= 1)    return cy(`$${n.toFixed(4)}`);
  if (n >= 0.01) return cy(`$${n.toFixed(6)}`);
  const zeros = Math.max(0, -Math.floor(Math.log10(n)));
  return cy(`$${n.toFixed(Math.min(zeros + 3, 12))}`);
}

function fmtChange(pct) {
  if (pct == null || isNaN(Number(pct))) return dm('N/A');
  const n = Number(pct);
  const s = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  return n >= 0 ? gr(s) : re(s);
}

function fmtUsd(n) {
  if (!n || n === 0) return dm('N/A');
  const v = Number(n);
  if (v >= 1e9) return cy(`$${(v/1e9).toFixed(2)}B`);
  if (v >= 1e6) return cy(`$${(v/1e6).toFixed(2)}M`);
  if (v >= 1e3) return cy(`$${(v/1e3).toFixed(1)}K`);
  return cy(`$${v.toFixed(2)}`);
}

function buyBar(buys, sells) {
  const total = buys + sells;
  if (!total) return dm('no txns');
  const pct = Math.round(buys / total * 100);
  const filled = Math.round(pct / 5);
  const bar = gr('█'.repeat(filled)) + re('░'.repeat(20 - filled));
  return `${bar} ${gr(String(buys) + ' buys')} ${dm('/')} ${re(String(sells) + ' sells')}`;
}

// Strip markdown bold/italic, render section headers nicely
function renderMarkdown(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const stripped = line
      .replace(/\*\*(.+?)\*\*/g, (_, m) => b(m))
      .replace(/\*(.+?)\*/g, (_, m) => wh(m))
      .replace(/^#{1,3}\s*/, '')
      .replace(/^(📊|💧|📈|🔄|🚩|✅|⚖️)/, s => `\n  ${s}`);
    out.push('  ' + stripped);
  }
  return out.join('\n');
}

// ── COMMANDS ───────────────────────────────────────────────────

// ping
async function cmdPing() {
  banner();
  spin('Checking Orlix API...');
  try {
    const t0 = Date.now();
    const { data } = await fetch('/ping');
    const ms = Date.now() - t0;
    unspin();
    if (data.ok || data.status === 'ok') {
      console.log(`  ${gr('●')} ${b('API Online')}  ${dm(ms + 'ms')}`);
    } else {
      console.log(`  ${ye('●')} API responded but returned unexpected status`);
    }
  } catch (e) {
    unspin();
    console.log(`  ${re('●')} ${re('Offline')}  ${dm(e.message)}`);
    process.exit(1);
  }
  console.log();
}

// analyze <0x... or $TICKER>
async function cmdAnalyze(token, opts) {
  banner();
  if (!token) {
    console.log(`  ${re('✗')} Specify a contract address or ticker\n`);
    console.log(`  ${dm('Example:')} ${bl('orlix analyze')} ${ye('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA0291')}`);
    console.log(`  ${dm('Example:')} ${bl('orlix analyze')} ${ye('$ORLIX')}\n`);
    process.exit(1);
  }

  const isCA = /^0x[0-9a-fA-F]{40}$/i.test(token.trim());

  let address = isCA ? token.trim() : null;

  // Resolve ticker → address via token-search
  if (!address) {
    const query = token.replace(/^\$/, '');
    spin(`Resolving ${ye('$' + query.toUpperCase())}...`);
    try {
      const { data } = await fetch('/token-search', { q: query });
      unspin();
      const tokens = data.tokens || [];
      if (!tokens.length) {
        console.log(`  ${re('✗')} No token found for "${query}" on Base\n`);
        process.exit(1);
      }
      const match = tokens.find(t => t.symbol?.toUpperCase() === query.toUpperCase()) || tokens[0];
      address = match.address;
    } catch (e) {
      unspin();
      console.log(`  ${re('✗')} ${e.message}\n`);
      process.exit(1);
    }
  }

  spin(`Analyzing ${cy(address.slice(0, 8) + '...' + address.slice(-6))}...`);
  try {
    const { data } = await fetch('/analyze', { address });
    unspin();

    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    if (data.error) { console.log(`  ${re('✗')} ${data.error}\n`); process.exit(1); }

    const t  = data.tokenInfo  || {};
    const dx = data.dexInfo    || {};
    const ai = data.analysis   || '';

    // Header
    console.log(`  ${wh(t.name || 'Unknown Token')}  ${ye('$' + (t.symbol || '?'))}  ${dm('on Base')}`);
    console.log(divider());

    // Price block
    console.log(row('Price',     `${fmtPrice(dx.priceUsd)}  ${fmtChange(dx.priceChange24h)}  ${dm('24h')}`));
    console.log(row('',          `${fmtChange(dx.priceChange1h)} ${dm('1h')}  ${fmtChange(dx.priceChange6h)} ${dm('6h')}`));
    console.log(row('Market Cap', fmtUsd(dx.marketCap || dx.fdv)));
    console.log(row('Liquidity',  fmtUsd(dx.liquidityUsd)));

    // Volume block
    console.log(divider());
    console.log(row('Volume 1h',  fmtUsd(dx.volume1h)));
    console.log(row('Volume 6h',  fmtUsd(dx.volume6h)));
    console.log(row('Volume 24h', fmtUsd(dx.volume24h)));

    // Buy/sell
    const buys  = dx.buys24h  || 0;
    const sells = dx.sells24h || 0;
    if (buys + sells > 0) {
      console.log(divider());
      console.log(`  ${buyBar(buys, sells)}`);
    }

    // Contract
    console.log(divider());
    console.log(row('Contract', dm(address)));
    console.log(row('Total Supply', dm(t.totalSupply || 'N/A')));
    if (dx.pairUrl) console.log(row('DexScreener', dm(dx.pairUrl)));

    // AI analysis
    if (ai) {
      console.log(divider());
      console.log(`\n${renderMarkdown(ai)}`);
    }

    console.log();
    console.log(divider());
    console.log(`  ${dm('Data: DexScreener + Base RPC + Orlix AI  ·  ' + new Date(data.timestamp || Date.now()).toLocaleTimeString())}`);

  } catch (e) {
    unspin();
    console.log(`  ${re('✗')} ${e.message}\n`);
    process.exit(1);
  }
  console.log();
}

// search <query>
async function cmdSearch(query, opts) {
  banner();
  if (!query) {
    console.log(`  ${re('✗')} Specify a search query\n`);
    console.log(`  ${dm('Example:')} ${bl('orlix search')} ${ye('aerodrome')}\n`);
    process.exit(1);
  }

  // Try token-search first, fall back to web search
  spin(`Searching tokens for "${query}"...`);
  try {
    const { data } = await fetch('/token-search', { q: query });
    unspin();

    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }

    const tokens = data.tokens || [];
    if (tokens.length) {
      console.log(`  ${gr('✓')} ${b(String(tokens.length))} ${dm('token' + (tokens.length !== 1 ? 's' : '') + ' on Base matching')} ${cy(query)}\n`);

      tokens.slice(0, 10).forEach((t, i) => {
        const num  = dm(String(i + 1).padStart(2) + '.');
        const name = b(t.name || 'Unknown');
        const sym  = ye('$' + (t.symbol || '?'));
        const price = fmtPrice(t.priceUsd);
        const chg   = fmtChange(t.priceChange24h);
        const liq   = fmtUsd(t.liquidity);
        const addr  = dm(t.address ? t.address.slice(0, 8) + '...' + t.address.slice(-6) : '');
        console.log(`  ${num} ${name} ${sym}  ${price}  ${chg}  ${dm('liq')} ${liq}`);
        console.log(`     ${addr}  ${dm(t.dexId || '')}`);
        console.log();
      });

      console.log(divider());
      console.log(`  ${dm('Run: orlix analyze $SYMBOL  for full AI analysis')}`);
      console.log();
      return;
    }

    // No tokens found — fall back to web search
    console.log(`  ${dm('No tokens found — searching web...')}`);
    spin(`Web search for "${query}"...`);
    const ws = await fetch('/search', { q: query + ' Base crypto token' });
    unspin();

    const results = ws.data.results || [];
    if (!results.length) {
      console.log(`  ${ye('○')} No results found\n`);
      return;
    }

    console.log(`\n  ${wh('Web Results')}  ${dm(query)}\n`);
    results.forEach((r, i) => {
      console.log(`  ${dm(String(i + 1) + '.')} ${b(r.title)}`);
      if (r.description) console.log(`     ${dm(r.description.slice(0, 80) + (r.description.length > 80 ? '...' : ''))}`);
      console.log(`     ${cy(r.url)}\n`);
    });
    console.log(divider());

  } catch (e) {
    unspin();
    console.log(`  ${re('✗')} ${e.message}\n`);
    process.exit(1);
  }
}

// b20 [tokens] [--network mainnet|sepolia|vibenet]
async function cmdB20(sub, opts) {
  banner();

  if (sub === 'tokens') {
    const network = opts.network || 'mainnet';
    const netLabel = network === 'vibenet' ? mg('Vibenet') : network === 'sepolia' ? ye('Sepolia') : bl('Mainnet');
    spin(`Fetching B20 tokens on ${network}...`);
    try {
      const { data } = await fetch('/b20-tokens', { network });
      unspin();

      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }

      console.log(`  ${b('B20 Tokens')}  ${netLabel}\n`);

      const tokens = data.tokens || [];
      if (!tokens.length) {
        const msg = data.message || 'No B20 tokens deployed yet';
        console.log(`  ${ye('○')} ${dm(msg)}\n`);
        if (data.testnets) {
          data.testnets.forEach(n => {
            console.log(`  ${bl('●')} ${b(n.name)}  ${dm(n.explorer || '')}`);
          });
          console.log();
        }
      } else {
        tokens.forEach((t, i) => {
          const num     = dm(String(i + 1).padStart(2) + '.');
          const name    = b(t.name || 'Unknown');
          const sym     = ye('$' + (t.symbol || '?'));
          const variant = t.variant === 'stablecoin' ? cy('stablecoin') : dm('asset');
          const addr    = dm(t.address ? t.address.slice(0, 10) + '...' : '');
          const supply  = t.supply ? dm('supply ' + Number(t.supply).toLocaleString()) : '';
          console.log(`  ${num} ${name} ${sym}  ${variant}  ${supply}`);
          if (addr) console.log(`     ${addr}`);
          console.log();
        });
      }

      console.log(divider());
      console.log(`  ${dm('orlix b20 tokens --network sepolia|vibenet')}`);

    } catch (e) {
      unspin();
      console.log(`  ${re('✗')} ${e.message}\n`);
      process.exit(1);
    }

  } else {
    // b20 info
    spin('Loading B20 standard info...');
    try {
      const { data } = await fetch('/b20', { action: 'info' });
      unspin();

      if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }

      console.log(`  ${bl('B20')} ${b('Token Standard')}  ${dm('Beryl Upgrade · Base')}`);
      console.log(divider());

      const mainnet = data.mainnetLive;
      console.log(row('Mainnet', mainnet ? gr('● Active') : ye('⏳ Pending activation')));
      if (data.mainnetNote) console.log(`  ${dm('  ' + data.mainnetNote)}`);
      console.log();

      if (data.testnets?.length) {
        console.log(`  ${wh('Live Testnets')}`);
        data.testnets.forEach(n => {
          const label = n.chainId === 84538453 ? mg(n.name) : ye(n.name);
          console.log(`  ${bl('●')} ${b(n.name)}  ${dm('Chain ID ' + n.chainId)}`);
          if (n.rpc)    console.log(row('  RPC',    dm(n.rpc)));
          if (n.faucet) console.log(row('  Faucet', cy(n.faucet)));
          console.log();
        });
      }

      if (data.variants?.length) {
        console.log(`  ${wh('Variants')}`);
        data.variants.forEach(v => {
          console.log(`  ${bl('▸')} ${b(v.name)}  ${dm(v.description)}`);
          if (v.useCases?.length) {
            v.useCases.forEach(u => console.log(`    ${dm('·')} ${A.gray}${u}${A.reset}`));
          }
          console.log();
        });
      }

      if (data.features?.length) {
        console.log(`  ${wh('Features')}`);
        data.features.forEach(f => console.log(`  ${gr('✓')} ${dm(f)}`));
        console.log();
      }

      if (data.comingSoon?.length) {
        console.log(`  ${wh('Coming Soon')}`);
        data.comingSoon.forEach(f => console.log(`  ${ye('◌')} ${dm(f)}`));
        console.log();
      }

      if (data.docs) {
        console.log(divider());
        console.log(`  ${dm('Docs: ')}${cy(data.docs)}`);
      }

    } catch (e) {
      unspin();
      console.log(`  ${re('✗')} ${e.message}\n`);
      process.exit(1);
    }
  }
  console.log();
}

// chat "<message>"
async function cmdChat(message, opts) {
  banner();
  if (!message) {
    console.log(`  ${re('✗')} Specify a message\n`);
    console.log(`  ${dm('Example:')} ${bl('orlix chat')} ${ye('"What is B20?"')}\n`);
    process.exit(1);
  }

  console.log(`  ${dm('You')} ${A.o3}›${A.reset} ${wh(message)}\n`);

  if (opts.json) {
    spin('Waiting for response...');
    try {
      const { data } = await fetch('/chat', null, 'POST', {
        messages: [{ role: 'user', content: message }],
        model: 'claude-haiku-4-5-20251001',
      });
      unspin();
      console.log(JSON.stringify(data, null, 2));
    } catch (e) {
      unspin();
      console.log(`  ${re('✗')} ${e.message}\n`);
      process.exit(1);
    }
    return;
  }

  process.stdout.write(`  ${bl('Orlix')} ${A.o3}›${A.reset} `);

  let printed = false;
  let dotTimer = null;

  // Show thinking dots while waiting for first token
  const dots = ['   ', '.  ', '.. ', '...'];
  let di = 0;
  dotTimer = setInterval(() => {
    process.stdout.write(`\r  ${bl('Orlix')} ${A.o3}›${A.reset} ${A.gray}${dots[di++ % dots.length]}${A.reset}`);
  }, 300);

  try {
    const reply = await streamChat(
      { messages: [{ role: 'user', content: message }], model: 'claude-haiku-4-5-20251001' },
      text => {
        if (!printed) {
          clearInterval(dotTimer);
          process.stdout.write(`\r  ${bl('Orlix')} ${A.o3}›${A.reset} `);
          printed = true;
        }
        process.stdout.write(A.white + text + A.reset);
      }
    );

    clearInterval(dotTimer);

    // If streaming gave nothing, print the full reply
    if (!printed && reply) {
      process.stdout.write(`\r  ${bl('Orlix')} ${A.o3}›${A.reset} ${A.white}${reply}${A.reset}`);
    }

    process.stdout.write('\n\n');
    console.log(divider());
    console.log(`  ${dm('Powered by Claude · orlix.xyz/app')}`);

  } catch (e) {
    clearInterval(dotTimer);
    process.stdout.write('\n');
    console.log(`  ${re('✗')} ${e.message}\n`);
    process.exit(1);
  }
  console.log();
}

// help
function cmdHelp() {
  banner();
  console.log(`  ${wh('USAGE')}`);
  console.log(`  ${bl('orlix')} ${dm('<command> [args] [--flags]')}\n`);

  const cmds = [
    ['ping',                     'Check API status and latency'],
    ['analyze <0x... | $TICK>',  'Full token analysis — price, volume, AI verdict'],
    ['search <query>',           'Search tokens on Base or web'],
    ['b20',                      'B20 token standard info'],
    ['b20 tokens',               'Recently deployed B20 tokens'],
    ['chat "<message>"',         'Chat with Orlix AI (streams live)'],
    ['help',                     'Show this help'],
  ];

  console.log(`  ${wh('COMMANDS')}`);
  cmds.forEach(([cmd, desc]) => {
    console.log(`  ${bl(cmd.padEnd(30))} ${dm(desc)}`);
  });

  console.log(`\n  ${wh('FLAGS')}`);
  console.log(`  ${cy('--json'.padEnd(30))} ${dm('Output raw JSON')}`);
  console.log(`  ${cy('--network <net>'.padEnd(30))} ${dm('mainnet | sepolia | vibenet  (default: mainnet)')}`);

  console.log(`\n  ${wh('EXAMPLES')}`);
  const ex = [
    `analyze 0x4200000000000000000000000000000000000B20`,
    `analyze \\$ORLIX`,
    `search aerodrome`,
    `b20 tokens --network sepolia`,
    `b20 tokens --network vibenet`,
    `chat "what is the B20 token standard?"`,
    `ping`,
  ];
  ex.forEach(e => {
    console.log(`  ${dm('$')} ${bl('orlix')} ${A.gray}${e}${A.reset}`);
  });

  console.log(`\n  ${dm('─'.repeat(46))}`);
  console.log(`  ${dm('orlix.xyz  ·  Base Chain Intelligence  ·  v1.0.0')}`);
  console.log();
}

// ── Arg parser ─────────────────────────────────────────────────
function parseArgs(argv) {
  const flags   = argv.filter(a => a.startsWith('--'));
  const positional = [];
  let skipNext = false;

  for (let i = 0; i < argv.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    if (argv[i] === '--network' || argv[i] === '-n') { skipNext = true; continue; }
    if (argv[i].startsWith('--')) continue;
    positional.push(argv[i]);
  }

  const networkFlag = flags.find(f => f.startsWith('--network='));
  const networkIdx  = argv.indexOf('--network');

  const opts = {
    json:    flags.includes('--json'),
    network: networkFlag
      ? networkFlag.split('=')[1]
      : (networkIdx !== -1 ? argv[networkIdx + 1] : 'mainnet'),
  };

  return { positional, opts };
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;

  try {
    switch ((cmd || '').toLowerCase()) {
      case 'ping':
        await cmdPing();
        break;

      case 'analyze':
      case 'analyse':
        await cmdAnalyze(rest.join(' ').trim() || '', opts);
        break;

      case 'search':
        await cmdSearch(rest.join(' ').trim(), opts);
        break;

      case 'b20':
        await cmdB20(rest[0], opts);
        break;

      case 'chat':
        await cmdChat(rest.join(' ').trim(), opts);
        break;

      case 'help':
      case '--help':
      case '-h':
        cmdHelp();
        break;

      case '':
      case undefined:
        cmdHelp();
        break;

      default:
        banner();
        console.log(`  ${re('✗')} Unknown command: ${re(cmd)}`);
        console.log(`  ${dm('Run')} ${bl('orlix help')} ${dm('to see all commands')}\n`);
        process.exit(1);
    }
  } catch (e) {
    unspin();
    console.error(`\n  ${re('✗')} Unexpected error: ${e.message}\n`);
    process.exit(1);
  }
}

main();
