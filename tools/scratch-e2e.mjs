// Full flow on a throwaway (regular, non-global) deployment, to validate the wasm and the proofs
// before spending the NEAR needed to publish by hash. Testnet only.
import { readFileSync } from "node:fs";
import { generateKey } from "near-kit";
import { nearFor, viewer, sleep, NETWORK } from "./lib.mjs";
import { loadCards, cred, call } from "./pool.mjs";
import { ACTIONS } from "../web/public/merkle.js";

const deployer = "bh-deployer-1113.testnet";
const pool = `bh-scratch2.${deployer}`;
const A = "bh-signer-a.testnet", B = "bh-signer-b.testnet", M = "bh-mechanic.testnet", D = "bh-donor.testnet", R = "bh-relay.testnet";
const cards = await loadCards();
const dep = nearFor(deployer);

const key = generateKey();
console.log("create + deploy", pool);
await dep.transaction(deployer).createAccount(pool).transfer(pool, "6 NEAR").addKey(key.publicKey.toString(), { type: "fullAccess" })
  .deployContract(pool, readFileSync("evidence/borehole_pool.wasm")).send();
const poolNear = (await import("near-kit")).Near;
const me = new poolNear({ network: NETWORK, privateKey: key.secretKey, defaultSignerId: pool });
const params = { hold_ns: String(20e9), vote_window_ns: String(30e9), min_replies: 5, sample_size: 8, max_price: "1000000000000000000000000", first_pct: 70, rebroken_needed: 2, max_attempts: 2 };
await call(me, pool, "new", { signers: [A, B], params, root: Buffer.from(cards.root, "hex").toString("base64"), households: 30 });
console.log("init ok", JSON.stringify(await viewer().view(pool, "get_config", {})).slice(0, 200));

for (const act of [{ AddMechanic: { account: M } }, { AddPump: { name: "Demo well 1" } }]) {
  await call(nearFor(A), pool, "approve_action", { action: act });
  console.log("approve", JSON.stringify(act), await call(nearFor(B), pool, "approve_action", { action: act }).then((o) => o?.status ?? "done"));
}
await call(nearFor(D), pool, "fund", { pump: 0 }, "3 NEAR");
const relay = nearFor(R);
await call(relay, pool, "report_broken", { pump: 0, cred: cred(cards, 0, 0, ACTIONS.report) });
let job = await viewer().view(pool, "get_job", { id: 0 });
console.log("job after report", job.status);
await call(nearFor(M), pool, "accept_job", { job: 0, price: "500000000000000000000000" });
await call(nearFor(M), pool, "post_fix", { job: 0 });
job = await viewer().view(pool, "get_job", { id: 0 });
console.log("asked", job.eligible);
let n = 0;
for (const hh of job.eligible) {
  const slot = hh === 0 ? 1 : 0;
  await call(relay, pool, "vote", { job: 0, works: true, cred: cred(cards, hh, slot, ACTIONS.yes) });
  console.log("voted", hh);
  if (++n === 5) break;
}
job = await viewer().view(pool, "get_job", { id: 0 });
console.log("status", job.status, "paid", job.paid, "held", job.held);
console.log("mechanic balance", await viewer().getBalance(M));
await sleep(25000);
await call(relay, pool, "release_held", { job: 0 });
job = await viewer().view(pool, "get_job", { id: 0 });
console.log("final", job.status, "paid", job.paid);
console.log("ledger", (await viewer().view(pool, "list_ledger", { from: 0, limit: 50 })).map((e) => e.kind).join(","));
