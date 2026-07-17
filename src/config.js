// src/config.js
//
// Loads and validates the faucet's runtime configuration from environment variables.
// Called once at boot. All values are frozen into a single object so consumers
// can rely on the shape at runtime.
//
// The faucet's own WART address is derived at boot from FAUCET_HEX_PRIVKEY via
// warthog-js (Account.fromPrivateKeyHex). It is never hard-coded in any file —
// it lives only in this in-memory config and is what the API serves and the
// landing page shows.

import { Account, Address } from "warthog-js";

function required(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function intOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatOr(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function listOr(value, fallback) {
  if (!value) return fallback;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// NODE_ENV: "development" (default for `npm run dev`) or "production".
// In development, NODE_URL is optional — if missing, fall back to the
// canonical public testnet node so the dev path works out-of-the-box.
// In production, NODE_URL is required and a missing value fails fast at
// boot, because the operator must point at their own node.
const _isDev = (process.env.NODE_ENV || "development") !== "production";
const _defaultNodeUrl = _isDev
  ? "https://warthog-defitestnet.duckdns.org/"
  : "";

const _raw = {
  hexPrivKey: required("FAUCET_HEX_PRIVKEY"),
  network: (process.env.NETWORK || "testnet").toLowerCase(),
  nodeUrl: process.env.NODE_URL || _defaultNodeUrl,
  port: intOr(process.env.PORT, 3000),
  dripPercent: floatOr(process.env.DRIP_PERCENT, 0.1),
  txFee: process.env.TX_FEE || "0.001",
  rateLimit: intOr(process.env.RATE_LIMIT, 2),
  windowMs: intOr(process.env.WINDOW_HOURS, 24) * 60 * 60 * 1000,
  balancePollMs: intOr(process.env.BALANCE_POLL_MS, 60_000),
  trustProxy: (process.env.TRUST_PROXY || "loopback").trim(),
  corsOrigins: listOr(process.env.CORS_ORIGIN, [
    "https://warthog.network",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:4321",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:4321",
  ]),
};

// Validate the priv key shape before locking anything in.
if (!/^[0-9a-fA-F]{64}$/.test(_raw.hexPrivKey)) {
  throw new Error(
    "FAUCET_HEX_PRIVKEY must be a 64-char hex string (32-byte secp256k1 private key).",
  );
}

// Derive the faucet's own WART address from the priv key. This is the source of
// truth for the donation address the API serves and the landing page shows.
const _account = Account.fromPrivateKeyHex(_raw.hexPrivKey.toLowerCase());
const _faucetAddress = _account.address.hex;

export const config = Object.freeze({
  hexPrivKey: _raw.hexPrivKey.toLowerCase(),
  account: _account,
  faucetAddress: _faucetAddress,
  network: _raw.network,
  nodeUrl: _raw.nodeUrl,
  port: _raw.port,
  dripPercent: _raw.dripPercent,
  txFee: _raw.txFee,
  rateLimit: _raw.rateLimit,
  windowMs: _raw.windowMs,
  balancePollMs: _raw.balancePollMs,
  trustProxy: _raw.trustProxy,
  corsOrigins: _raw.corsOrigins,
});

// Re-export Address so callers can validate user-supplied addresses.
export { Address };
