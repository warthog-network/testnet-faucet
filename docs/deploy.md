// docs/deploy.md
//
// How to run the testnet faucet. Two paths are documented: bare-Node +
// systemd (the primary path; one process per host, no Docker) and bare
// Docker (a thin alternative that just runs the same image). nginx is the
// example reverse proxy on the same host; the proxy is host-managed, not
// containerized.

# Testnet faucet — deploy

This service is the source of testnet WART for the website's `/testnet`
page. It runs as a single Node process. It uses an in-RAM balance cache
(polled from the public defi testnet node) and an in-RAM rate limiter;
nothing persistent is written to disk.

## Prerequisites

- Node.js >= 20 on the host
- (optional, recommended) nginx on the host as a reverse proxy
- Access to a public defi testnet node (default: `https://warthog-defitestnet.duckdns.org/`)
- A freshly generated WART keypair for the faucet — see "Generate the
  faucet keypair" below

## Generate the faucet keypair

The faucet keypair is unique per deployment. Generate it locally with the
furnished `gen-key` script:

```sh
npm install
npm run gen-key
```

Output is two lines that drop straight into the faucet's `.env`:

```
FAUCET_HEX_PRIVKEY=ab12cd34...
FAUCET_ADDRESS=2de77d5e23dc63e4...
```

Save the second line (the address). You'll fund this address with testnet
WART before starting the service. Keep the first line (the private key)
secret — it only ever lives in the host's environment.

## Configure the service

Copy the env template and fill in the required values:

```sh
cp .env.example.testnet testnet-faucet.env
$EDITOR testnet-faucet.env
```

Required:

- `FAUCET_HEX_PRIVKEY` — from the previous step
- `NODE_URL` — the public defi testnet node (defaults to
  `https://warthog-defitestnet.duckdns.org/` if unset)

Recommended:

- `TRUST_PROXY=loopback` if the host's nginx runs on the same machine
  (the default). See "TRUST_PROXY" below for the full set of values.
- `CORS_ORIGIN=https://warthog.network,http://localhost:4321` so the
  website's `/testnet` page can call the faucet from a browser.

## Fund the faucet (testnet only)

Send a small amount of testnet WART to the address printed by `gen-key`.
A starting balance of ~100,000 WART covers ~1,000 drips before the
operator has to top up. Drips are 0.1% of the current self-balance per
call, so the reserve decays geometrically.

## Run with bare Node + systemd (primary)

```sh
npm install --omit=dev
NODE_ENV=production node src/server.js
```

A systemd unit (place at `/etc/systemd/system/testnet-faucet.service`):

```ini
[Unit]
Description=Warthog testnet faucet
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/testnet-faucet
EnvironmentFile=/opt/testnet-faucet/testnet-faucet.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
User=testnet-faucet

[Install]
WantedBy=multi-user.target
```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now testnet-faucet
sudo systemctl status testnet-faucet
```

## Run with Docker (alternative)

The repo includes a `Dockerfile` so you can run the same image if you
prefer. The image is plain — no `docker-compose` in this repo (the
service is small and one host runs one process).

```sh
docker build -t warthog-network/testnet-faucet:latest .
docker run -d --name testnet-faucet --restart unless-stopped \
  --env-file ./testnet-faucet.env \
  -p 127.0.0.1:3000:3000 \
  warthog-network/testnet-faucet:latest
