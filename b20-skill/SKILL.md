# Orlix AI — B20 Token Skill

**Full B20 token lifecycle on @base through Orlix AI.**

B20 is Base's native precompile token standard (Base Beryl upgrade) — ERC-20 compatible, role-gated, with built-in compliance policies. This skill gives agents real chain interactions: live gas prices, balance checks, config validation, deployment bundles, ERC-20 reads, and tx receipts — all via real Base RPC calls.

---

## What This Skill Does

- **Live chain data** — real block number, EIP-1559 gas prices, deploy cost estimates from Base
- **Balance checks** — ETH balance + any ERC-20 balance for any address on Base
- **Token reads** — name, symbol, decimals, total supply for any ERC-20 on Base
- **Validate** — deep B20 config check + live admin ETH balance + gas estimate
- **Prepare** — full deployment bundle: ABI-encoded calldata + real nonce + complete EIP-1559 unsigned tx
- **Receipt** — check tx hash status + extract deployed token address from logs
- Works for both **Asset** and **Stablecoin** B20 variants
- Supports **Base mainnet** (chainId 8453) and **Base Sepolia testnet** (84532)

---

## Usage Examples

```bash
# Get live Base chain status + gas prices
bankr prompt "Use Orlix B20 skill to get info on Base"

# Check if a wallet can afford to deploy
bankr prompt "Use Orlix B20 skill to check balance of 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

# Read any ERC-20 token on Base
bankr prompt "Use Orlix B20 skill token_info: address=0x799c28BAC95B3E0B26534D1e9A586511895EcBA3"

# Validate a B20 config + live chain check
bankr prompt "Use Orlix B20 skill to validate: name=BNKR Token, symbol=BNKR, variant=asset, decimals=18, admin=0x1234..."

# Prepare full deployment bundle (real gas + nonce from Base)
bankr prompt "Use Orlix B20 skill to prepare a B20 stablecoin: name=OrUSD, symbol=OUSD, supply_cap=100000000, admin=0x1234..., policies.blocklist=true"

# Check a tx receipt
bankr prompt "Use Orlix B20 skill to check receipt of 0xabc...123 on Base"
```

---

## API Reference

**Endpoint:** `https://orlixai.xyz/api/b20-skill`

### GET `?action=manifest`
Full tool schema in Claude + OpenAI format.

### GET `?action=info[&network=mainnet|sepolia]`
Live chain status, gas prices, B20 standard details.

### GET `?action=gas[&network=mainnet|sepolia]`
Current EIP-1559 gas prices with deploy cost estimate.

### POST `{ action: "balance", address, token?, network? }`
ETH balance + optional ERC-20 balance for any address.

```json
{ "action": "balance", "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }
```

### POST `{ action: "token_info", address, holder?, network? }`
Read any ERC-20 on Base.

```json
{ "action": "token_info", "address": "0x799c28BAC95B3E0B26534D1e9A586511895EcBA3" }
```

### POST `{ action: "validate", ...params }`
Validate B20 config + live admin balance check from Base RPC.

### POST `{ action: "prepare", ...params }`
Validate + build complete EIP-1559 deployment tx with live gas + nonce.

**Full prepare request:**
```json
{
  "action": "prepare",
  "name": "BNKR Token",
  "symbol": "BNKR",
  "variant": "asset",
  "decimals": 18,
  "supply_cap": "1000000000",
  "admin": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "policies": { "blocklist": true },
  "network": "mainnet"
}
```

**Response includes:**
```json
{
  "ok": true,
  "status": "prepared",
  "config": { ... },
  "chain": {
    "blockNumber": 28000000,
    "adminBalance": { "ether": "0.012345" },
    "gas": { "baseFeeGwei": "0.0012", "maxFeePerGas": "0x..." }
  },
  "deployment": {
    "factory": "0x4200000000000000000000000000000000000B20",
    "policyBits": 2,
    "calldata": { "data": "0x...", "abiSig": "create(string,string,uint8,uint256,address,uint8,uint8,string)" },
    "tx": {
      "type": "0x02",
      "chainId": "0x2105",
      "to": "0x4200000000000000000000000000000000000B20",
      "data": "0x...",
      "gas": "0x30d40",
      "maxFeePerGas": "0x...",
      "nonce": "0x..."
    }
  }
}
```

### POST `{ action: "receipt", tx_hash, network? }`
Check tx status + deployed token address.

---

## Token Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Full token name, max 64 chars |
| `symbol` | string | ✓ | Ticker, max 11 alphanumeric chars |
| `admin` | string | ✓ | Admin wallet (0x...) — required unless adminless |
| `variant` | `asset` \| `stablecoin` | — | Default: `asset` |
| `decimals` | integer 6–18 | — | Default: 18. Fixed at 6 for stablecoin. |
| `supply_cap` | string | — | Integer string. `"0"` = uncapped (default) |
| `adminless` | boolean | — | No admin. Irreversible. |
| `policies.allowlist` | boolean | — | Only allowlisted addresses can hold |
| `policies.blocklist` | boolean | — | Block specific addresses from transferring |
| `policies.freeze` | boolean | — | Admin can freeze + seize balances |
| `contract_uri` | string | — | IPFS URI for token metadata |
| `network` | `mainnet` \| `sepolia` | — | Default: `mainnet` (Base, chainId 8453) |

---

## Links

| | |
|---|---|
| B20 Studio | https://orlixai.xyz/b20 |
| API Manifest | https://orlixai.xyz/api/b20-skill?action=manifest |
| Control Room | https://orlixai.xyz/control-room |
| App | https://orlixai.xyz |
