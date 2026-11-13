// Quick live proof on the current pool: report -> accept -> fix -> votes -> 70% paid, 30% held. Testnet only.
import { readFileSync } from "node:fs";
import { nearFor, viewer, sleep } from "./lib.mjs";
import { loadCards, cred, call } from "./pool.mjs";
import { ACTIONS } from "../web/public/merkle.js";
const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const cards = await loadCards(); const v = viewer(); const relay = nearFor("bh-relay.testnet"); const mech = nearFor("bh-mechanic.testnet");
const slot = async (hh) => { for (let s = 0; s < cards.slots; s++) if (!(await v.view(pool, "is_slot_used", { hh, slot: s }))) return s; throw new Error("no slot"); };
const pump = 2, reporter = 20;
await call(relay, pool, "report_broken", { pump, cred: cred(cards, reporter, await slot(reporter), ACTIONS.report) });
await sleep(6000);
const pumpInfo = (await v.view(pool, "list_pumps", {})).find(([id]) => id === pump)[1];
const id = pumpInfo.open_job; console.log("job", id);
await call(mech, pool, "accept_job", { job: id, price: "500000000000000000000000" });
await call(mech, pool, "post_fix", { job: id });
await sleep(6000);
let job = await v.view(pool, "get_job", { id }); console.log("asked", job.eligible);
let n = 0;
for (const hh of job.eligible) { await call(relay, pool, "vote", { job: id, works: true, cred: cred(cards, hh, await slot(hh), ACTIONS.yes) }); console.log("voted", hh); if (++n === 5) break; }
await sleep(6000);
job = await v.view(pool, "get_job", { id }); console.log(job.status, "paid", job.paid, "held", job.held, "approved_ns", job.approved_ns);