```

The container listens on `127.0.0.1:3000` only; nginx in front of it
adds the public-facing `faucet.testnet.warthog.network` and TLS.

## Reverse proxy (nginx)

The faucet's IP detection requires the reverse proxy to **set**
`X-Forwarded-For` from the immediate peer, not pass through a
client-supplied value. A safe nginx server block for the testnet faucet:

```nginx
server {
  listen 443 ssl http2;
  server_name faucet.testnet.warthog.network;

  ssl_certificate     /etc/letsencrypt/live/faucet.testnet.warthog.network/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/faucet.testnet.warthog.network/privkey.pem;

  # Trust the value that nginx itself observes as the remote_addr. Do NOT
  # pass through the client-supplied header.
  real_ip_header X-Forwarded-For;
  set_real_ip_from 127.0.0.1;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

A sample file lives at `docs/nginx.example.conf`.

### TRUST_PROXY values

The `TRUST_PROXY` env var on the faucet side controls how Express's
`req.ip` is derived. It accepts:

- `false` (default if unset) — direct hosting, no proxy. `req.ip` is the
  TCP peer.
- `loopback` — nginx is on the same host. Express trusts
  `X-Forwarded-For` only when the immediate peer is loopback. **The
  default and the recommended setting.**
- `<CIDR>` (e.g., `10.0.0.0/8`, `192.168.0.0/16`) — trust the header
  only if the peer is inside that range. Use when nginx is on a different
  host in a private network.
- `true` — trust the header unconditionally. **Insecure if the service
  is exposed to the open internet.** Use only for tightly-controlled
  internal deployments.

## Rate limiting

- 2 drips per IP per rolling 24 h.
- IPv4: each literal IP is its own bucket.
- IPv6: the first `/48` of the address is its own bucket
  (RFC 6177 site boundary; configurable via the `IPV6_BUCKET_PREFIX` env,
  not yet wired into the example env file).
- State is in-process in RAM. Restarting the service resets the counters —
  acceptable for a small testnet service.
- `X-Forwarded-For` is honored when `TRUST_PROXY=loopback` and nginx
  rewrites the header (see nginx block above).

## Drip formula

Each drip is `0.1%` of the faucet's current self-balance, with the
transaction fee taken out of the same 0.1%:

```
recipientAmount = floor( selfBalance * 0.001 - txFee )
```

- `DRIP_PERCENT` env (default `0.1`) controls the percent of the reserve
  given away per drip.
- `TX_FEE` env (default `0.001`) is the network fee the faucet pays on
  every drip.
- If the result is ≤ 0 (the reserve is too small), the drip is refused
  with `503 { ok:false, error:"drip too small" }`.

## Balance polling

The faucet's balance is fetched periodically from the node:

```
GET {NODE_URL}/account/{faucetAddress}/wart_balance
```

- Default interval: `BALANCE_POLL_MS=60000` (one minute).
- State is in-process in RAM. No disk, no database, no external cache.
- Response shape (testnet):

  ```json
  {
    "code": 0,
    "data": {
      "account": { "accountId": 9, "address": "..." },
      "wart": {
        "locked":   { "E8": 0, "str": "0" },
        "mempool":  { "E8": 0, "str": "0" },
        "total":    { "E8": 400097559, "str": "4.00097559" }
      }
    }
  }
  ```

  The faucet reads `data.wart.total.str` (8-decimal decimal string).
- If a drip request lands while the cached balance is older than
  `BALANCE_POLL_MS * 2`, the handler forces a synchronous poll before
  computing the drip. Users never see a stale balance.
- The boot path **awaits the first balance poll** before
  `app.listen()` accepts connections. If `NODE_URL` is unreachable or
  returns an unexpected response shape, the service exits with a clear
  error and a non-zero code — so a misconfigured deployment fails fast
  rather than silently serving a misleading landing page.
- `NODE_ENV` controls the dev/prod default for `NODE_URL` and `CORS_ORIGIN`.
  `npm run dev` (and the dev script) sets `NODE_ENV=development`; in that
  mode a missing `NODE_URL` falls back to
  `https://warthog-defitestnet.duckdns.org/` and the CORS list
  defaults to the website's origin plus the common local dev ports.
  `npm start` (or any process with `NODE_ENV=production`) requires
  `NODE_URL` to be set explicitly; a missing value fails fast at boot.

## API contract

- `GET /api/status` —

  ```json
  {
    "ok": true,
    "faucetAddress": "2de77d5e23dc63e4...",
    "reserve": "4.00097559",
    "network": "testnet",
    "node": "https://warthog-defitestnet.duckdns.org/account/.../wart_balance",
    "lastBalanceCheckAt": "2026-01-01T12:00:00.000Z",
    "dripPercent": 0.1,
    "dripsLast24h": 1
  }
  ```

- `POST /api/drip` body `{ "address": "WART..." }` —

  Success:

  ```json
  {
    "ok": true,
    "txId": "ab12cd34...",
    "amount": "0.00400097",
    "reserveBefore": "4.00097559",
    "reserveAfter": "3.99597462",
    "explorerUrl": "https://warthog-defitestnet.duckdns.org/tx/ab12cd34..."
  }
  ```

  Errors:

  - `400 { ok:false, error:"invalid address" }`
  - `429 { ok:false, error:"rate limited", retryAfterSeconds: <int> }`
  - `500 { ok:false, error:"tx broadcast failed: <reason>" }`
  - `503 { ok:false, error:"node unreachable" }`
  - `503 { ok:false, error:"no testnet node reachable" }`
  - `503 { ok:false, error:"drip too small" }`

- `GET /api/status` includes a `health` sub-shape with `up`, `uptimeSec`, and `nodeReachable` so monitoring tools don't need a separate endpoint.

## Landing page

`GET /` returns a self-contained HTML page with:

- A recipient-address input + "Request 0.1%" button.
- A copyable faucet-address row with a server-rendered QR.
- The single line: "Send testnet WART to this address to keep the faucet topped up."

The page makes no third-party requests and embeds the QR as a data URL.

## Operational notes

- **One process, one host.** The repo's design assumes a single instance
  per host. If you ever need to scale out, run additional hosts with
  their own private keys (each becomes a separate faucet with its own
  reserve) rather than clustering.
- **Restarting the service resets in-memory state.** Acceptable for
  this small service: balance cache re-polls on the next tick, rate
  limit counters reset. The faucet's WART balance on the network is
  unaffected.
- **Topping up the reserve.** The operator sends more testnet WART to
  the faucet's address. No admin endpoint — donation is just a normal
  transfer.
- **Logs.** Structured JSON via `pino`. Pipe to journald, Loki, or a
  file. `LOG_LEVEL=debug` for verbose.
