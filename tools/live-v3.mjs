// Live proof of the three approval tiers on the real pool, with Circle USDC:
//   job A  pump 1  2.5 USDC (mid-size): ONE council member (a deputy of the pump) approves alone
//   job B  pump 0  4 USDC (large): the same council member is refused; a DAO proposal approves it
// then each job is fixed and voted on, and the mechanic is paid 70% from the pump's own account.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { nearFor, viewer, sleep } from "./lib.mjs";
import { loadCards, call } from "./pool.mjs";
import { credential, ACTIONS } from "../web/public/merkle.js";

const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const T = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const M = "bh-mechanic.testnet", R = "bh-relay.testnet", DEPUTY = "bh-council-1.testnet";
const cards = await loadCards();
const v = viewer();
const log = [];
const step = async (label, fn) => { const out = await fn(); const hash = out?.transaction?.hash ?? null; log.push({ label, hash }); console.log(label, hash ?? ""); await sleep(7000); return out; };
const bal = async (a) => Number(await v.view(T, "ft_balance_of", { account_id: a })) / 1e6;
// the first unused card row of a household (each row works once)
async function credFor(hh, action) {
  for (let slot = 0; slot < cards.slots; slot++) {
    if (await v.view(pool, "is_slot_used", { hh, slot })) continue;
    const row = cards.cards[hh].rows[slot];
    const code = action === ACTIONS.report ? row.report : action === ACTIONS.yes ? row.yes : row.no;
    return credential(cards.levels, cards.slots, hh, slot, action, code);
  }
  throw new Error(`hh-${hh} has no unused row`);
}
async function fixAndVote(jobId) {
  await step(`mechanic posts the fix on job ${jobId}`, () => call(nearFor(M), pool, "post_fix", { job: jobId }));
  const asked = (await v.view(pool, "get_job", { id: jobId })).eligible;
  let n = 0;
  for (const hh of asked) {
    await step(`hh-${hh} says it works (job ${jobId})`, async () => call(nearFor(R), pool, "vote", { job: jobId, works: true, cred: await credFor(hh, ACTIONS.yes) }));
    if (++n === 5) break;
  }
  const j = await v.view(pool, "get_job", { id: jobId });
  console.log(`job ${jobId}:`, j.status, "paid", j.paid, "held", j.held);
  return j;
}
const result = {};

// ---- job A: mid-size, one council member
const pumpA = await v.view(pool, "get_pump", { id: 1 });
console.log("pump 1 deputies:", pumpA.deputies.join(", "), "| vault USDC", await bal(pumpA.vault));
await step("hh-0 reports pump 1 broken", async () => call(nearFor(R), pool, "report_broken", { pump: 1, cred: await credFor(0, ACTIONS.report) }));
const jobA = Number((await v.view(pool, "get_pump", { id: 1 })).open_job);
await step(`mechanic quotes 2.5 USDC on job ${jobA} (above the 1 USDC limit, within the 3 USDC council-member limit)`, () => call(nearFor(M), pool, "accept_job", { job: jobA, price: "2500000" }));
console.log("status:", (await v.view(pool, "get_job", { id: jobA })).status, "above_mid:", (await v.view(pool, "get_job", { id: jobA })).above_mid);
await step(`council member ${DEPUTY} approves job ${jobA} alone`, () => call(nearFor(DEPUTY), pool, "steward_approve", { job: jobA }));
console.log("status after the council member:", (await v.view(pool, "get_job", { id: jobA })).status);
result.A = await fixAndVote(jobA);

// ---- job B: large, the DAO
await step("hh-1 reports pump 0 broken", async () => call(nearFor(R), pool, "report_broken", { pump: 0, cred: await credFor(1, ACTIONS.report) }));
const jobB = Number((await v.view(pool, "get_pump", { id: 0 })).open_job);
await step(`mechanic quotes 4 USDC on job ${jobB} (above the council-member limit)`, () => call(nearFor(M), pool, "accept_job", { job: jobB, price: "4000000" }));
const jb = await v.view(pool, "get_job", { id: jobB });
console.log("status:", jb.status, "above_mid:", jb.above_mid);
try {
  await call(nearFor(DEPUTY), pool, "steward_approve", { job: jobB });
  console.log("ERROR: the council member approved a large quote");
} catch (e) {
  console.log("council member refused on the large quote:", String(e.panic ?? e.message).slice(0, 120));
}
const out = execFileSync("node", ["tools/dao.mjs", "propose", pool, "steward_approve", JSON.stringify({ job: jobB })], { encoding: "utf8" });
const propId = Number(out.match(/proposal -> (\d+)/)?.[1]);
console.log("DAO proposal id", propId);
await sleep(6000);
console.log(execFileSync("node", ["tools/dao.mjs", "vote", String(propId)], { encoding: "utf8" }).trim().split("\n").slice(0, 2).join(" | "));
await sleep(9000);
console.log("status after the DAO vote:", (await v.view(pool, "get_job", { id: jobB })).status);
result.B = await fixAndVote(jobB);

writeFileSync(
  "evidence/live-run-v3.json",
  JSON.stringify({ pool, midJob: jobA, largeJob: jobB, daoProposal: propId, steps: log, midResult: { status: result.A.status, paid: result.A.paid, held: result.A.held }, largeResult: { status: result.B.status, paid: result.B.paid, held: result.B.held }, at: new Date().toISOString() }, null, 1),
);
console.log("mechanic USDC", await bal(M));
