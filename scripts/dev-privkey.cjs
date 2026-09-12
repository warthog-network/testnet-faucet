// scripts/dev-privkey.cjs
//
// `npm run dev` pre-flight: invoked via `node --env-file=.env scripts/dev-privkey.cjs`
// so process.env already reflects .env. If FAUCET_HEX_PRIVKEY is set/non-blank
// there, exit silently. Otherwise, generate a throwaway key, print
// `FAUCET_HEX_PRIVKEY=<hex>` to stdout (consumed by bash), and warn on stderr.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.env.FAUCET_HEX_PRIVKEY && process.env.FAUCET_HEX_PRIVKEY.trim()) {
  process.exit(0);
}

const r = spawnSync(
  process.execPath,
  [path.join(__dirname, "gen-key.js")],
  { encoding: "utf8" },
);
if (r.status !== 0) {
  process.stderr.write(r.stderr);
  process.exit(r.status || 1);
}

const envLine = r.stdout.split("\n").find((l) => l.startsWith("FAUCET_HEX_PRIVKEY="));
const commentLine = r.stdout.split("\n").find((l) => l.startsWith("#"));

const hex = envLine.slice("FAUCET_HEX_PRIVKEY=".length);

process.stdout.write(hex + "\n");
process.stderr.write("[dev] no FAUCET_HEX_PRIVKEY in .env — generated a throwaway dev key.\n");
if (commentLine) process.stderr.write("[dev] " + commentLine.slice(1).trim() + "\n");
process.stderr.write("[dev] set FAUCET_HEX_PRIVKEY in .env (try `npm run gen-key`) to keep a stable dev identity.\n");
