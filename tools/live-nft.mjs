// Live proof on the real pool: the pump NFT really transfers, stewardship follows it, and the steward manages deputies.
// Uses Village B's pump 5 (steward: the sandbox account bh-relay) and hands it to bh-signer-a and back. Testnet only.
import { readFileSync, writeFileSync } from "node:fs";
import { nearFor, viewer, sleep } from "./lib.mjs";
import { call } from "./pool.mjs";

const pool = JSON.parse(readFileSync("evidence/publish.json", "utf8")).poolId;
const A = "bh-relay.testnet", B = "bh-signer-a.testnet";
const v = viewer();
const steps = [];
const events = [];
const note = (label, out) => {
  const hash = out?.transaction?.hash ?? null;
  for (const r of out?.receipts_outcome ?? []) for (const l of r.outcome?.logs ?? []) if (String(l).startsWith("EVENT_JSON:")) events.push(JSON.parse(String(l).slice(11)));
  steps.push({ label, hash });
  console.log(label, hash ?? "");
};
const owner = async () => (await v.view(pool, "nft_token", { token_id: "pump-5" })).owner_id;
const settle = () => sleep(7000);

console.log("owner before:", await owner());
note(`${A} transfers NFT pump-5 to ${B}`, await call(nearFor(A), pool, "nft_transfer", { receiver_id: B, token_id: "pump-5" }, "1 yocto"));
await settle();
const after = await owner();
console.log("owner after:", after, "| tokens of", B, "=", (await v.view(pool, "nft_tokens_for_owner", { account_id: B })).map((t) => t.token_id).join(","), "| supply for", A, "=", await v.view(pool, "nft_supply_for_owner", { account_id: A }));
let oldRefused = "";
try { await call(nearFor(A), pool, "set_quote_cap", { pump: 5, cap: "1000000" }); oldRefused = "ERROR: the old holder could still set the cap"; } catch (e) { oldRefused = String(e.panic ?? e.message).slice(0, 120); }
console.log("old holder refused:", oldRefused);
note(`${B} (new steward) adds ${"bh-council-1.testnet"} as a deputy of pump 5`, await call(nearFor(B), pool, "set_deputy", { pump: 5, account: "bh-council-1.testnet", on: true }));
await settle();
console.log("deputies now:", (await v.view(pool, "get_pump", { id: 5 })).deputies.join(","));
note(`${B} removes the deputy again`, await call(nearFor(B), pool, "set_deputy", { pump: 5, account: "bh-council-1.testnet", on: false }));
note(`${B} transfers NFT pump-5 back to ${A}`, await call(nearFor(B), pool, "nft_transfer", { receiver_id: A, token_id: "pump-5" }, "1 yocto"));
await settle();
const final = await v.view(pool, "get_pump", { id: 5 });
console.log("owner at the end:", final.steward, "| holders:", final.holders.map((h) => h.account).join(" -> "), "| deputies:", final.deputies.join(",") || "none");
writeFileSync("evidence/live-nft.json", JSON.stringify({ pool, token: "pump-5", ownerAfterFirstTransfer: after, oldHolderRefused: oldRefused, holdersAtEnd: final.holders.map((h) => h.account), steps, nep171Events: events, at: new Date().toISOString() }, null, 1));
console.log("events logged:", events.map((e) => e.event).join(", "));
