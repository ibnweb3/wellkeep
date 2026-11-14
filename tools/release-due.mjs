// Waits until each Approved job's hold has passed, then releases its held share (anyone may; the relay account pays gas).
import { readFileSync } from "node:fs";
import { nearFor, viewer, sleep } from "./lib.mjs";
import { call } from "./pool.mjs";
const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const v = viewer();
const hold = BigInt((await v.view(pool, "get_config", {})).params.hold_ns);
for (;;) {
  const jobs = await v.view(pool, "list_jobs", { from: 0, limit: 100 });
  const pending = jobs.filter((j) => j.status === "Approved");
  if (!pending.length) break;
  const now = BigInt(Date.now()) * 1_000_000n;
  for (const j of pending) {
    if (now >= BigInt(j.approved_ns) + hold + 20_000_000_000n) {
      try {
        const out = await call(nearFor("bh-relay.testnet"), pool, "release_held", { job: j.id });
        console.log("released job", j.id, out?.transaction?.hash);
      } catch (e) { console.log("job", j.id, String(e.panic ?? e.message).slice(0, 120)); }
    }
  }
  await sleep(30000);
}
const m = await v.view(pool, "list_mechanics", {});
console.log("all held shares released. mechanics:", JSON.stringify(m));
