// Offline tests for the card codes. They pin the hash format shared with the contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { leafHash, buildLevels, proofFor, leafIndex, fromHex, toHex, ACTIONS } from "../web/public/merkle.js";

const leaves = JSON.parse(readFileSync("web/public/demo/leaves.json", "utf8"));
const cards = JSON.parse(readFileSync("web/public/demo/cards.json", "utf8"));
const sha = (b) => new Uint8Array(createHash("sha256").update(b).digest());

test("leaf hash matches the golden vector pinned in the Rust tests", async () => {
  const h = await leafHash(3, 2, ACTIONS.yes, "ABCD");
  assert.equal(toHex(h), "f762184b282337d09cf8eed8e089aeb632b1757f103f7d9cb6bf257095c0d77d");
});

test("every card code verifies against the on-chain root (same algorithm as the contract)", async () => {
  const levels = await buildLevels(leaves.leaves.map(fromHex));
  const root = toHex(levels[levels.length - 1][0]);
  assert.equal(root, leaves.root);
  const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  let checked = 0;
  for (const card of cards.cards) {
    for (let slot = 0; slot < leaves.slots; slot++) {
      for (const [name, action] of [["report", 0], ["yes", 1], ["no", 2]]) {
        let h = await leafHash(card.hh, slot, action, card.rows[slot][name]);
        for (const p of proofFor(levels, leafIndex(card.hh, slot, action, leaves.slots))) {
          const [lo, hi] = cmp(h, p) <= 0 ? [h, p] : [p, h];
          h = sha(Buffer.concat([Buffer.from(lo), Buffer.from(hi)]));
        }
        assert.equal(toHex(h), root, `hh-${card.hh} slot ${slot} ${name}`);
        checked++;
      }
    }
  }
  assert.equal(checked, leaves.households * leaves.slots * 3);
});

test("a code from the wrong action or wrong household does not verify", async () => {
  const levels = await buildLevels(leaves.leaves.map(fromHex));
  // household 1's "works" code, presented as household 2's "works" code, must not hash into the root
  const h = await leafHash(2, 0, ACTIONS.yes, cards.cards[1].rows[0].yes);
  assert.ok(!levels[0].some((l) => toHex(l) === toHex(h)));
  const h2 = await leafHash(1, 0, ACTIONS.report, cards.cards[1].rows[0].yes);
  assert.ok(!levels[0].some((l) => toHex(l) === toHex(h2)));
});
