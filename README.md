# 🎯 jaune — OpenSea Raw Transaction Sniper

OpenSea raw transaction sniper for EVM NFT whitelist / FCFS mints.

This repo is **raw-only by design**. Users do not need to understand SeaDrop proof tuples, mint params, ABI routes, or manual allowlist calldata. OpenSea prepares the raw mint transaction; this bot polls for it, then broadcasts with a same-nonce gas ladder.

---

## ⚠️ Security First

Use a **burner wallet** only.

Never share or commit:

- `.env`
- `PRIVATE_KEY`
- `OPENSEA_JWT`
- premium RPC URLs
- logs containing mint/session data

After a mint war, rotate or clear secrets from `.env`.

---

## ✨ What This Bot Does

- Polls OpenSea GraphQL until a raw mint transaction is released
- Requires a fresh OpenSea JWT from your browser session
- Supports preflight, dry-run, JWT check, raw transaction test, and deep analyzer
- Broadcasts with same-nonce gas ladder
- Masks secrets in logs
- Keeps secrets out of git via `.gitignore`

---

## ⚡ Speed architecture

Mint wars are won in the fire path. jaune's run is split into phases so that
nothing slow sits between the phase opening and your transactions hitting
the mempool:

1. **Preflight (before the gun)** — config validation, contract check, and
   every wallet's balance are collected up front. The fire path never spends
   an RPC round-trip on them again.
2. **Parallel raw-tx fetch** — each wallet polls OpenSea for its released raw
   transaction *independently and concurrently*. No wallet waits for a
   sibling's confirmation.
3. **One gas estimate** — all wallets share the same calldata shape, so gas
   is estimated once, then scaled by the `gasLimitBufferMultiplier` OpenSea
   itself ships with the transaction when present.
4. **Parallel nonces** — one round of nonce fetches, all wallets at once.
5. **Pre-signed ladder, fired everywhere** — each wallet's gas ladder
   (default tiers 300/220/160/120% of the fee plan, same nonce) is fully
   signed locally, then every signed tier is broadcast to **all working RPC
   endpoints simultaneously** — plus an optional private relay
   (`PRIVATE_RELAY_URL`, e.g. Flashbots Protect). Duplicate "already known"
   replies count as landed, not errors.
6. **Receipts last** — confirmations are collected in parallel only after
   every wallet's ladder is already in flight.

---

## 📦 Install

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
```

---

## 🔑 Configure `.env`

Minimum config:

```env
PRIVATE_KEY=***
RPC_URL=https://ethereum-rpc.publicnode.com
NFT_CONTRACT=0xYourNftContract
CHAIN_IDENTIFIER=ethereum
QUANTITY=1

MINT_MODE=opensea_raw
OPENSEA_COLLECTION_SLUG=your-collection-slug
OPENSEA_JWT=eyJ_replace_with_fresh_token

