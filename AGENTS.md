# AGENTS.md — `testnet-faucet`

Self-hosted Node service that drips testnet WART to requesting addresses.
This is the canonical source-of-truth for the sub-repo.

## What this is

A single Node process. One instance. Testnet only — no mainnet equivalent.
Used by the website's `/testnet` page.

## Source-of-truth map

| Question | Answer |
|----------|--------|
| What talks to the defi node? | `src/faucet.js` (drips) and `src/balance.js` (balance cache) — both via `fetch` to `${NODE_URL}/account/...` and `${NODE_URL}/transaction/add` |
| Where is the faucet's own address stored? | In memory only, derived at boot in `src/config.js` via `Account.fromPrivateKeyHex(env.FAUCET_HEX_PRIVKEY).address.hex`. **Never on disk, never in any file.** |
| Where is state persisted? | Nowhere. Balance cache and rate-limit counters are RAM-only. Restarting the service resets both. |
| How is the address exposed? | `GET /api/status` returns it; `GET /` renders it on the landing page. The donation row on the website's `/testnet` page reads it via the same `/api/status` call. |
| How is the reverse proxy trusted? | `TRUST_PROXY` env (false / loopback / `<CIDR>` / true), default `loopback`. See `docs/deploy.md` for the full matrix. |
| How is the rate limit bucketed? | IPv4: literal IP. IPv6: first `/48` (configurable). `X-Forwarded-For` is honored only when nginx is configured to rewrite the header (see `docs/nginx.example.conf`). |
| How is the drip amount calculated? | `floor( selfBalance * (DRIP_PERCENT/100) - TX_FEE )`, with `DRIP_PERCENT=0.1` and `TX_FEE=0.001` defaults. The fee comes out of the 0.1%. |
| Is there a `MIN_DRIP` guard? | **No.** If `floor( selfBalance * 0.001 - fee )` is ≤ 0, the drip is refused with `503 { ok:false, error:"drip too small" }`. |
| How is the balance polled? | `GET {NODE_URL}/account/{faucetAddress}/wart_balance`, default every 60 s (`BALANCE_POLL_MS=60000`). State is in-memory; no persistent storage. |
| What is the faucet's domain? | `faucet.testnet.warthog.network` — this is the only faucet. |

## Conventions

- **One process, one host.** The repo's design assumes a single instance per host. If you ever need to scale out, run additional hosts with their own private keys (each becomes a separate faucet) rather than clustering.
- **No persistent storage.** Balance cache, rate-limit counters, address — all in memory. Restarting the service resets in-memory state. Acceptable.
- **No CI.** Small service, manual deploy, README has the procedure.
- **Single branch:** `master`.
- **Env shape:** one `.env.example.testnet` file. The repo will not have a `mainnet.env`; mainnet is out of scope.

## What is *not* in this repo

- The faucet's WART address (computed at runtime, never committed).
- The faucet's private key (env-only, never committed).
- The faucet reserve balance (RAM-only).
- Any history of drips (in-memory counter, resets on restart).
- Any `public-data/data/addresses.csv` row for the faucet — the address is dynamic and not a permanent tag.
- A `docker-compose.yml` — the repo's deploy doc covers bare-Node + systemd (primary) and bare-Docker (alternative). Compose is out of scope.
- A `Caddyfile` — the reverse proxy is host-managed nginx. The repo has `docs/nginx.example.conf` as a reference.
