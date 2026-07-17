// src/ratelimit.js
//
// Per-IP sliding-window rate limit. In-memory only. State is per-process; if
// the faucet is restarted, counters reset — that's acceptable for a small
// testnet service.
//
// Bucket key:
//   - IPv4: the literal address
//   - IPv6:   the first /48 of the address (RFC 6177 site boundary; configurable)
//   - If the IP comes from X-Forwarded-For (express's `req.ip` is set by
//     `app.set('trust proxy', ...)), the leftmost entry is honored.
//
// Memory bound:
//   The map can otherwise grow unbounded under burst traffic (DDoS, IPv6
//   prefix-scan, scanner). Two defenses:
//     1. A hard cap on the number of distinct keys (RATELIMIT_MAX_KEYS,
//        default 1000). When the cap is exceeded, the oldest key is
//        dropped until size is back at the cap. This bounds memory to
//        O(cap * window-size-per-bucket).
//     2. A periodic GC sweep (every GC_INTERVAL_MS, default 5 min) that
//        drops keys whose entries are all outside the current window —
//        handles long-tail traffic where each bucket is eventually
//        emptied naturally.

import { config } from "./config.js";

// Hardcoded memory bounds. Not exposed as env vars — the operator doesn't
// need to think about this; the values are tuned for the testnet service's
// expected load. If you fork the faucet for a much bigger deployment,
// change them here.
const MAX_KEYS = 1000;       // hard cap on distinct IP keys in the map
const GC_INTERVAL_MS = 5 * 60_000;  // sweep expired keys every 5 minutes

const BUCKETS = new Map(); // bucketKey -> number[] (epoch-ms timestamps, ascending)

function bucketKey(ip) {
  if (!ip) return "unknown";
  if (ip.includes(":")) {
    // IPv6: keep the first /N bits
    const prefix = config.ipv6BucketPrefix ?? 48;
    const parts = ip.split(":");
    // Heuristic: 48-bit prefix is 3 groups of 16 bits -> 3 colon-separated groups.
    const groups = Math.ceil(prefix / 16);
    return `v6/${parts.slice(0, groups).join(":")}/${prefix}`;
  }
  return `v4/${ip}`;
}

function prune(arr, now) {
  const cutoff = now - config.windowMs;
  return arr.filter((ts) => ts > cutoff);
}

function evictIfOverCap() {
  // Map iteration order is insertion order, so the oldest keys are at
  // the front. Drop from the front until we are at the cap.
  while (BUCKETS.size > MAX_KEYS) {
    const oldestKey = BUCKETS.keys().next().value;
    if (oldestKey === undefined) break;
    BUCKETS.delete(oldestKey);
  }
}

function gc(now = Date.now()) {
  // Drop keys whose entire array is expired. This bounds long-tail growth
  // for one-off IPs that never come back.
  for (const [key, arr] of BUCKETS) {
    if (arr.length === 0 || arr[arr.length - 1] <= now - config.windowMs) {
      BUCKETS.delete(key);
    }
  }
}

function check(ip, now = Date.now()) {
  const key = bucketKey(ip);
  const arr = prune(BUCKETS.get(key) || [], now);
  BUCKETS.set(key, arr);
  evictIfOverCap();
  return arr.length < config.rateLimit;
}

function record(ip, now = Date.now()) {
  const key = bucketKey(ip);
  const arr = prune(BUCKETS.get(key) || [], now);
  arr.push(now);
  BUCKETS.set(key, arr);
  evictIfOverCap();
}

function countLastWindow(ip, now = Date.now()) {
  return prune(BUCKETS.get(bucketKey(ip)) || [], now).length;
}

function retryAfterSeconds(ip, now = Date.now()) {
  const key = bucketKey(ip);
  const arr = prune(BUCKETS.get(key) || [], now);
  if (arr.length < config.rateLimit) return 0;
  const oldest = arr[0];
  const seconds = Math.ceil((oldest + config.windowMs - now) / 1000);
  return Math.max(seconds, 1);
}

let _gcTimer = null;
function startGc() {
  if (_gcTimer) return;
  _gcTimer = setInterval(gc, GC_INTERVAL_MS);
}
function stopGc() {
  if (_gcTimer) clearInterval(_gcTimer);
  _gcTimer = null;
}

// Test-only export: clear the in-memory state.
function _reset() {
  BUCKETS.clear();
}

export const ratelimit = {
  check, record, countLastWindow, retryAfterSeconds, startGc, stopGc, _reset,
  // Exposed for inspection / tests.
  _size: () => BUCKETS.size,
};
