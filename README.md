# farmz-backend

This is the backend for **FarmZ**, a play-to-earn farming game. It runs on a dedicated Supabase project and uses:

- Postgres with RLS on every table
- Supabase Auth
- Edge Functions written in Deno/TypeScript

The game runs entirely off-chain. The backend is the authority for game state, coins and missions. It is also the **trusted signer** for the `FarmZClaim` contract: it signs EIP-712 claims that players redeem on-chain for FARMZ.

| | Base Sepolia (chainId 84532) |
| --- | --- |
| FarmZ token | `0xaA3639f77A827C5C8B16F7dB44aA4F54542Bb26B` |
| FarmZClaim | `0xCd1602e8bbCacC20b1be251B572f663484E8702c` |

---

## Architecture

```
client ──SIWE──> auth-nonce / auth-verify ──> Supabase session (JWT)
client ──JWT───> plant / harvest / feed-animal / collect-produce / sell / buy / complete-order / state
                    │  (validate input, look up server-side config)
                    ▼
               Postgres RPC (SECURITY DEFINER, service_role only)
                    │  row locks + now() + ledger writes + mission progress, in ONE transaction
                    ▼
               players / farms / plots / animals / inventory / coin_ledger / farmz_ledger / missions …
client ──JWT───> claim-request ──> claim_reserve (SQL) ──> EIP-712 sign (viem) ──> { amount, nonce, deadline, signature }
client ──tx────> FarmZClaim.claim(amount, nonce, deadline, signature)   (Base Sepolia)
client ──JWT───> claim-confirm (backend verifies receipt + Claimed event)
pg_cron 00:00 Asia/Bangkok ──> generate_daily_missions()
```

### Server-authoritative rules

- **Clients only say what they want to do.** For example `{plotId, cropId}` or `{item, qty}`. Clients never send prices, yields, timers or timestamps.
- **Prices, grow and produce times, yields and XP come from the server.** They live in [`supabase/functions/_shared/config.ts`](supabase/functions/_shared/config.ts).
- **Timers use the database clock.** `ready_at` and `produce_ready_at` are computed with `now()`, and are checked with `now()` at harvest and collect time. A client cannot speed them up.
- **Each action is one transaction.** Every action is a Postgres function that locks its rows and validates ownership, state, level, inventory and balance before changing anything. Errors come back as `FZ:<CODE>` and map to HTTP 4xx responses.
- **Coins go through `coin_ledger`, which is the source of truth.**
  - Every coin change is an append-only ledger row with `delta`, `reason` and `ref`.
  - `players.coin_balance` is a cache maintained by a trigger. It is checked to be `>= 0`.
  - A trigger blocks any UPDATE or DELETE on the ledger.
  - The tests check that `balance == sum(ledger)`.
- **`claimable_farmz` is tracked the same way, in `farmz_ledger`.** Rows are added for mission rewards, claims and refunds.
- **RLS:** a player can **read** only their own rows, plus the shared daily mission board. The only thing a player can write is their own `email`. `INSERT`, `UPDATE` and `DELETE` are revoked for `anon` and `authenticated`, and every RPC can be executed by `service_role` only.
- **Anti-farm limits:**
  - Per-player rate limits per action type (`_rate_limit`, applied per 60 s window).
  - Selling pays diminishing returns when a player sells more than 20 times in 10 minutes (50%), or more than 40 times (25%).
  - Each order can be completed once per day.
  - Each mission pays out once.

## Endpoints (Edge Functions)

All endpoints take and return JSON. Authenticated endpoints need `Authorization: Bearer <access_token>`.

