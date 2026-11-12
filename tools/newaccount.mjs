// Creates a TESTNET account via the public testnet helper and stores its key in .keys/ (gitignored).
//   node tools/newaccount.mjs <name>      (creates <name>.testnet)
import { generateKey } from "near-kit";
import { writeFileSync, existsSync } from "node:fs";

const name = process.argv[2];
if (!name) throw new Error("usage: node tools/newaccount.mjs <name>");
const id = `${name}.testnet`;
const file = `.keys/${id}.json`;
if (existsSync(file)) throw new Error(`${file} already exists`);
const key = generateKey();
const res = await fetch("https://helper.nearprotocol.com/account", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.publicKey.toString() }),
});
const text = await res.text();
console.log(res.status, text.slice(0, 300));
if (res.ok) writeFileSync(file, JSON.stringify({ accountId: id, publicKey: key.publicKey.toString(), privateKey: key.secretKey }));
