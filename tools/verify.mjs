// Runs the same checks as the site's "Check before you give" button and records the evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { runChecks } from "../web/src/verify-core.js";

const pub = JSON.parse(readFileSync("evidence/publish.json", "utf8"));
const realFetch = globalThis.fetch;
// Serve the two local evidence files to the shared check code, exactly as the site serves them.
globalThis.fetch = async (u, o) => {
  const s = String(u);
  if (s === "local:wasm") return new Response(readFileSync("evidence/borehole_pool.wasm"));
  if (s === "local:state") return new Response(readFileSync("evidence/state-init.json"));
  return realFetch(u, o);
};
const results = await runChecks({
  rpcUrl: process.env.RPC_URL || "https://test.rpc.fastnear.com",
  poolId: pub.poolId,
  wasmUrl: "local:wasm",
  stateUrl: "local:state",
});
for (const r of results) console.log(r.ok ? "PASS" : "FAIL", "-", r.title, "|", r.detail);
writeFileSync(
  "evidence/verification.json",
  JSON.stringify({ checkedAt: new Date().toISOString(), network: "testnet", poolId: pub.poolId, results }, null, 1),
);
process.exit(results.every((r) => r.ok) ? 0 : 1);
