// src/faucet.js
//
// Core drip logic. Pure function over the dependencies (balance cache,
// rate limiter, node picker). The HTTP handler in server.js calls drip().
//
// Drip formula:
//   recipientAmount = floor( selfBalance * (DRIP_PERCENT/100) - TX_FEE )
// If recipientAmount <= 0, the request is refused with 503.

import { config } from "./config.js";
import { balance } from "./balance.js";
import { ratelimit } from "./ratelimit.js";
import { nodes } from "./nodes.js";

const POLL_TIMEOUT_MS = 6_000;

function bigMul(a, b) {
  // a and b are decimal strings. Multiply exactly using BigInt at 8-decimal
  // resolution (matches the WART currency). Returns a decimal string.
  const A = a.includes(".") ? a : `${a}.0`;
  const B = b.includes(".") ? b : `${b}.0`;
  const [aInt, aFrac = ""] = A.split(".");
  const [bInt, bFrac = ""] = B.split(".");
  const scale = 10n ** 8n;
  const aBi = BigInt(aInt) * scale + BigInt((aFrac + "0".repeat(8)).slice(0, 8));
  const bBi = BigInt(bInt) * scale + BigInt((bFrac + "0".repeat(8)).slice(0, 8));
  const product = aBi * bBi;
  const intPart = product / (scale * scale);
  const fracPart = product % (scale * scale);
  const fracStr = fracPart.toString().padStart(16, "0").slice(0, 8);
  return `${intPart}.${fracStr}`;
}

function bigFloor(a) {
  // a is a decimal string. floor() for non-negative values.
  if (!a.includes(".")) return a;
  const [intPart, fracPart] = a.split(".");
  if (fracPart.replace(/0+$/, "") === "") return intPart;
  return BigInt(intPart) < 0n ? intPart : (BigInt(intPart) + 1n - 1n).toString();
}

function formatDecimal(intPart, fracPart) {
  return `${intPart}.${fracPart}`;
}

async function broadcast(nodeUrl, rawTx) {
  // rawTx is the JSON-ready wartTransfer object the SDK will produce.
  // For now we use the same /transaction/add endpoint the explorer / wallet
  // flow uses. The exact wire format is dictated by warthog-js; we trust it.
  const url = `${nodeUrl}/transaction/add`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(rawTx),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function drip({ address, ip }) {
  // 1. Rate-limit check.
  if (!ratelimit.check(ip)) {
    return {
      status: 429,
      body: {
        ok: false,
        error: "rate limited",
        retryAfterSeconds: ratelimit.retryAfterSeconds(ip),
      },
    };
  }

  // 2. Validate recipient address.
  let recipientAddr;
  try {
    recipientAddr = config.account.address.constructor; // placeholder reference
  } catch {
    /* not used */
  }
  // Use the SDK's Address to parse + checksum the input.
  const { Address } = await import("warthog-js");
  let parsedAddr;
  try {
    parsedAddr = Address.fromHex(address);
  } catch {
    return { status: 400, body: { ok: false, error: "invalid address" } };
  }
  if (!parsedAddr) {
    return { status: 400, body: { ok: false, error: "invalid address" } };
  }

  // 3. Refresh balance if stale.
  const b = await balance.getFresh();
  if (b.error || !b.reserve) {
    return { status: 503, body: { ok: false, error: "node unreachable" } };
  }

  // 4. Compute drip amount. 0.1% of self-balance, fee out of the 0.1%.
  const dripPercent = config.dripPercent; // e.g. 0.1
  const txFee = config.txFee;             // decimal string e.g. "0.001"
  const reserveBefore = b.reserve;
  const product = bigMul(reserveBefore, dripPercent.toString());
  // product is reserve * dripPercent (in fixed-point). We want product / 100
  // (since dripPercent is in percent). Then subtract txFee.
  const beforeFee = bigFloor(divideBy100(product));
  const amount = subtract(beforeFee, txFee);
  if (amountIsZeroOrNegative(amount)) {
    return { status: 503, body: { ok: false, error: "drip too small" } };
  }

  // 5. Pick a healthy testnet node.
  const nodeUrl = await nodes.pickHealthy();
  if (!nodeUrl) {
    return { status: 503, body: { ok: false, error: "no testnet node reachable" } };
  }

  // 6. Build the wartTransfer via warthog-js. We import lazily so the
  //    top-level require stays small.
  const { TransactionContext } = await import("warthog-js");
  const ctx = new TransactionContext(config.network);
  const txReq = await ctx.wartTransfer({
    sender: config.account,
    recipient: parsedAddr,
    amount,
    fee: txFee,
  });

  // 7. Broadcast.
  let result;
  try {
    result = await broadcast(nodeUrl, txReq);
  } catch (err) {
    return { status: 500, body: { ok: false, error: `tx broadcast failed: ${err?.message ?? err}` } };
  }
  if (result?.success === false) {
    return { status: 500, body: { ok: false, error: result?.error ?? "node rejected tx" } };
  }
  const txId = result?.txId ?? result?.signedSnapshot?.txId;
  if (!txId) {
    return { status: 500, body: { ok: false, error: "no txId in response" } };
  }

  // 8. Record the drip for the rate limiter.
  ratelimit.record(ip);

  // 9. Compute reserveAfter.
  const reserveAfter = subtract(reserveBefore, amount);
  const reserveAfterNum = subtract(reserveAfter, txFee);

  return {
    status: 200,
    body: {
      ok: true,
      txId,
      amount,
      reserveBefore,
      reserveAfter: reserveAfterNum,
      explorerUrl: `https://warthog-defitestnet.duckdns.org/tx/${txId}`,
    },
  };
}

function divideBy100(a) {
  // decimal string a / 100
  // Move decimal point two places to the left, with floor.
  if (!a.includes(".")) {
    return a.length < 2 ? "0" : a.slice(0, a.length - 2);
  }
  const [intPart, fracPart] = a.split(".");
  const combined = (intPart + fracPart).replace(/^0+/, "") || "0";
  // We want floor(combined / 100) at the 8-decimal resolution.
  const padLen = combined.length + 2;
  const padded = combined.padStart(padLen, "0");
  const cutAt = padded.length - 2;
  const intOut = padded.slice(0, cutAt) || "0";
  const fracOut = padded.slice(cutAt);
  // Strip leading zeros from intOut.
  const intClean = intOut.replace(/^0+/, "") || "0";
  return fracOut === "0".repeat(8) ? intClean : `${intClean}.${fracOut}`;
}

function subtract(a, b) {
  // decimal a - decimal b, both non-negative
  const A = a.includes(".") ? a : `${a}.0`;
  const B = b.includes(".") ? b : `${b}.0`;
  const [aInt, aFrac = ""] = A.split(".");
  const [bInt, bFrac = ""] = B.split(".");
  const aBi = BigInt(aInt) * 10n ** 8n + BigInt((aFrac + "0".repeat(8)).slice(0, 8));
  const bBi = BigInt(bInt) * 10n ** 8n + BigInt((bFrac + "0".repeat(8)).slice(0, 8));
  const diff = aBi - bBi;
  if (diff <= 0n) return "0";
  const intPart = diff / 10n ** 8n;
  const fracPart = (diff % 10n ** 8n).toString().padStart(8, "0");
  return `${intPart}.${fracPart}`;
}

function amountIsZeroOrNegative(a) {
  // decimal string a; treat "0" or "0.000..." as zero / negative
  if (a === "0") return true;
  const [intPart, fracPart = ""] = a.split(".");
  if (intPart === "0" && /^0*$/.test(fracPart)) return true;
  return false;
}
