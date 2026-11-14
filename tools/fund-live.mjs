// Seeds the live pool with test USDC: shared pool and each water point's own account (ft_transfer_call, as a donor would).
import { readFileSync } from "node:fs";
import { nearFor, viewer, sleep } from "./lib.mjs";
import { call } from "./pool.mjs";
const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const T = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const U = (n) => String(Math.round(n * 1e6));
const plan = [
  ["bh-signer-a.testnet", 20, "pool"], ["bh-signer-b.testnet", 20, "pool"],
  ["bh-council-1.testnet", 6, "pump:0"], ["bh-council-1.testnet", 6, "pump:1"], ["bh-council-2.testnet", 6, "pump:2"],
  ["bh-mechanic.testnet", 6, "pump:3"], ["bh-mechanic.testnet", 6, "pump:4"], ["bh-mechanic.testnet", 6, "pump:5"],
];
for (const [from, amt, msg] of plan) {
  const out = await call(nearFor(from), T, "ft_transfer_call", { receiver_id: pool, amount: U(amt), msg }, "1 yocto");
  console.log(from.padEnd(22), amt, msg.padEnd(7), out?.status?.SuccessValue ?? JSON.stringify(out?.status).slice(0, 80));
}
await sleep(8000);
const v = viewer();
console.log("config.free", (await v.view(pool, "get_config", {})).free);
for (const [id, p] of await v.view(pool, "list_pumps", {})) console.log(id, p.name, "earmark", p.earmark, "vault USDC", await v.view(T, "ft_balance_of", { account_id: p.vault }));
console.log("pool USDC", await v.view(T, "ft_balance_of", { account_id: pool }));
