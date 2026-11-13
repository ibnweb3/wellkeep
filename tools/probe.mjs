// One-off check: can a keyless deterministic (0s) account create a sub-account and deploy code into it?
// Publishes a tiny probe contract by hash, creates its 0s account, calls make(), inspects v1.<probe>.
//   node tools/probe.mjs <path-to-probe.wasm>
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deriveAccountId } from "near-kit";
import { nearFor, viewer, sleep } from "./lib.mjs";

const deployer = "bh-deployer-1113.testnet";
const wasm = readFileSync(process.argv[2]);
const hash = createHash("sha256").update(wasm).digest();
const data = new Map([[Buffer.from("x"), Buffer.from("y")]]);
const id = deriveAccountId({ code: { codeHash: hash }, data });
console.log("probe account", id, "bytes", wasm.length);
const dep = nearFor(deployer);
try {
  await dep.transaction(deployer).publishContract(wasm, { identifiedBy: "hash" }).send();
  console.log("published");
} catch (e) { console.log("publish:", String(e.message ?? e).slice(0, 200)); }
try {
  await dep.transaction(deployer).stateInit({ code: { codeHash: hash }, data, deposit: "1 NEAR" }).send();
  console.log("created");
} catch (e) { console.log("create:", String(e.message ?? e).slice(0, 200)); }
await sleep(5000);
const out = await dep.call(id, "make", {}, { gas: "100 Tgas" }).catch((e) => ({ err: String(e.message ?? e).slice(0, 400) }));
console.log("make ->", JSON.stringify(out).slice(0, 300));
await sleep(8000);
const sub = `v1.${id}`;
const rpc = async (params) => (await fetch("https://test.rpc.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }) })).json();
console.log("sub account", JSON.stringify((await rpc({ request_type: "view_account", finality: "final", account_id: sub })).result ?? "missing").slice(0, 250));
console.log("sub keys", JSON.stringify((await rpc({ request_type: "view_access_key_list", finality: "final", account_id: sub })).result ?? "n/a").slice(0, 200));
console.log("sub info", await viewer().view(sub, "get_info", {}).catch((e) => "ERR " + String(e.message).slice(0, 150)));
