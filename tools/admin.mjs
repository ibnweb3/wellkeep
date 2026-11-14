// Admin actions need BOTH signer accounts to approve the same action (testnet keys in .keys/).
//   node tools/admin.mjs add-mechanic <account>
//   node tools/admin.mjs remove-mechanic <account>
//   node tools/admin.mjs add-pump "<name>" <steward-account>     (creates the pump's keyless account and mints its NFT to the steward)
//   node tools/admin.mjs cancel-job <job-id>
import { readFileSync } from "node:fs";
import { nearFor } from "./lib.mjs";
import { call } from "./pool.mjs";

const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const [cmd, arg, arg2] = process.argv.slice(2);
const actions = {
  "add-mechanic": { AddMechanic: { account: arg } },
  "remove-mechanic": { RemoveMechanic: { account: arg } },
  "add-pump": { AddPump: { name: arg, steward: arg2 } },
  "cancel-job": { CancelJob: { job: Number(arg) } },
};
const action = actions[cmd];
if (!action || !arg || (cmd === "add-pump" && !arg2)) {
  console.error("usage: node tools/admin.mjs add-mechanic|remove-mechanic <account> | add-pump <name> <steward> | cancel-job <id>");
  process.exit(1);
}
for (const signer of ["bh-signer-a.testnet", "bh-signer-b.testnet"]) {
  const out = await call(nearFor(signer), pool, "approve_action", { action });
  console.log(signer, "approved; executed:", out?.status?.SuccessValue);
}
