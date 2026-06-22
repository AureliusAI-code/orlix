---
name: orlix-b20
description: B20 token skill on Base via Orlix AI. Use when an agent wants to create a B20 token (Base's native precompile token standard, Beryl upgrade), validate a config with live gas + admin balance check from Base RPC, build a complete ABI-encoded EIP-1559 deployment transaction, read any ERC-20 on Base, check wallet ETH balances, get current gas prices, or verify a tx receipt. No authentication required. Supports Base mainnet and Base Sepolia.
metadata:
  {
    "clawdbot": {
      "emoji": "⬡",
      "homepage": "https://orlixai.xyz/b20",
    }
  }
---

# Orlix B20

Deploy B20 tokens on Base — the native precompile token standard launching with Base Beryl. ERC-20 compatible, role-gated, compliance policies built in. No Solidity required.

All actions use real Base RPC calls. Gas prices, nonces, and balances are fetched live from the chain — nothing is mocked.

**Endpoint:** `https://orlixai.xyz/api/b20-skill`  
**Auth:** None required  
**Manifest:** `https://orlixai.xyz/api/b20-skill?action=manifest`

---

## Actions

| Action | Method | What it does |
|--------|--------|-------------|
| `info` | GET | Live chain status, gas prices, B20 standard overview |
| `gas` | GET | EIP-1559 gas breakdown with deploy cost estimate |
| `balance` | POST | ETH balance + optional ERC-20 balance for any address |
| `token_info` | POST | Read name, symbol, decimals, total supply for any ERC-20 on Base |
| `validate` | POST | Deep B20 config check + live admin ETH balance vs. gas estimate |
| `prepare` | POST | Complete EIP-1559 deployment tx with live gas + nonce from Base |
| `receipt` | POST | Tx hash status + deployed token address extracted from factory logs |

---

## Usage with Bankr

```bash
# Live Base chain status and gas prices
bankr prompt "Use the Orlix B20 skill to get current chain info and gas on Base"

# Check if a wallet can afford to deploy
bankr prompt "Use Orlix B20 skill to check the ETH balance of 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

# Read any ERC-20 token on Base
bankr prompt "Use Orlix B20 skill to get token info for 0x799c28BAC95B3E0B26534D1e9A586511895EcBA3 on Base"

# Validate a B20 config (live balance check included)
bankr prompt "Use Orlix B20 skill to validate: name='BNKR Token', symbol='BNKR', variant=asset, decimals=18, admin=0x1234..."

# Prepare a full deployment bundle (real gas + nonce)
bankr prompt "Use Orlix B20 skill to prepare a B20 asset token: name='My Token', symbol='MTK', 10M supply cap, admin=0x1234..., blocklist policy"

# Stablecoin with allowlist
bankr prompt "Use Orlix B20 skill to prepare a B20 stablecoin: name='OrUSD', symbol='OUSD', supply_cap=100000000, admin=0xABCD..., allowlist policy"

# Check a transaction receipt
bankr prompt "Use Orlix B20 skill to check receipt of 0xabc...123 on Base"
```

---

## Reference

### GET `?action=info`

```bash
curl 'https://orlixai.xyz/api/b20-skill?action=info'
```

Returns current block number, base fee, gas tips, B20 factory address, variant descriptions, and feature list.

---

### GET `?action=gas`

```bash
curl 'https://orlixai.xyz/api/b20-skill?action=gas'
```

Returns EIP-1559 breakdown (base fee, maxFeePerGas, priority tips at 25/50/75th percentile) and estimated B20 deploy cost in ETH.

---

### POST `balance`

```bash
curl -X POST https://orlixai.xyz/api/b20-skill \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "balance",
    "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
  }'
```

Include `"token": "0x..."` to also check an ERC-20 balance at the same address.

---

### POST `token_info`

```bash
curl -X POST https://orlixai.xyz/api/b20-skill \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "token_info",
    "address": "0x799c28BAC95B3E0B26534D1e9A586511895EcBA3",
    "holder": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
  }'
```

Reads name, symbol, decimals, and total supply via live `eth_call`. Add `"holder"` to also return that address's balance.

---

### POST `validate`

```bash
curl -X POST https://orlixai.xyz/api/b20-skill \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "validate",
    "name": "BNKR Token",
    "symbol": "BNKR",
    "variant": "asset",
    "decimals": 18,
    "admin": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "policies": { "blocklist": true }
  }'
```

Validates all config params, then fetches the admin wallet's live ETH balance from Base and compares it against the current deploy cost estimate. Returns a `chainCheck` block with the results.

---

### POST `prepare`

```bash
curl -X POST https://orlixai.xyz/api/b20-skill \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "prepare",
    "name": "BNKR Token",
    "symbol": "BNKR",
    "variant": "asset",
    "decimals": 18,
    "supply_cap": "1000000000",
    "admin": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "policies": { "blocklist": true },
    "network": "mainnet"
  }'
```

Returns ABI-encoded calldata for the B20 factory precompile and a complete unsigned EIP-1559 transaction with live gas and nonce fetched from Base. Sign and broadcast once B20 activates.

**Response shape:**
```json
{
  "ok": true,
  "status": "prepared",
  "config": { "name": "BNKR Token", "symbol": "BNKR", "variant": "asset", "decimals": 18, "supply_cap": "1000000000" },
  "chain": {
    "network": "mainnet",
    "chainId": 8453,
    "blockNumber": 28000000,
    "adminBalance": { "ether": "0.023100" },
    "gas": { "baseFeeGwei": "0.0012", "maxFeePerGas": "0x...", "maxPriorityFeePerGas": "0x..." }
  },
  "deployment": {
    "factory": "0x4200000000000000000000000000000000000B20",
    "policyBits": 2,
    "calldata": {
      "data": "0x...",
      "abiSig": "create(string,string,uint8,uint256,address,uint8,uint8,string)"
    },
    "tx": {
      "type": "0x02",
      "chainId": "0x2105",
      "to": "0x4200000000000000000000000000000000000B20",
      "value": "0x0",
      "data": "0x...",
      "gas": "0x30d40",
      "maxFeePerGas": "0x...",
      "maxPriorityFeePerGas": "0x...",
      "nonce": "0x4"
    }
  }
}
```

---

### POST `receipt`

```bash
curl -X POST https://orlixai.xyz/api/b20-skill \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "receipt",
    "tx_hash": "0xabc123...",
    "network": "mainnet"
  }'
```

Returns `success` / `pending` / `failed`, gas used, block number, and parses the B20 factory logs to extract the deployed token address.

---

## Token Parameters

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | ✓ | Max 64 chars |
| `symbol` | string | ✓ | Max 11 alphanumeric chars |
| `admin` | string | ✓ | 0x wallet — required unless `adminless: true` |
| `variant` | `asset` \| `stablecoin` | — | Default: `asset` |
| `decimals` | integer 6–18 | — | Default: 18. Fixed at 6 for stablecoin. |
| `supply_cap` | string | — | Integer string. `"0"` = uncapped. |
| `adminless` | boolean | — | No admin. Irreversible — no minting or policy changes ever. |
| `policies.allowlist` | boolean | — | Only allowlisted addresses can hold or receive |
| `policies.blocklist` | boolean | — | Blocked addresses cannot send or receive |
| `policies.freeze` | boolean | — | Admin can freeze any account and seize its balance |
| `contract_uri` | string | — | IPFS URI for token metadata |
| `network` | `mainnet` \| `sepolia` | — | Default: `mainnet` (Base, chainId 8453) |

---

## B20 Variants

**`asset`** — general-purpose. Configurable decimals (6–18), rebasing support, issuer metadata. Good for governance tokens, onchain-native assets, and real-world assets.

**`stablecoin`** — fiat-focused. Fixed 6 decimals, currency code field. Good for fiat-backed stablecoins and regulated assets.

Both variants are ERC-20 compatible — no changes needed in wallets, DEXes, or indexers.

---

## Compliance Policies

Policies are set at deploy time. Encoded as a bitmask in the factory call.

| Policy | Bit | Description |
|--------|-----|-------------|
| `allowlist` | 0 | Only allowlisted addresses can hold or receive the token |
| `blocklist` | 1 | Blocked addresses cannot send or receive |
| `freeze` | 2 | Admin can freeze an account and seize its balance |

`allowlist` and `blocklist` can both be enabled — allowlist takes precedence.

---

## Networks

| Network | Chain ID | RPC |
|---------|----------|-----|
| Base (mainnet) | 8453 | https://mainnet.base.org |
| Base Sepolia (testnet) | 84532 | https://sepolia.base.org |

Pass `"network": "sepolia"` to any POST action to target testnet.

---

## Links

- **B20 Studio** — https://orlixai.xyz/b20
- **Orlix App** — https://orlixai.xyz
- **API Manifest** — https://orlixai.xyz/api/b20-skill?action=manifest
- **$ORLIX Token** — https://orlixai.xyz/token
- **Telegram Bot** — https://t.me/orlixai_bot
