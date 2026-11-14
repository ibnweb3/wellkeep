// Live proof on the real pool with Circle USDC: a repair on pump 0, whose steward is the village committee DAO.
// A 3 USDC quote is above the mechanic's automatic limit, so a DAO proposal must approve it.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { nearFor, viewer, sleep } from "./lib.mjs";
import { loadCards, cred, call } from "./pool.mjs";
import { ACTIONS } from "../web/public/merkle.js";

const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const T = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const M = "bh-mechanic.testnet", R = "bh-relay.testnet";
const cards = await loadCards();
const v = viewer();
const log = [];
const step = async (label, fn) => { const out = await fn(); const hash = out?.transaction?.hash ?? null; log.push({ label, hash }); console.log(label, hash ?? ""); await sleep(7000); return out; };
const bal = async (a) => Number(await v.view(T, "ft_balance_of", { account_id: a })) / 1e6;
const pump = (await v.view(pool, "get_pump", { id: 0 }));
console.log("steward of pump 0:", pump.steward, "| vault USDC", await bal(pump.vault), "| mechanic USDC", await bal(M));

await step("hh-0 reports pump 0 broken", () => call(nearFor(R), pool, "report_broken", { pump: 0, cred: cred(cards, 0, 0, ACTIONS.report) }));
const jobId = Number((await v.view(pool, "get_pump", { id: 0 })).open_job);
await step(`mechanic quotes 3 USDC on job ${jobId} (above the 1 USDC limit)`, () => call(nearFor(M), pool, "accept_job", { job: jobId, price: "3000000" }));
console.log("job status:", (await v.view(pool, "get_job", { id: jobId })).status);

// the committee DAO: council-1 files the proposal, council-2 and council-3 vote yes (2 of 3 passes)
const out = execFileSync("node", ["tools/dao.mjs", "propose", pool, "steward_approve", JSON.stringify({ job: jobId })], { encoding: "utf8" });
console.log(out.trim());
const propId = Number(out.match(/proposal -> (\d+)/)?.[1]);
console.log("DAO proposal id", propId);
await sleep(6000);
console.log(execFileSync("node", ["tools/dao.mjs", "vote", String(propId)], { encoding: "utf8" }).trim().slice(0, 700));
await sleep(8000);
const j = await v.view(pool, "get_job", { id: jobId });
console.log("job after DAO vote:", j.status, "price", j.price, "| vault USDC", await bal(pump.vault));
if (j.status !== "Accepted") { console.log("DAO approval did not land yet; stopping so it can be inspected"); process.exit(1); }

await step("mechanic posts the fix", () => call(nearFor(M), pool, "post_fix", { job: jobId }));
const asked = (await v.view(pool, "get_job", { id: jobId })).eligible;
console.log("asked", asked);
let n = 0;
for (const hh of asked) {
  await step(`hh-${hh} says it works`, () => call(nearFor(R), pool, "vote", { job: jobId, works: true, cred: cred(cards, hh, hh === 0 ? 1 : 0, ACTIONS.yes) }));
  if (++n === 5) break;
}
const after = await v.view(pool, "get_job", { id: jobId });
console.log("job:", after.status, "paid", after.paid, "held", after.held, "| mechanic USDC", await bal(M), "| vault USDC", await bal(pump.vault));
writeFileSync("evidence/live-run-v2.json", JSON.stringify({ pool, job: jobId, daoProposal: propId, steps: log, status: after.status, paid: after.paid, held: after.held, approvedNs: after.approved_ns, at: new Date().toISOString() }, null, 1));
