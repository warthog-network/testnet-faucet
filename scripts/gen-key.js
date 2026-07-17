// scripts/gen-key.js
//
// `npm run gen-key` — prints the priv key (env-var line) plus the derived
// address (comment, for the operator's reference).

import { Account } from "warthog-js";

const acc = Account.fromRandom();

process.stdout.write(`FAUCET_HEX_PRIVKEY=${acc.privateKeyHex}\n`);
process.stdout.write(`# Faucet address (derived from the priv key above): ${acc.address.hex}\n`);
