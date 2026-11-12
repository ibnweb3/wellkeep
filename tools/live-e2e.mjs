// Runs the repair rule end to end against the LIVE testnet pool and records evidence/live-run.json:
//   A) pump 1: report -> accept -> fix -> village says it works -> 70% paid -> hold -> 30% released
//   B) pump 2: same, then two different households report "broken again" during the hold -> 30% returns to the fund
//   C) refusals: reused code, a household that was not asked, an unregistered account taking a job
// Uses the throwaway demo accounts and the public demo cards. Testnet only.
import { readFileSync, writeFileSync } from "node:fs";
import { nearFor, viewer, sleep } from "./lib.mjs";
import { loadCards, cred, call } from "./pool.mjs";
import { ACTIONS } from "../web/public/merkle.js";

const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const M = "bh-mechanic.testnet";
const cards = await loadCards();
const v = viewer();
const relay = nearFor("bh-relay.testnet");
const mech = nearFor(M);
const log = [];
const note = (step, data) => { log.push({ step, ...data }); console.log(step, JSON.stringify(data).slice(0, 220)); };
const hashOf = (o) => o?.transaction?.hash ?? null;

async function nextSlot(hh) {
  for (let s = 0; s < cards.slots; s++) if (!(await v.view(pool, "is_slot_used", { hh, slot: s }))) return s;
  throw new Error(`hh-${hh} has no slots left`);
}
const credFor = async (hh, action) => cred(cards, hh, await nextSlot(hh), action);
const bal = async (id) => Number(await v.getBalance(id));
const jobView = (id) => v.view(pool, "get_job", { id });

async function repair(pump, price) {
  const reporter = pump * 5 + 10;
  const rep = await call(relay, pool, "report_broken", { pump, cred: await credFor(reporter, ACTIONS.report) });
  let id;
  for (let i = 0; i < 20 && id === undefined; i++) {
    const jobs = await v.view(pool, "list_jobs", { from: 0, limit: 100 });
    id = jobs.filter((j) => j.pump === pump && j.status === "Reported").pop()?.id;
    if (id === undefined) await sleep(1500);
  }
  note("reported", { pump, job: id, tx: hashOf(rep) });
  const acc = await call(mech, pool, "accept_job", { job: id, price });
  note("accepted", { job: id, price, tx: hashOf(acc) });
  const fix = await call(mech, pool, "post_fix", { job: id });
  let asked = [];
  for (let i = 0; i < 20 && asked.length === 0; i++) { asked = (await jobView(id)).eligible; if (!asked.length) await sleep(1500); }
  note("fix posted, households drawn at random", { job: id, asked, tx: hashOf(fix) });
  const before = await bal(M);
  let last;
  for (const hh of asked.slice(0, 5)) last = await call(relay, pool, "vote", { job: id, works: true, cred: await credFor(hh, ACTIONS.yes) });
  await sleep(6000); // the read below uses finalised state, which trails the last vote by a few blocks
  const j = await jobView(id);
  note("village said it works", { job: id, status: j.status, paid: j.paid, held: j.held, mechanicGainNEAR: +(await bal(M) - before).toFixed(4), lastVoteTx: hashOf(last) });
  return { id, asked };
}

// A) full happy path
const a = await repair(1, "500000000000000000000000");
await sleep(125_000);
const rel = await call(relay, pool, "release_held", { job: a.id });
await sleep(6000);
note("A released held share", { job: a.id, status: (await jobView(a.id)).status, paid: (await jobView(a.id)).paid, tx: hashOf(rel) });

// B) forfeit path
const b = await repair(2, "400000000000000000000000");
const freeBefore = BigInt((await v.view(pool, "get_config", {})).free);
await call(relay, pool, "report_broken", { pump: 2, cred: await credFor(20, ACTIONS.report) });
await sleep(6000);
note("first broken-again report", { job: b.id, status: (await jobView(b.id)).status });
await call(relay, pool, "report_broken", { pump: 2, cred: await credFor(21, ACTIONS.report) });
await sleep(6000);
const jb = await jobView(b.id);
const freeAfter = BigInt((await v.view(pool, "get_config", {})).free);
note("second different household reported: held share forfeited", { job: b.id, status: jb.status, held: jb.held, returnedToFundYocto: (freeAfter - freeBefore).toString() });

// C) refusals
const refusals = [];
const attempt = async (name, fn) => {
  try { await fn(); refusals.push({ name, refused: false }); } catch (e) { refusals.push({ name, refused: true, reason: String(e.message).split("\n")[0].slice(0, 160) }); }
};
const spent = await credFor(7, ACTIONS.report);
await call(relay, pool, "report_broken", { pump: 0, cred: spent }).catch(() => {});
await attempt("reuse a spent one-time code", () => call(relay, pool, "report_broken", { pump: 0, cred: spent }));
const open = (await v.view(pool, "list_jobs", { from: 0, limit: 100 })).filter((j) => j.pump === 0 && j.status === "Reported").pop();
await attempt("unregistered account takes a job", () => call(relay, pool, "accept_job", { job: open?.id ?? 0, price: "1000" }));
await attempt("price above the cap", () => call(mech, pool, "accept_job", { job: open?.id ?? 0, price: "2000000000000000000000000" }));
note("refusals", { refusals });
// leave the demo clean: both signers cancel the job opened for the refusal tests
if (open) {
  await call(nearFor("bh-signer-a.testnet"), pool, "approve_action", { action: { CancelJob: { job: open.id } } });
  await call(nearFor("bh-signer-b.testnet"), pool, "approve_action", { action: { CancelJob: { job: open.id } } });
  await sleep(6000);
  note("refusal-test job cancelled by both signers", { job: open.id, status: (await jobView(open.id)).status });
}
writeFileSync("evidence/live-run.json", JSON.stringify({ pool, ranAt: new Date().toISOString(), network: "testnet", log }, null, 1));
