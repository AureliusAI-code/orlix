# Orlix — CLAUDE.md

## Project Overview
Orlix is an AI-powered analytics and token deployment platform built on Base. Live at orlix.xyz.

## Repository Structure
```
/
├── api/                    # Vercel serverless functions
│   ├── x-agent.js          # Autonomous X/Twitter reply bot
│   ├── b20-skill.js        # B20 token deployment API
│   ├── b20-tokens.js       # Recently deployed B20 tokens
│   ├── b20.js              # B20 standard info
│   ├── b20-ai.js           # AI-assisted B20 config
│   ├── analyze.js          # Token analysis (DexScreener + Basescan)
│   ├── chat.js             # AI chat (Claude)
│   ├── search.js           # Token search
│   ├── token-search.js     # Enhanced token lookup
│   ├── bankr-tokens.js     # Bankr ecosystem tokens
│   ├── gallery.js          # NFT/media gallery
│   ├── music.js / song.js  # AI music generation
│   ├── ping.js             # Health check
│   ├── auth.js             # Authentication
│   ├── telegram.js         # Telegram integration
│   ├── x402.js             # x402 payment protocol
│   ├── x402-analyze.js     # Premium token analysis
│   ├── x402-chat.js        # Premium AI chat
│   ├── x402-market.js      # Premium market data
│   ├── x402-wallet.js      # Premium wallet analytics
│   ├── x402-b20.js         # Premium B20 deployment
│   └── x402-song.js        # Premium music generation
│
├── *.html                  # Frontend pages (vanilla HTML/CSS/JS)
│   ├── index.html          # Dashboard — Base ecosystem overview
│   ├── neural-map.html     # Base City 3D visualization (Three.js)
│   ├── b20-studio.html     # B20 token deployment UI
│   ├── app.html            # Token analytics app
│   ├── api-docs.html       # API documentation
│   ├── docs.html           # Platform docs
│   ├── changelog.html      # Version history
│   ├── token.html          # Token detail page
│   └── agentic-flow.html   # Agentic flow visualization
│
├── .claude/
│   └── skills/
│       └── bankr-twitter-agent/  # Twitter agent skill
│
├── .github/
│   └── workflows/
│       └── sync-opensource.yml   # Auto-sync to tylerbroqs/orlixai
│
├── vercel.json             # Vercel routing + function config
└── package.json
```

## Key Technical Details

### B20 Token Standard
- Precompile address: `0x4200000000000000000000000000000000000B20`
- Networks: Base Mainnet (8453, pending), Sepolia (84532), Vibenet (84538453)
- Chain ID hex: mainnet `0x2105`, sepolia `0x14a34`, vibenet `0x509F455`
- RPC: mainnet `https://mainnet.base.org`, sepolia `https://sepolia.base.org`, vibenet `https://rpc.vibes.base.org`

### X Agent (`/api/x-agent.js`)
- Runs on cron every 2 minutes via cron-job.org (POST with `X_CRON_SECRET` header)
- Uses Bearer token for reading mentions, OAuth 1.0a for posting
- Token detection: `$TICKER` or `0x...` contract address in mention text
- Live data from DexScreener API
- Persona detection: developer / trader / marketer / default
- Redis (Upstash) for `since_id` tracking and execution lock
- Env vars: `X_API_KEY`, `X_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_BEARER_TOKEN`, `X_BOT_USERNAME`, `X_CRON_SECRET`

### Base City (`/neural-map.html`)
- Three.js r128 (non-module, CDN)
- 15×15 grid, BLOCK=18, STREET=12, CELL=30
- MeshPhongMaterial + emissiveMap for window glow
- UnrealBloomPass disabled on mobile

### B20 Studio (`/b20-studio.html`)
- Chain ID comparison must be case-insensitive (MetaMask returns lowercase hex)
- EIP-1559 gas: always pass `maxFeePerGas` + `maxPriorityFeePerGas` from API
- Devnet gas floor: 1 gwei minimum when baseFee = 0

### Open Source Sync
- Workflow: `.github/workflows/sync-opensource.yml`
- Source: `aureliusai-code/orlix` main branch
- Target: `tylerbroqs/orlixai` main branch
- Requires secret: `TYLERBROQS_PAT` in aureliusai-code/orlix settings

## Environment Variables

```env
# X Agent
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

## Deployment
- Platform: Vercel (auto-deploy from main branch of aureliusai-code/orlix)
- Domain: orlix.xyz
- Function timeout: most endpoints 10s, b20-skill 30s

## Common Commands
```bash
# Push changes
git add -A && git commit -m "..." && git push origin main

# Check deployment
# Vercel auto-deploys on push to main
```
