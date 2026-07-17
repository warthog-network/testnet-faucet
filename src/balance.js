// src/balance.js
//
// In-RAM balance cache. Polls the public testnet node's
//   GET /account/{selfAddress}/wart_balance
// on a fixed interval and stores the result. The /api/drip handler reads
// the cache synchronously, refreshing if it's older than 2x the poll interval.
//
// No persistent storage. Pure in-memory. Resets on process restart — that's
// fine because the data is recomputed from the node, not derived from a
// counter on disk.

import { config } from "./config.js";

const POLL_TIMEOUT_MS = 5_000;

let _last = {
  reserve: null,        // decimal string (e.g. "4.00097559")
  checkedAt: 0,          // epoch ms of last successful poll
  node: null,            // node URL that produced the last value
  error: null,           // last error message, or null
};

let _timer = null;

async function poll() {
  if (!config.nodeUrl) {
    _last = { ..._last, error: "NODE_URL not configured", checkedAt: Date.now() };
    return _last;
  }
  const url = `${config.nodeUrl.replace(/\/$/, "")}/account/${config.faucetAddress}/wart_balance`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body?.code !== 0) throw new Error(`node code ${body?.code}`);
    const totalStr = body?.data?.wart?.total?.str;
    if (typeof totalStr !== "string") throw new Error("unexpected response shape");
    if (!/^\d+(\.\d{1,8})?$/.test(totalStr)) {
      throw new Error(`malformed wart balance: ${totalStr}`);
    }
    // Record the bare node URL (no path) so /api/status exposes a clean
    // "node" field, not the full balance endpoint.
    _last = { reserve: totalStr, checkedAt: Date.now(), node: config.nodeUrl, error: null };
  } catch (err) {
    _last = { ..._last, error: String(err?.message ?? err), checkedAt: Date.now() };
  }
  return _last;
}

function isStale(snapshot) {
  if (!snapshot.reserve) return true;
  if (Date.now() - snapshot.checkedAt > config.balancePollMs * 2) return true;
  return false;
}

async function getFresh() {
  if (isStale(_last)) {
    await poll();
  }
  return _last;
}

function get() {
  return _last;
}

async function start() {
  if (_timer) return;
  // First poll completes before the timer starts so the cache is warm
  // before app.listen() accepts the first request. If the first poll
  // fails (e.g. NODE_URL unreachable or unexpected response), boot fails
  // fast: better than silently serving a misleading landing page.
  const first = await poll();
  if (first?.error) {
    throw new Error(
      `first balance poll failed: ${first.error} (NODE_URL=${config.nodeUrl || "<unset>"})`,
    );
  }
  if (_timer) return; // re-check: a concurrent start() may have set it
  _timer = setInterval(poll, config.balancePollMs);
}

function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

export const balance = { get, getFresh, poll, start, stop };
