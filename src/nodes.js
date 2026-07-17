// src/nodes.js
//
// Testnet node discovery. At startup, fetches the public defi testnet node list
// from data.warthog.network/defi-nodes.json and caches it. Used as a fallback
// for the testnet faucet when NODE_URL is not explicitly set.

const CACHE_TTL_MS = 5 * 60 * 1000;

let _cache = { urls: [], expiresAt: 0 };
let _inflight = null;

async function fetchFromPublicData() {
  const url = "https://data.warthog.network/defi-nodes.json";
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const urls = Array.isArray(body?.nodes)
    ? body.nodes.map((n) => n?.url).filter((u) => typeof u === "string")
    : [];
  return urls;
}

const FALLBACK = [
  // Hardcoded safety net. Source: data.warthog.network/defi-nodes.json at
  // startup; this is only used if the public data source is unreachable and
  // NODE_URL is unset.
  "https://warthog-defitestnet.duckdns.org/",
];

async function urls() {
  const now = Date.now();
  if (_cache.expiresAt > now) return _cache.urls;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const fresh = await fetchFromPublicData();
      _cache = { urls: fresh.length > 0 ? fresh : FALLBACK, expiresAt: now + CACHE_TTL_MS };
    } catch {
      _cache = { urls: FALLBACK, expiresAt: now + CACHE_TTL_MS };
    } finally {
      _inflight = null;
    }
    return _cache.urls;
  })();
  return _inflight;
}

async function pickHealthy() {
  // Returns the first URL that responds 200 to GET /chain/head within 3s.
  // Order: explicit NODE_URL first, then discovered/fallback URLs.
  const candidates = [];
  if (process.env.NODE_URL) candidates.push(process.env.NODE_URL);
  const list = await urls();
  for (const u of list) {
    if (!candidates.includes(u)) candidates.push(u);
  }
  for (const u of candidates) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3_000);
      const r = await fetch(`${u.replace(/\/$/, "")}/chain/head`, {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.ok) return u.replace(/\/$/, "");
    } catch {
      // try next
    }
  }
  return null;
}

export const nodes = { urls, pickHealthy };
