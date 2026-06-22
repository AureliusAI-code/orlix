# Orlix AI — B20 Token Skill

**Deploy B20 tokens on @base through Orlix AI.**

B20 is Base's native precompile token standard (Base Beryl upgrade) — ERC-20 compatible, role-gated, with built-in compliance policies. This skill lets any AI agent configure, validate, and prepare B20 token deployments without writing a single line of Solidity.

---

## What This Skill Does

- **Validate** a B20 token config — name, symbol, variant, supply cap, roles, compliance policies
- **Prepare** a signed-ready deployment bundle — returns params ready for the agent's wallet to sign and broadcast
- **Preview** the deterministic token address before deploying
- Works for both **Asset** and **Stablecoin** B20 variants
- Deploys go live when Base activates the standard

---

## Usage Examples

```bash
# Validate a B20 token config
bankr prompt "Use Orlix B20 skill to validate: name=BNKR Token, symbol=BNKR, variant=asset, decimals=18, admin=0x1234..."

# Prepare a full deployment bundle
bankr prompt "Use Orlix B20 skill to prepare a B20 stablecoin called OrUSD (OUSD), supply cap 100M, blocklist policy, admin 0x1234..."

# Check B20 standard status
bankr prompt "Use Orlix B20 skill to get B20 standard info on Base"

# Asset token with compliance
bankr prompt "Use Orlix B20 skill: prepare asset token MyToken (MTK), 18 decimals, 10M supply cap, allowlist + freeze policies, admin 0xABCD..."
```

---

## API Reference

**Endpoint:** `https://orlixai.xyz/api/b20-skill`

### GET `?action=manifest`
Returns full tool schema in Claude + OpenAI format.

### GET `?action=info`
Returns B20 standard status and feature list.

### POST `{ action: "validate", ...params }`
Validate token config. Returns errors and warnings.

```json
{
  "action": "validate",
  "name": "BNKR Token",
  "symbol": "BNKR",
  "variant": "asset",
  "decimals": 18,
  "admin": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
}
```

### POST `{ action: "prepare", ...params }`
Validate + return full deployment bundle.

```json
{
  "action": "prepare",
  "name": "BNKR Token",
  "symbol": "BNKR",
  "variant": "asset",
  "decimals": 18,
  "supply_cap": "1000000000",
  "admin": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "policies": {
    "blocklist": true
  }
}
```

**Response:**
```json
{
  "ok": true,
  "status": "prepared",
  "gated": true,
  "config": { ... },
  "preview": {
    "address": "0xB20...",
    "standard": "B20/Asset",
    "chain": "base",
    "chainId": 8453
  },
  "deployment": {
    "to": "0x4200000000000000000000000000000000000B20",
    "chain_id": 8453,
    "params": { ... }
  }
}
```

---

## Token Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Full token name, max 64 chars |
| `symbol` | string | ✓ | Ticker, max 11 alphanumeric chars |
| `admin` | string | ✓ | Admin wallet address (0x...) |
| `variant` | `asset` \| `stablecoin` | — | Default: `asset` |
| `decimals` | integer 6–18 | — | Default: 18. Fixed at 6 for stablecoin. |
| `supply_cap` | string | — | Integer string. `"0"` = uncapped (default) |
| `adminless` | boolean | — | No admin. Irreversible. |
| `policies.allowlist` | boolean | — | Only allowlisted addresses can hold |
| `policies.blocklist` | boolean | — | Block specific addresses |
| `policies.freeze` | boolean | — | Admin can freeze + seize balances |
| `contract_uri` | string | — | IPFS URI for token metadata |

---

## Links

| | |
|---|---|
| B20 Studio | https://orlixai.xyz/b20 |
| API Manifest | https://orlixai.xyz/api/b20-skill?action=manifest |
| Control Room | https://orlixai.xyz/control-room |
| Docs | https://orlixai.xyz/docs |
| App | https://orlixai.xyz |
