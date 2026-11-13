// Registers accounts with the Circle testnet USDC contract so they can receive it (testnet only).
//   node tools/register-usdc.mjs bh-donor.testnet bh-mechanic.testnet ...
import { nearFor } from "./lib.mjs";
import { call } from "./pool.mjs";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const dep = nearFor("bh-deployer-1113.testnet");
for (const a of process.argv.slice(2)) {
  const out = await call(dep, USDC, "storage_deposit", { account_id: a, registration_only: true }, "0.00125 NEAR");
  console.log(a, out?.status?.SuccessValue !== undefined ? "registered" : JSON.stringify(out?.status).slice(0, 100));
}
