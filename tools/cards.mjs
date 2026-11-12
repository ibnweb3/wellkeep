// Generates the DEMO household cards (fictional village, random codes) and the public leaf list.
//   node tools/cards.mjs <households> <slots>
// Writes demo/cards.json (the printed cards: codes are secret in real life) and
// demo/leaves.json (public: only hashes, plus the Merkle root that goes on-chain).
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { leafHash, buildLevels, toHex } from "../web/public/merkle.js";

const households = Number(process.argv[2] ?? 30);
const slots = Number(process.argv[3] ?? 6);
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I so cards are easy to read
const code = () => [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join("");

const cards = [];
const leaves = [];
for (let hh = 0; hh < households; hh++) {
  const rows = [];
  for (let slot = 0; slot < slots; slot++) {
    const row = { report: code(), yes: code(), no: code() };
    rows.push(row);
    leaves.push(await leafHash(hh, slot, 0, row.report));
    leaves.push(await leafHash(hh, slot, 1, row.yes));
    leaves.push(await leafHash(hh, slot, 2, row.no));
  }
  cards.push({ hh, rows });
}
const levels = await buildLevels(leaves);
const root = toHex(levels[levels.length - 1][0]);
writeFileSync("demo/cards.json", JSON.stringify({ note: "DEMO cards for a fictional village. Random codes, no real people.", households, slots, cards }, null, 1));
writeFileSync("demo/leaves.json", JSON.stringify({ households, slots, root, leaves: leaves.map(toHex) }));
console.log(JSON.stringify({ households, slots, leaves: leaves.length, root }));
