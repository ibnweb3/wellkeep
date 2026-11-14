// Walks one complete repair through the Worker's public endpoints, exactly as the Try page does (report, quote,
// fix, five votes). Used to check a deployment end to end.
//   node tools/sandbox-repair.mjs [baseUrl] [pump] [household] [quoteUSDC]
import { readFileSync } from "node:fs";
import { viewer, sleep } from "./lib.mjs";
import { loadCards } from "./pool.mjs";
import { credential, ACTIONS } from "../web/public/merkle.js";

const base = process.argv[2] ?? "https://wellkeep.ibnweb3lab.workers.dev";
const pump = Number(process.argv[3] ?? 4);
const reporter = Number(process.argv[4] ?? 40);
const quote = String(Math.round(Number(process.argv[5] ?? 1) * 1e6));
const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const cards = await loadCards();
const v = viewer();
const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
async function credFor(hh, action) {
  for (let slot = 0; slot < cards.slots; slot++) {
    if (await v.view(pool, "is_slot_used", { hh, slot })) continue;
    const row = cards.cards[hh].rows[slot];
    const code = action === ACTIONS.report ? row.report : action === ACTIONS.yes ? row.yes : row.no;
    return credential(cards.levels, cards.slots, hh, slot, action, code);
  }
  throw new Error(`hh-${hh} has no unused row`);
}
const show = (label, out) => { console.log(label.padEnd(34), JSON.stringify(out).slice(0, 110)); if (out.ok === false) process.exit(1); };

show("report", await post("/api/relay", { method: "report_broken", args: { pump, cred: await credFor(reporter, ACTIONS.report) } }));
await sleep(8000);
const job = Number((await v.view(pool, "get_pump", { id: pump })).open_job);
show(`quote ${quote} (job ${job})`, await post("/api/sandbox", { method: "accept_job", args: { job, price: quote } }));
await sleep(8000);
show("post fix", await post("/api/sandbox", { method: "post_fix", args: { job } }));
await sleep(8000);
const asked = (await v.view(pool, "get_job", { id: job })).eligible;
let n = 0;
for (const hh of asked) {
  show(`vote hh-${hh}`, await post("/api/relay", { method: "vote", args: { job, works: true, cred: await credFor(hh, ACTIONS.yes) } }));
  await sleep(2500);
  if (++n === 5) break;
}
await sleep(8000);
const j = await v.view(pool, "get_job", { id: job });
console.log("job", job, j.status, "paid", j.paid, "held", j.held);
