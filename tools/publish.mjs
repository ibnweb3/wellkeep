// Publishes the pool code as an IMMUTABLE global contract (referenced by hash) and creates the
// keyless pool account from that code hash plus the initial state. Testnet only.
//   node tools/publish.mjs publish     -> publishes the wasm by hash (burns NEAR, once per code version)
//   node tools/publish.mjs create      -> creates the deterministic (0s) pool account
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { deriveAccountId } from "near-kit";
import { nearFor, viewer } from "./lib.mjs";

const deployer = "bh-deployer-1113.testnet";
const wasm = readFileSync("evidence/wellkeep_pool.wasm");
const hash = createHash("sha256").update(wasm).digest();
const b58 = (u8) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(u8).toString("hex")), s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of u8) { if (b === 0) s = "1" + s; else break; }
  return s;
};
const codeHash = b58(hash);
const state = JSON.parse(readFileSync("evidence/state-init.json", "utf8"));
const data = new Map(Object.entries(state).map(([k, v]) => [Buffer.from(k, "base64"), Buffer.from(v, "base64")]));
const poolId = deriveAccountId({ code: { codeHash: hash }, data });
console.log({ codeHash, sha256hex: hash.toString("hex"), bytes: wasm.length, poolId });

const mode = process.argv[2];
const before = Number(await viewer().getBalance(deployer));
if (mode === "publish") {
  const out = await nearFor(deployer).transaction(deployer).publishContract(wasm, { identifiedBy: "hash" }).send();
  console.log("publish tx", out?.transaction?.hash ?? "ok");
  writeFileSync("evidence/publish.json", JSON.stringify({ codeHash, sha256hex: hash.toString("hex"), bytes: wasm.length, publisher: deployer, tx: out?.transaction?.hash, at: new Date().toISOString() }, null, 1));
} else if (mode === "create") {
  const out = await nearFor(deployer).transaction(deployer).stateInit({ code: { codeHash: hash }, data, deposit: "3 NEAR" }).send();
  console.log("create tx", out?.transaction?.hash ?? "ok", "status", JSON.stringify(out?.status).slice(0, 200));
  const prev = existsSync("evidence/publish.json") ? JSON.parse(readFileSync("evidence/publish.json", "utf8")) : {};
  writeFileSync("evidence/publish.json", JSON.stringify({ ...prev, poolId, createTx: out?.transaction?.hash }, null, 1));
}
console.log("deployer balance change", (Number(await viewer().getBalance(deployer)) - before).toFixed(4), "NEAR");