| Function | Auth | Body | Notes |
| --- | --- | --- | --- |
| `auth-nonce` | none | `{ address }` | Returns a SIWE nonce, valid for 10 minutes. |
| `auth-verify` | none (SIWE) | `{ message, signature }` | Verifies the SIWE message. Returns `session` (access and refresh token). Creates the player (farm, 9 plots, 500 coin) on first login and runs the daily check-in. |
| `config` | none | – | Game config for the UI, plus the claim contract and **signer address**. |
| `state` | JWT | – | Full game state and server time. |
| `plant` | JWT | `{ plotId, cropId }` | Deducts the seed cost. |
| `harvest` | JWT | `{ plotId }` | Only when `now() >= ready_at`. |
| `feed-animal` | JWT | `{ animalId }` | Uses feed from the inventory. |
| `collect-produce` | JWT | `{ animalId }` | Only when `now() >= produce_ready_at`. |
| `sell` | JWT | `{ item, qty }` | Adds coin. |
| `buy` | JWT | `{ item, qty }` | Buys feed or animals. Deducts coin. |
| `complete-order` | JWT | `{ orderId }` | Once per day for each order. |
| `mission-progress` | `x-internal-secret` | `{ playerId, kind, amount }` | **Internal only.** |
| `claim-request` | JWT | – | Returns `{ claimId, account, amount, amountWei, nonce, deadline, signature, chainId, contract }`. |
| `claim-confirm` | JWT | `{ claimId, txHash }` | Checks the tx on-chain, then marks the claim `confirmed`. |

## Daily mission engine

- **Templates** are stored in `mission_templates` and seeded by the migration. You can edit them as data.

  | Kind | Templates |
  | --- | --- |
  | `harvest_crops` | `harvest_20_crops`, `harvest_50_crops` |
  | `feed_animals` | `feed_5_animals`, `feed_15_animals` |
  | `sell_value` | `sell_produce_value_300`, `sell_produce_value_1000` |
  | `login_streak` | `login_streak_3`, `login_streak_7` |
  | `complete_order` | `complete_order_1`, `complete_order_3` |

- **Daily generation:** `pg_cron` runs `generate_daily_missions()` every day at **17:00 UTC (00:00 Asia/Bangkok)**.
  - It picks one template per kind, deterministically by date.
  - It creates `mission_progress` rows for players who were active in the last 7 days.
  - If the cron has not run yet for the day, the missions are generated the first time any player needs them.
- **Progress** is updated inside the same transaction as the economy action that caused it:
  - harvest → `harvest_crops`
  - feed → `feed_animals`
  - sell revenue → `sell_value`
  - login → `login_streak`
  - order → `complete_order`
- **Payout:** when a mission reaches its target, it is marked completed and `reward_coin` is paid through `coin_ledger`. Some missions also add `reward_farmz` to `claimable_farmz` through `farmz_ledger`.
- **Other sources of progress:** trusted server-side code can call the internal `mission-progress` function with the `x-internal-secret` header.

## Claim flow (FarmZClaim)

`claim-request` runs these steps:

1. Authenticate the player.
2. Settle the player's open claims:
   - If a claim is signed and its deadline has not passed, return **the same signature** (the endpoint is idempotent).
   - If a claim's deadline passed more than 2 minutes ago, read `FarmZClaim.nonceUsed(account, nonce)`.
     - `true`: mark it `confirmed`.
     - `false`: mark it `failed` and **refund** the amount. The contract rejects the signature after the deadline, so the refund is safe.
3. Call `claim_reserve` (SQL, holds a row lock). It checks, in order:
   - no pending claim
   - cooldown (default: one claim per 24 h)
   - amount = `min(claimable_farmz, CLAIM_MAX_PER_DAY)`, and at least `CLAIM_MIN_AMOUNT`

   It then deducts the amount from `claimable_farmz` through the ledger and inserts a `claims` row with status `signed`.
4. Sign with `CLAIM_SIGNER_PRIVATE_KEY`:
   - Uses a random `uint256` nonce. The contract tracks used nonces per account, and `(account, nonce)` is UNIQUE in the database.
   - Uses `deadline = now + 1 h`.
   - If signing fails, the reservation is refunded.
5. Return the payload. The frontend then calls `FarmZClaim.claim(amountWei, nonce, deadline, signature)` **from the player's wallet**, because the contract uses `msg.sender` as `account`. After that it calls `claim-confirm` with the tx hash.

**Claim statuses:**

| Status | Meaning |
| --- | --- |
| `signed` | Signature issued. |
| `submitted` | The frontend reported a tx hash that has not been mined yet. |
| `confirmed` | The Claimed event was verified on-chain, or the nonce is used. |
| `failed` | The claim expired unused, or signing failed. The amount was refunded. |

