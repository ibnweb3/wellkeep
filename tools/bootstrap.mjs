// One-time setup of the live testnet pool: both signers approve the same admin actions
// (register the mechanic, add three fictional demo pumps), then the donor funds it. Testnet only.
import { readFileSync } from "node:fs";
import { nearFor, viewer } from "./lib.mjs";
import { call } from "./pool.mjs";

const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const A = "bh-signer-a.testnet";
const B = "bh-signer-b.testnet";
const M = "bh-mechanic.testnet";
const D = "bh-donor.testnet";

const actions = [
  { AddMechanic: { account: M } },
  { AddPump: { name: "Village A - market square" } },
  { AddPump: { name: "Village A - primary school" } },
  { AddPump: { name: "Village A - health post" } },
];
const existing = await viewer().view(pool, "get_config", {});
if (existing.pump_count > 0) throw new Error(`pool already has ${existing.pump_count} pumps: refusing to bootstrap twice`);
for (const action of actions) {
  const first = await call(nearFor(A), pool, "approve_action", { action });
  const second = await call(nearFor(B), pool, "approve_action", { action });
  console.log(JSON.stringify(action), "first approval executed:", first?.status?.SuccessValue, "second:", second?.status?.SuccessValue);
}
await call(nearFor(D), pool, "fund", { pump: null }, "3 NEAR");
await call(nearFor(D), pool, "fund", { pump: 0 }, "1 NEAR");
const v = viewer();
console.log(JSON.stringify(await v.view(pool, "get_config", {})).slice(0, 400));
console.log(JSON.stringify(await v.view(pool, "list_pumps", {})));
console.log("pool balance", await v.getBalance(pool));
