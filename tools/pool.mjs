// Client for the pool contract (testnet). Used by the e2e script and the Worker's relayer.
import { readFileSync } from "node:fs";
import { buildLevels, credential, fromHex, ACTIONS } from "../web/public/merkle.js";

export async function loadCards() {
  const leaves = JSON.parse(readFileSync("web/public/demo/leaves.json", "utf8"));
  const cards = JSON.parse(readFileSync("docs/test-cards.json", "utf8"));
  const levels = await buildLevels(leaves.leaves.map(fromHex));
  return { levels, slots: leaves.slots, cards: cards.cards, root: leaves.root };
}

export function codeFor(cards, hh, slot, action) {
  const row = cards.cards[hh].rows[slot];
  return action === ACTIONS.report ? row.report : action === ACTIONS.yes ? row.yes : row.no;
}

export function cred(cards, hh, slot, action) {
  return credential(cards.levels, cards.slots, hh, slot, action, codeFor(cards, hh, slot, action));
}

const GAS = "150 Tgas";
export const call = (near, pool, method, args = {}, deposit) =>
  near.call(pool, method, args, { gas: GAS, ...(deposit ? { attachedDeposit: deposit } : {}) });