The EIP-712 domain and types in [`_shared/eip712.ts`](supabase/functions/_shared/eip712.ts) **must** match `FarmZClaim.sol`:

```
domain = { name: "FarmZClaim", version: "1", chainId: 84532, verifyingContract: 0xCd1602e8bbCacC20b1be251B572f663484E8702c }
Claim(address account,uint256 amount,uint256 nonce,uint256 deadline)
```

`tests/eip712.test.ts` proves this with a **golden vector from the real FarmZClaim bytecode**:

- The typehash, domain separator and `hashClaim` digest match the contract's own output.
- The signature is byte-identical to the one the contract accepted, which minted 12.5 FARMZ in the test.
- Tampered amount, nonce, deadline, account or chain all fail.

`deno task verify-claim` runs the same comparison against the **live** Base Sepolia contract. It is read-only. It also checks `trustedSigner()`.

---

## Setup

Prerequisites:

- [Supabase CLI](https://supabase.com/docs/guides/cli)
- [Deno 2](https://deno.com)
- Postgres binaries, needed only for `deno task test:sql`

### 1. Create and link the dedicated Supabase project

```bash
supabase login
supabase projects create farmz --org-id <org> --region ap-southeast-1   # or via dashboard
supabase link --project-ref <project-ref>
supabase db push            # applies supabase/migrations (schema, RLS, RPCs, pg_cron job, mission seeds)
```

To confirm the cron job exists, run `select * from cron.job;` in the SQL editor. The migration creates `farmz-daily-missions`.

### 2. Generate the claim signer (on your machine)

```bash
deno task gen-signer          # prints ADDRESS=0x… and CLAIM_SIGNER_PRIVATE_KEY=0x…
```

Keep the key private. **Only share the ADDRESS.**

### 3. Set the secrets

```bash
supabase secrets set \
  CLAIM_SIGNER_PRIVATE_KEY=0x... \
  INTERNAL_API_SECRET=$(openssl rand -hex 32) \
  SIWE_ALLOWED_DOMAINS=localhost:5173,<your-frontend-domain> \
  FARMZ_TOKEN_ADDRESS=0xaA3639f77A827C5C8B16F7dB44aA4F54542Bb26B \
  FARMZ_CLAIM_ADDRESS=0xCd1602e8bbCacC20b1be251B572f663484E8702c \
  CHAIN_ID=84532 \
  BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
```

The hosted runtime injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` automatically. See [`.env.example`](.env.example) for all variables. **Never commit `.env`.**

### 4. Deploy the functions

```bash
supabase functions deploy     # deploys every function; verify_jwt settings come from supabase/config.toml
```

### 5. Connect the backend to the contract (from the farmz-contracts repo or Basescan)

```bash
# farmz-contracts: npx hardhat console --network baseSepolia
> const c = await ethers.getContractAt("FarmZClaim", "0xCd1602e8bbCacC20b1be251B572f663484E8702c")
> await (await c.setTrustedSigner("<ADDRESS from gen-signer>")).wait()
> await (await c.unpause()).wait()      # only when ready to test the full claim flow
```

Then check everything on-chain:

```bash
CLAIM_SIGNER_PRIVATE_KEY=0x... deno task verify-claim    # PASS on domain, hashClaim, recovery, trustedSigner
```

## Tests

```bash
deno task check      # type-check all functions/scripts/tests
deno task test       # EIP-712 golden-vector tests + config sanity
deno task test:sql   # migrations + economy/missions/claims/RLS scenario tests on a throwaway local Postgres
                     # (PG_BIN=/usr/lib/postgresql/16/bin deno task test:sql)
```

## Repo layout

```
supabase/
  config.toml                  # function verify_jwt settings
  migrations/                  # schema + RLS, economy/mission RPCs, claims + pg_cron + seeds
  functions/
    _shared/                   # config, eip712 signer, db/auth helpers, chain client, http
    auth-nonce/ auth-verify/ config/ state/
    plant/ harvest/ feed-animal/ collect-produce/ sell/ buy/ complete-order/
    mission-progress/ claim-request/ claim-confirm/
scripts/  gen-signer.ts  verify-claim-onchain.ts  test-sql.sh
tests/    eip712.test.ts  config.test.ts  sql/
```
