# Orlix — Base Chain Intelligence Platform

Orlix is an open-source AI-powered analytics and token deployment platform built on Base. It provides real-time on-chain data, token launch tools, and an autonomous X (Twitter) agent — all running on Base's infrastructure.

**Live:** [orlix.xyz](https://orlix.xyz)

---

## What's Inside

### Pages

| Page | URL | Description |
|------|-----|-------------|
| Dashboard | `/` | Real-time Base ecosystem overview — TVL, bridge flows, DEX volume, active addresses |
| Base City | `/neural-map` | 3D visualization of Base blockchain activity. 15×15 grid of buildings representing live on-chain data |
| B20 Studio | `/b20-studio` | Deploy B20 tokens on Base. Supports Sepolia testnet, Vibenet devnet, and mainnet (pending Beryl upgrade) |
| App | `/app` | Token analytics, wallet tracking, market overview |
| API Docs | `/api-docs` | Full documentation for all public API endpoints |
| Changelog | `/changelog` | Platform updates and version history |

---

### API Endpoints

All endpoints are deployed as Vercel serverless functions under `/api/`.

#### Analytics
- **`/api/analyze`** — Token analysis: price, market cap, liquidity, buy/sell pressure, holder data via DexScreener + Basescan
- **`/api/search`** — Token search across Base ecosystem
- **`/api/token-search`** — Enhanced token lookup with metadata
- **`/api/bankr-tokens`** — Token list from Bankr ecosystem

#### B20 Token Standard
- **`/api/b20`** — B20 standard info, features, testnet details (`?action=info` or `?action=tokens`)
- **`/api/b20-tokens`** — Recently deployed B20 tokens (`?network=mainnet|sepolia|vibenet`)
- **`/api/b20-skill`** — Full B20 deployment API: prepare transaction, estimate gas, track deployment (`?action=prepare|estimate|track`)
- **`/api/b20-ai`** — AI-assisted B20 token configuration

#### AI & Chat
- **`/api/chat`** — Orlix AI chat powered by Claude. Context-aware Base ecosystem assistant
- **`/api/x-agent`** — Autonomous X (Twitter) reply agent. Scans mentions, generates in-character replies using DexScreener live data

#### Content
- **`/api/gallery`** — NFT/media gallery
- **`/api/music`** / **`/api/song`** — AI-generated music
- **`/api/ping`** — Health check

#### x402 (Paid APIs)
- **`/api/x402-analyze`** — Premium token analysis (pay-per-use via x402 protocol)
- **`/api/x402-chat`** — Premium AI chat
- **`/api/x402-market`** — Premium market data
- **`/api/x402-wallet`** — Premium wallet analytics
- **`/api/x402-b20`** — Premium B20 deployment
- **`/api/x402-song`** — Premium music generation

---

### B20 Token Standard

Orlix is built around the **B20 token standard** — Base's native token upgrade introduced in the Beryl hard fork.

B20 is ERC-20 compatible with additional features:
- **Role-based access control** — mint, burn, pause, metadata roles
- **ERC-2612 permits** — approve without separate transaction
- **Supply caps** — optional maximum supply enforcement
- **Transfer policies** — granular sender/receiver/executor control
- **Freeze & seize** — compliance tooling
- **Transfer memos** — payment IDs and tags

**Two variants:**
- `Asset` — General-purpose. Configurable decimals, rebasing support
- `Stablecoin` — Fixed 6 decimals, currency code field

**Network status:**
- Base Sepolia (84532) ✅ Active
- Vibenet (84538453) ✅ Active
- Base Mainnet (8453) ⏳ Pending (Beryl activation delayed by Base)

---

### X Agent (`/api/x-agent`)

Autonomous Twitter/X reply agent for the `@OrlixAI` account.

**How it works:**
- Runs on cron (every 2 minutes via cron-job.org)
- Scans mentions via X API v2
- Detects token tickers (`$TOKEN`) or contract addresses in mentions
- Fetches live data from DexScreener for any mentioned token
- Generates in-character replies using Claude Haiku
- For token analysis: 3-4 paragraph response with price, volume, liquidity, honest take
- Safety guardrails: never replies unprompted, bot blocklist, duplicate prevention via Redis

**Personas:** Developer, Trader, Marketer, Default — auto-detected from mention content

---

### Base City (`/neural-map`)

3D visualization of Base blockchain activity built with Three.js.

- 15×15 grid, each cell represents a block/activity zone
- Buildings generated from live TVL and transaction data
- Dark glass tint with emissive window glow
- Bloom post-processing (desktop only)
- Realtime bridge flow and DEX volume overlays

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla HTML/CSS/JS, Three.js (r128) |
| Backend | Node.js serverless (Vercel) |
| AI | Claude Haiku / Sonnet (Anthropic) |
| Blockchain | Base (viem, ethers.js) |
| Data | DexScreener API, Basescan API, Base RPC |
| State | Upstash Redis (mention dedup, cron locks) |
| Payments | x402 protocol (pay-per-use API access) |
| Social | X API v2 (OAuth 1.0a) |
| Deployment | Vercel (auto-deploy from main) |

---

## Environment Variables

```env
# X (Twitter) Agent
X_API_KEY=
X_API_KEY_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
X_BEARER_TOKEN=
X_BOT_USERNAME=OrlixAI
X_CRON_SECRET=

# AI
ANTHROPIC_API_KEY=
BANKR_LLM_KEY=

# Blockchain
BASESCAN_API_KEY=

# State
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

---

## Deploying Your Own

```bash
git clone https://github.com/tylerbroqs/orlixai
cd orlixai
npm install
vercel deploy
```

Set environment variables in Vercel dashboard, then add a cron job pointing to `/api/x-agent` every 2 minutes with your `X_CRON_SECRET` in the header.

---

## License

MIT — fork it, build on it, deploy your own.

---

Built on [Base](https://base.org) · Powered by [Anthropic](https://anthropic.com) · [orlix.xyz](https://orlix.xyz)
