// src/server.js
//
// Express app for the testnet faucet. Four routes:
//
//   GET  /              — landing page: address form + copyable donation row
//   POST /api/drip       — drip 0.1% of self-balance (minus fee) to a recipient
//   GET  /api/status     — faucet address, current reserve, network, freshness
//   GET  /api/status    — faucet state + `health` sub-shape (uptime, node reachability)
//
// IP detection honors TRUST_PROXY (false | loopback | <CIDR> | true), default
// loopback. CORS is closed-allowlist (https://warthog.network + localhost:4321
// for dev). The faucet's own address is computed at boot from FAUCET_HEX_PRIVKEY
// and is never hard-coded in any file.

import express from "express";
import cors from "cors";
import pino from "pino";
import pinoHttp from "pino-http";

import { config } from "./config.js";
import { balance } from "./balance.js";
import { ratelimit } from "./ratelimit.js";
import { nodes } from "./nodes.js";
import { drip } from "./faucet.js";
import { toDataUrl } from "./qr.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.use(pinoHttp({ logger: log }));
app.use(express.json({ limit: "8kb" }));
app.use(express.static("public"));
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Reverse-proxy posture. See README "TRUST_PROXY" section.
applyTrustProxy(app);

// CORS allowlist (configurable via CORS_ORIGIN env).
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`origin not allowed: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type"],
  }),
);

// ---------- Routes ----------

// Landing page: address form + copyable donation row with QR.
app.get("/", async (req, res) => {
  const addr = config.faucetAddress;
  const reserve = balance.get().reserve;
  // Same drip math as the live API: 0.1% of self-balance minus the tx fee.
  // The reserve is a string; treat the drip calc the same way the server
  // does so the landing page never advertises a value the API would refuse.
  const dripDisplay = computeDripDisplay(reserve);
  const qrDataUrl = await toDataUrl(addr, { width: 256, margin: 2 });
  res.set("content-type", "text/html; charset=utf-8");
  res.send(renderLandingPage({ address: addr, reserve, dripDisplay, qrDataUrl }));
});

// API: drip 0.1% of self-balance to a recipient.
app.post("/api/drip", async (req, res) => {
  const address = (req.body?.address ?? "").trim();
  const ip = req.ip || "unknown";
  const result = await drip({ address, ip });
  res.status(result.status).json(result.body);
});

// API: status. The `health` sub-shape reports process liveness and node
// reachability so monitoring tools don't need a separate endpoint.
app.get("/api/status", (req, res) => {
  const b = balance.get();
  res.json({
    faucetAddress: config.faucetAddress,
    reserve: b.reserve,
    node: b.node ?? config.nodeUrl ?? null,
    lastBalanceCheckAt: b.checkedAt ? new Date(b.checkedAt).toISOString() : null,
    dripPercent: config.dripPercent,
    dripsLast24h: ratelimit.countLastWindow(req.ip || "unknown"),
    health: {
      up: true,
      uptimeSec: Math.round(process.uptime()),
      nodeReachable: !b.error,
    },
  });
});

function applyTrustProxy(app) {
  switch (config.trustProxy) {
    case "false":
    case "":
      app.set("trust proxy", false);
      break;
    case "loopback":
      app.set("trust proxy", "loopback");
      break;
    case "true":
      app.set("trust proxy", true);
      break;
    default:
      // Treat as a CIDR or numeric hop count.
      app.set("trust proxy", config.trustProxy);
  }
}

function renderLandingPage({ address, reserve, dripDisplay, qrDataUrl }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0a0d14" />
<title>Warthog Testnet Faucet</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="alternate icon" type="image/png" href="/favicon.png" />
<link rel="apple-touch-icon" href="/favicon.png" />
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 38rem; margin: 3rem auto; padding: 0 1.25rem; color: #e6e8ec; background: #0a0d14; }
  h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
  p.muted { color: #8a93a4; margin: 0 0 1.5rem; }
  section { background: #11151f; border: 1px solid #1f2533; border-radius: 0.75rem; padding: 1.25rem; margin: 1rem 0; }
  label { display: block; font-size: 0.85rem; color: #b8bfcc; margin: 0 0 0.35rem; }
  input, button { font: inherit; padding: 0.55rem 0.7rem; border-radius: 0.45rem; border: 1px solid #2a3142; background: #0a0d14; color: #e6e8ec; }
  input { width: 100%; box-sizing: border-box; }
  button { cursor: pointer; background: #facc15; color: #0a0d14; border-color: #facc15; font-weight: 600; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .addr { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; word-break: break-all; background: #0a0d14; padding: 0.55rem 0.7rem; border-radius: 0.45rem; border: 1px solid #2a3142; }
  .row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .qr { width: 192px; height: 192px; background: #fff; padding: 6px; border-radius: 0.4rem; }
  pre { background: #0a0d14; padding: 0.7rem; border-radius: 0.45rem; border: 1px solid #2a3142; overflow: auto; font-size: 0.8rem; }
  .err { color: #ff6b6b; }
  .ok { color: #6ee787; }
</style>
</head>
<body>
  <h1>Warthog Testnet Faucet</h1>
  <p class="muted">
    Get 0.1% of its current reserves of testnet WART to a requesting address. 2 drips per IP per 24 h.
    <strong>Reserve: ${escapeHtml(reserve ?? "balance not yet polled")} WART</strong>
    <strong>Drip: ${escapeHtml(dripDisplay ?? "—")} WART</strong>
  </p>

  <section>
    <label for="addr">Recipient testnet WART address</label>
    <input id="addr" name="addr" placeholder="WART..." autocomplete="off" />
    <div style="height: 0.6rem"></div>
    <button id="drip">Get ${escapeHtml(dripDisplay ?? "—")} WART</button>
    <div style="height: 0.8rem"></div>
    <pre id="out" hidden></pre>
  </section>

  <section>
    <p>Send testnet WART to this address to keep the faucet topped up.</p>
    <div class="row">
      <code class="addr" id="faucet">${escapeHtml(address)}</code>
      <button id="copy">Copy</button>
    </div>
    <div style="height: 0.8rem"></div>
    <img class="qr" alt="QR for faucet address" src="${qrDataUrl}" />
  </section>

  <script>
    const addrEl = document.getElementById("addr");
    const btn = document.getElementById("drip");
    const out = document.getElementById("out");
    const faucetEl = document.getElementById("faucet");
    document.getElementById("copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(faucetEl.textContent.trim()); }
      catch {}
    });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      out.hidden = false;
      out.className = "";
      out.textContent = "Requesting...";
      try {
        const r = await fetch("/api/drip", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address: addrEl.value.trim() }),
        });
        const body = await r.json();
        out.className = body.ok ? "ok" : "err";
        if (body.ok) {
          out.textContent = "txId: " + body.txId + "\\nreserved after: " + body.reserveAfter;
        } else if (body.error === "rate limited") {
          out.textContent = "Rate limited. Retry in " + body.retryAfterSeconds + "s.";
        } else {
          out.textContent = "Error: " + (body.error || r.statusText);
        }
      } catch (e) {
        out.className = "err";
        out.textContent = "Error: " + e.message;
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Same decimal math as src/faucet.js: floor( selfBalance * (DRIP_PERCENT/100) - txFee ).
// We avoid importing faucet.js to keep the landing-page path light. If the
// balance is not yet polled, returns null so the template can render "—".
function computeDripDisplay(reserveStr) {
  if (!reserveStr || typeof reserveStr !== "string") return null;
  if (!/^\d+(\.\d{1,8})?$/.test(reserveStr)) return null;
  const [aInt, aFrac = ""] = reserveStr.split(".");
  const [bInt, bFrac = ""] = config.txFee.split(".");
  const scale = 10n ** 8n;
  const reserve = BigInt(aInt) * scale + BigInt((aFrac + "0".repeat(8)).slice(0, 8));
  const fee = BigInt(bInt) * scale + BigInt((bFrac + "0".repeat(8)).slice(0, 8));
  const factor = BigInt(Math.round(config.dripPercent * 100)); // 0.1 -> 10
  const product = (reserve * factor) / 100n;
  const afterFee = product > fee ? product - fee : 0n;
  if (afterFee <= 0n) return "0";
  const intPart = afterFee / scale;
  const fracPart = (afterFee % scale).toString().padStart(8, "0");
  return `${intPart}.${fracPart}`;
}

// Boot path: the first balance poll must complete before the server
// accepts connections. If NODE_URL is unreachable or returns an
// unexpected response, the boot fails fast with a clear log line and a
// non-zero exit code — better than silently serving a misleading
// "balance not yet polled" landing page.
balance.start().then(() => {
  const server = app.listen(config.port, () => {
    process.stdout.write(
      `testnet-faucet listening on http://0.0.0.0:${config.port}  (faucet: ${config.faucetAddress})\n`,
    );
    log.info(
      { port: config.port, faucetAddress: config.faucetAddress },
      "testnet-faucet listening",
    );
  });
}).catch((err) => {
  process.stderr.write(`testnet-faucet failed to start: ${err?.message ?? err}\n`);
  log.error({ err }, "testnet-faucet failed to start");
  process.exit(1);
});

let server;
function shutdown(sig) {
  log.info({ sig }, "shutting down");
  balance.stop();
  ratelimit.stopGc();
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
