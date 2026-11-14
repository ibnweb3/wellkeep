// Exercises the local Worker's relay and sandbox endpoints against the live pool (run `npx wrangler dev --port 8791` first).
import { readFileSync } from "node:fs";
import { viewer, sleep } from "./lib.mjs";
import { loadCards, cred } from "./pool.mjs";
import { ACTIONS } from "../web/public/merkle.js";
const base = process.env.BASE ?? "http://localhost:8791";
const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const cards = await loadCards();
const post = (p, b) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const v = viewer();
const show = (l, o) => console.log(l.padEnd(46), JSON.stringify(o).slice(0, 170));
show("report pump 3 (hh-20, slot 0)", await post("/api/relay", { method: "report_broken", args: { pump: 3, cred: cred(cards, 20, 0, ACTIONS.report) } }));
await sleep(7000);
const job = Number((await v.view(pool, "get_pump", { id: 3 })).open_job);
show("sandbox quote 5 USDC (over the 3 cap)", await post("/api/sandbox", { method: "accept_job", args: { job, price: "5000000" } }));
show("sandbox quote 3 USDC", await post("/api/sandbox", { method: "accept_job", args: { job, price: "3000000" } }));
await sleep(7000);
show("job status", (await v.view(pool, "get_job", { id: job })).status);
show("sandbox steward approves", await post("/api/sandbox", { method: "steward_approve", args: { job } }));
await sleep(7000);
show("job status", (await v.view(pool, "get_job", { id: job })).status);
// a pump held by the DAO must refuse the sandbox steward
show("report pump 1 (hh-21, slot 0)", await post("/api/relay", { method: "report_broken", args: { pump: 1, cred: cred(cards, 21, 0, ACTIONS.report) } }));
await sleep(7000);
const job1 = Number((await v.view(pool, "get_pump", { id: 1 })).open_job);
show("sandbox quote 3 USDC on the DAO pump", await post("/api/sandbox", { method: "accept_job", args: { job: job1, price: "3000000" } }));
await sleep(7000);
show("sandbox steward tries the DAO pump", await post("/api/sandbox", { method: "steward_approve", args: { job: job1 } }));
show("disallowed method", await post("/api/sandbox", { method: "vote", args: { job } }));
