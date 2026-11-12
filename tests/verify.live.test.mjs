// Live testnet tests for the "Check before you give" logic. Skipped when offline (BOREHOLE_OFFLINE=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runChecks } from "../web/src/verify-core.js";

const skip = process.env.BOREHOLE_OFFLINE === "1" ? "offline" : false;
const pub = JSON.parse(readFileSync("evidence/publish.json", "utf8"));
const RPC = process.env.RPC_URL || "https://test.rpc.fastnear.com";
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  if (String(u) === "local:wasm") return new Response(readFileSync("evidence/borehole_pool.wasm"));
  if (String(u) === "local:state") return new Response(readFileSync("evidence/state-init.json"));
  return realFetch(u, o);
};
const run = (poolId) => runChecks({ rpcUrl: RPC, poolId, wasmUrl: "local:wasm", stateUrl: "local:state" });
const byId = (rs) => Object.fromEntries(rs.map((r) => [r.id, r.ok]));

test("the real pool passes every check", { skip }, async () => {
  const r = await run(pub.poolId);
  assert.deepEqual(byId(r), { account: true, keys: true, byhash: true, wasm: true, chaincode: true, address: true, rules: true });
});

test("negative control: the same code deployed the ordinary way (key held, no hash reference) fails", { skip }, async () => {
  // A throwaway account created while testing: it runs the same wasm but has a full-access key.
  const r = await run("bh-scratch2.bh-deployer-1113.testnet");
  const ok = byId(r);
  assert.equal(ok.account, true);
  assert.equal(ok.keys, false, "a key exists, so the check must fail");
  assert.equal(ok.byhash, false, "not referenced by hash, so the check must fail");
  assert.equal(ok.address, false, "the address was not derived from the code, so the check must fail");
});

test("a made-up address fails at the first step", { skip }, async () => {
  const r = await run("0s0000000000000000000000000000000000000000");
  assert.equal(r[0].ok, false);
});