DRY_RUN=true
```

`MINT_MODE` is locked to raw mode:

```env
MINT_MODE=opensea_raw
```

---

## 🌐 Supported Chains

Set `CHAIN_IDENTIFIER` to match your RPC and OpenSea drop chain.

| Chain | Value |
| --- | --- |
| Ethereum | `ethereum` |
| Base | `base` |
| Arbitrum | `arbitrum` |
| Optimism | `optimism` |
| Polygon | `polygon` |
| Abstract | `abstract` |
| Zora | `zora` |
| Blast | `blast` |
| Shape | `shape` |

---

## ⏱️ Get Fresh OpenSea JWT

JWT is the browser login/session token OpenSea uses after your wallet is connected.

Get it **5–10 minutes before FCFS / whitelist phase**.

1. Open the OpenSea collection page
2. Connect/login your mint wallet
3. Press `F12` to open Developer Tools
4. Go to **Network** tab
5. Filter/search `graphql`
6. Refresh the OpenSea page
7. Click a `graphql` request
8. Open **Headers**
9. Find:

```txt
Authorization: Bearer eyJ...
```

10. Copy only the token after `Bearer `
11. Paste it into `.env`:

```env
OPENSEA_JWT=eyJxxxxxxxxxxxxxxxx
```

JWT expires. If `npm run jwt-check` says it is expired or close to expiry, copy a fresh one.

---

## 🧪 Pre-War Checks

### 1. Syntax check

```bash
npm run check
```

### 2. JWT check

```bash
npm run jwt-check
```

Validates JWT format and expiry time.

### 3. Target analyzer

```bash
npm run analyze
```

Checks:

- RPC connection
- chain id
- NFT contract code
- OpenSea stage metadata when available
- fee recipient hints

### 4. Raw transaction test

```bash
npm run raw-test
```

Checks whether OpenSea currently returns a raw mint transaction for your wallet/session.

Exit code notes:

- `0` = raw tx available
- `2` = request worked, but raw tx not released yet
- `1` = config/network/auth error

### 5. Deep browser analyzer

```bash
npm run analyze-deep
```

Uses Playwright to open the OpenSea page and watch frontend network requests.

Install Playwright only if you need this:

```bash
npm install -D playwright
npx playwright install chromium
```

Useful env:

```env
OPENSEA_DROP_URL=https://opensea.io/collection/your-collection
HEADLESS=true
ANALYZE_WAIT_MS=15000
```

This does **not** sign or broadcast. It only inspects OpenSea frontend/network behavior and writes a report to `logs/`.

---

## 🚀 Run The Sniper

### Dry-run first

```bash
npm run dry-run
```

Dry-run polls OpenSea, builds cost summary if raw tx exists, estimates gas, and checks balance.

No broadcast.

### Live mint

```bash
DRY_RUN=false npm start
```

Only run live after:

- JWT is fresh
- preflight is clean
- raw-test looks good or phase is about to open
- burner wallet has enough gas

Do **not** close the terminal during FCFS. The bot polls until raw tx is released or polling limit is reached.

---

## ⚡ Polling Strategy

Safe default:

```env
OPENSEA_POLLS=120
OPENSEA_POLL_INTERVAL_MS=1000
```

War mode:

```env
OPENSEA_POLL_INTERVAL_MS=500
```

Aggressive/risky:

```env
OPENSEA_POLL_INTERVAL_MS=250
```

Lower interval = faster detection, higher rate-limit risk.

---

## ⛽ Gas Ladder

Balanced default:

```env
FIRE_GAS_TIERS=300,220,160,120
```

Brutal FCFS war:

```env
FIRE_GAS_TIERS=700,500,350,250,150
```

Same nonce means only one transaction should be mined, but the highest accepted tier can still be expensive on Ethereum mainnet.

---

## 🧾 Environment Variables

| Variable | Required | Notes |
| --- | --- | --- |
| `PRIVATE_KEY` | Yes | Burner wallet private key |
| `RPC_URL` | Yes | EVM RPC endpoint |
| `NFT_CONTRACT` | Yes | Drop contract address |
| `CHAIN_IDENTIFIER` | Yes | `ethereum`, `base`, etc |
| `QUANTITY` | Yes | Mint quantity |
| `MINT_MODE` | Yes | Must be `opensea_raw` |
| `OPENSEA_COLLECTION_SLUG` | Yes | OpenSea collection slug |
| `OPENSEA_JWT` | Yes | Fresh OpenSea Bearer token |
| `OPENSEA_POLLS` | Yes | Poll attempts |
| `OPENSEA_POLL_INTERVAL_MS` | Yes | Delay between polls |
| `FIRE_GAS_TIERS` | Yes | Same-nonce gas ladder percentages |
| `DRY_RUN` | Yes | Keep `true` until ready |

---

## 🧯 Troubleshooting

### `Missing OPENSEA_JWT in .env`

Copy a fresh Bearer token from OpenSea Network tab.

### `OPENSEA_JWT is expired`

JWT expired. Re-copy a fresh token 5–10 minutes before mint.

### `OpenSea raw transaction not released`

Common causes:

- phase not open yet
- wallet not eligible
- JWT expired / wrong wallet session
- wrong collection slug
- OpenSea GraphQL changed

### `NFT_CONTRACT has no code`

Wrong chain, wrong RPC, or wrong contract.

### `Insufficient balance`

Top up burner wallet or lower gas/quantity.

### `gas too expensive`

Lower:

```env
FIRE_GAS_TIERS
BASE_FEE_MULTIPLIER
MAX_PRIORITY_GWEI
```

---

## 🛡️ Safety Design

- No hidden transfer logic
- No private key upload
- No telemetry
- No obfuscated code
- No suspicious dependencies
- Live broadcast requires explicit `DRY_RUN=false`
- Deep analyzer does not sign or spend gas

---

## 📌 Recommended War Flow

```bash
npm install
cp .env.example .env
# fill .env
npm run jwt-check
npm run analyze
npm run raw-test
npm run dry-run
DRY_RUN=false npm start
```

Run it a few minutes before FCFS. Keep JWT fresh. Use burner wallet. Keep terminal alive.
