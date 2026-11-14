// Full v2 flow on a throwaway (regular, non-global) deployment, with the REAL Circle testnet USDC.
// Validates: pool init, mechanic registration at the token, pump vault creation (keyless sub-account),
// USDC donation routed into a vault, tiered quote + steward approval, NFT transfer, vote, 70% payout from
// the vault, 30% release. Testnet only. Deletes the scratch account at the end.
//   node tools/scratch-v2.mjs [stage]
import { readFileSync, writeFileSync } from "node:fs";
import { generateKey } from "near-kit";
import { nearFor, viewer, sleep, NETWORK } from "./lib.mjs";
import { loadCards, cred, call } from "./pool.mjs";
import { ACTIONS } from "../web/public/merkle.js";

// MOCK=<path to mock NEP-141 wasm> runs against a throwaway token instead of Circle's USDC (before faucet USDC is available).
const MOCK = process.env.MOCK;
const deployerId = "bh-deployer-1113.testnet";
const mockId = `bh-mock.${deployerId}`;
export const USDC = MOCK ? mockId : "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const deployer = "bh-deployer-1113.testnet";
const pool = `bh-s6.${deployer}`;
const A = "bh-signer-a.testnet", B = "bh-signer-b.testnet", M = "bh-mechanic.testnet", D = "bh-donor.testnet", R = "bh-relay.testnet";
const STEWARD = "bh-relay.testnet"; // a stand-in holder for the scratch run
const U = (n) => String(Math.round(n * 1e6)); // USDC has 6 decimals
const rpc = async (params) => (await fetch(NETWORK.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) })).json();
const usdcOf = async (a) => Number(await viewer().view(USDC, "ft_balance_of", { account_id: a })) / 1e6;
const cards = await loadCards();
const dep = nearFor(deployer);
const near = (id) => nearFor(id);
const jobNow = async () => { await sleep(7000); return viewer().view(pool, "get_job", { id: 0 }); }; // views trail finalised state by a few seconds

if (MOCK) {
  const mk = generateKey();
  writeFileSync(`.keys/${mockId}.json`, JSON.stringify({ accountId: mockId, privateKey: mk.secretKey }));
  await nearFor(deployer).transaction(deployer).createAccount(mockId).transfer(mockId, "3 NEAR").addKey(mk.publicKey.toString(), { type: "fullAccess" }).deployContract(mockId, readFileSync(MOCK)).send();
  const mockNear = new (await import("near-kit")).Near({ network: NETWORK, privateKey: mk.secretKey, defaultSignerId: mockId });
  await call(mockNear, mockId, "new", {});
  for (const a of [D, M]) await call(mockNear, mockId, "mint", { account_id: a, amount: String(100e6) });
  console.log("mock token", mockId, "minted 100 to donor");
}
const key = generateKey();
writeFileSync(`.keys/${pool}.json`, JSON.stringify({ accountId: pool, privateKey: key.secretKey }));
console.log("create + deploy", pool);
await dep.transaction(deployer).createAccount(pool).transfer(pool, "8 NEAR").addKey(key.publicKey.toString(), { type: "fullAccess" })
  .deployContract(pool, readFileSync("evidence/wellkeep_pool.wasm")).send();
const me = new (await import("near-kit")).Near({ network: NETWORK, privateKey: key.secretKey, defaultSignerId: pool });
const params = { token: USDC, hold_ns: String(20e9), vote_window_ns: String(30e9), min_replies: 5, sample_size: 8, max_price: U(4), tier0_cap: U(1), tier1_cap: U(2), mid_cap: U(3), first_pct: 70, rebroken_needed: 2, max_attempts: 2 };
await call(me, pool, "new", { signers: [A, B], params, root: Buffer.from(cards.root, "hex").toString("base64"), households: 30 });
await sleep(6000);
console.log("init ok", JSON.stringify(await viewer().view(pool, "get_config", {})).slice(0, 160));

// the pool itself must be registered at the token to hold the shared fund
await call(dep, USDC, "storage_deposit", { account_id: pool, registration_only: true }, "0.00125 NEAR");

const both = async (action) => {
  await call(near(A), pool, "approve_action", { action });
  return call(near(B), pool, "approve_action", { action });
};
await both({ AddMechanic: { account: M } });
await both({ AddPump: { name: "Scratch well", steward: STEWARD, deputies: ["bh-council-1.testnet"] } });
await sleep(7000);
const p0 = await viewer().view(pool, "get_pump", { id: 0 });
console.log("pump 0", JSON.stringify(p0).slice(0, 300));
const vault = p0.vault;
const vacc = (await rpc({ request_type: "view_account", finality: "final", account_id: vault })).result;
const vkeys = (await rpc({ request_type: "view_access_key_list", finality: "final", account_id: vault })).result;
console.log("vault", vault, "code_hash", vacc?.code_hash, "keys", JSON.stringify(vkeys?.keys));
console.log("vault info", JSON.stringify(await viewer().view(vault, "get_info", {})));
console.log("vault registered at USDC:", JSON.stringify(await viewer().view(USDC, "storage_balance_of", { account_id: vault })));
console.log("mechanic registered at USDC:", JSON.stringify(await viewer().view(USDC, "storage_balance_of", { account_id: M })));

