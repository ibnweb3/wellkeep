// One-time setup of the live testnet pool (v2): NEAR for the pool, USDC registration, then both signers approve
// the same admin actions: register the mechanics and add the water points. Each AddPump makes a keyless account for
// the pump. Village A pumps are held by the village committee DAO; Village B pumps by the sandbox steward.
// Testnet only.
import { readFileSync } from "node:fs";
import { nearFor, viewer, sleep } from "./lib.mjs";
import { call } from "./pool.mjs";

const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const DAO = "wellkeep-village.sputnikv2.testnet";
const SANDBOX = "bh-relay.testnet";
const deployer = "bh-deployer-1113.testnet";
const A = "bh-signer-a.testnet";
const B = "bh-signer-b.testnet";

const existing = await viewer().view(pool, "get_config", {}).catch(() => null);
if (existing && existing.pump_count > 0) throw new Error(`pool already has ${existing.pump_count} pumps: refusing to bootstrap twice`);

console.log("pool", pool);
await nearFor(deployer).send(pool, "6 NEAR"); // gas reserve, the pumps' accounts and the mechanics' registrations
await call(nearFor(deployer), USDC, "storage_deposit", { account_id: pool, registration_only: true }, "0.00125 NEAR");
const COUNCIL = ["bh-council-1.testnet", "bh-council-2.testnet", "bh-council-3.testnet"];
const pumps = [
  // Village A: the committee DAO is the steward; each council member is a deputy who can approve a mid-size quote alone
  ["Village A - market square", DAO, COUNCIL],
  ["Village A - primary school", DAO, COUNCIL],
  ["Village A - health post", DAO, COUNCIL],
  // Village B: the sandbox account is the steward, so a visitor can play it; no deputies
  ["Village B - clinic", SANDBOX, []],
  ["Village B - market", SANDBOX, []],
  ["Village B - school", SANDBOX, []],
];
const actions = [
  { AddMechanic: { account: "bh-mechanic.testnet" } },
  { AddMechanic: { account: SANDBOX } },
  ...pumps.map(([name, steward, deputies]) => ({ AddPump: { name, steward, deputies } })),
];
for (const action of actions) {
  const first = await call(nearFor(A), pool, "approve_action", { action });
  const second = await call(nearFor(B), pool, "approve_action", { action });
  console.log(JSON.stringify(action).slice(0, 90), "->", first?.status?.SuccessValue, second?.status?.SuccessValue);
}
await sleep(7000);
console.log(JSON.stringify(await viewer().view(pool, "get_config", {})).slice(0, 360));
for (const [id, p] of await viewer().view(pool, "list_pumps", {})) console.log(id, p.name, "|", p.vault, "| steward", p.steward);
console.log("pool NEAR", String(await viewer().getBalance(pool)));