const have = await usdcOf(D);
console.log("donor USDC", have);
if (have < 6) { console.log("STOP: donor needs test USDC (faucet.circle.com). Cleaning up."); await me.transaction(pool).deleteAccount({ beneficiary: deployer }).send(); process.exit(0); }
await call(near(D), USDC, "ft_transfer_call", { receiver_id: pool, amount: U(3), msg: "pool" }, "1 yocto");
await call(near(D), USDC, "ft_transfer_call", { receiver_id: pool, amount: U(1), msg: "pump:0" }, "1 yocto");
await sleep(7000);
console.log("pool USDC", await usdcOf(pool), "vault USDC", await usdcOf(vault), "config.free", (await viewer().view(pool, "get_config", {})).free, "pump earmark", (await viewer().view(pool, "get_pump", { id: 0 })).earmark);

const relay = near(R);
await call(relay, pool, "report_broken", { pump: 0, cred: cred(cards, 0, 0, ACTIONS.report) });
// a big quote (3 USDC > tier0 1 USDC) must wait for the steward
await call(near(M), pool, "accept_job", { job: 0, price: U(3) });
let job = await jobNow();
console.log("after big quote:", job.status);
// the stand-in steward transfers the NFT to the deployer, who is then the one who must approve
await call(near(STEWARD), pool, "nft_transfer", { receiver_id: deployer, token_id: "pump-0" }, "1 yocto");
try { await call(near(STEWARD), pool, "steward_approve", { job: 0 }); console.log("ERROR: old holder could approve"); } catch (e) { console.log("old holder refused:", (e.panic ?? e.message).slice(0, 90)); }
await call(dep, pool, "steward_approve", { job: 0 });
job = await jobNow();
console.log("after steward approval:", job.status, "price", job.price);
await sleep(6000);
console.log("vault USDC after reserve", await usdcOf(vault), "(should be 3 = 1 own + 2 topped up from the shared fund)");
await call(near(M), pool, "post_fix", { job: 0 });
job = await jobNow();
let n = 0;
const mBefore = await usdcOf(M);
for (const hh of job.eligible) {
  await call(relay, pool, "vote", { job: 0, works: true, cred: cred(cards, hh, hh === 0 ? 1 : 0, ACTIONS.yes) });
  if (++n === 5) break;
}
await sleep(8000);
job = await jobNow();
console.log("status", job.status, "paid", job.paid, "held", job.held);
console.log("mechanic USDC +", (await usdcOf(M) - mBefore).toFixed(2), "(expected 2.10)", "vault now", await usdcOf(vault));
await sleep(14000);
await call(relay, pool, "release_held", { job: 0 });
await sleep(8000);
job = await jobNow();
console.log("final", job.status, "mechanic USDC total +", (await usdcOf(M) - mBefore).toFixed(2), "(expected 3.00)", "vault now", await usdcOf(vault));
console.log("mechanic record", JSON.stringify(await viewer().view(pool, "get_mechanic", { account: M })));
console.log("pump history", JSON.stringify(await viewer().view(pool, "get_pump", { id: 0 })).slice(0, 500));
console.log("ledger", (await viewer().view(pool, "list_ledger", { from: 0, limit: 80 })).map((e) => e.kind).join(","));
console.log("NFT", JSON.stringify(await viewer().view(pool, "nft_token", { token_id: "pump-0" })));
// ---- three tiers: a deputy (council member) approves a mid quote alone but not a big one
await call(relay, pool, "report_broken", { pump: 0, cred: cred(cards, 1, 0, ACTIONS.report) });
await call(near(M), pool, "accept_job", { job: 1, price: U(3.5) }); // above mid_cap (3): only the steward may approve
await sleep(7000);
let j1 = await viewer().view(pool, "get_job", { id: 1 });
console.log("big quote:", j1.status, "above_mid", j1.above_mid);
try { await call(near("bh-council-1.testnet"), pool, "steward_approve", { job: 1 }); console.log("ERROR: deputy approved a big quote"); } catch (e) { console.log("deputy refused on a big quote:", (e.panic ?? e.message).slice(0, 110)); }
await call(near(M), pool, "withdraw_quote", { job: 1 });
await call(near(M), pool, "accept_job", { job: 1, price: U(3) }); // within mid_cap: one deputy is enough
await sleep(7000);
j1 = await viewer().view(pool, "get_job", { id: 1 });
console.log("mid quote:", j1.status, "above_mid", j1.above_mid);
await call(near("bh-council-1.testnet"), pool, "steward_approve", { job: 1 });
await sleep(7000);
console.log("after deputy approval:", (await viewer().view(pool, "get_job", { id: 1 })).status);
await me.transaction(pool).deleteAccount({ beneficiary: deployer }).send();
console.log("scratch deleted; deployer", String(await viewer().getBalance(deployer)));
