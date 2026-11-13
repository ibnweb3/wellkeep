// Deletes a scratch account created by a scratch-*.mjs run and returns its balance to the deployer (testnet).
//   node tools/delete-scratch.mjs <accountId>
import { Near } from "near-kit";
import { NETWORK, loadKey, viewer } from "./lib.mjs";
const id = process.argv[2];
const k = loadKey(id);
const me = new Near({ network: NETWORK, privateKey: k.privateKey, defaultSignerId: id });
try {
  await me.transaction(id).deleteAccount({ beneficiary: "bh-deployer-1113.testnet" }).send();
  console.log("deleted", id);
} catch (e) {
  console.log("ERR", e.message, JSON.stringify(e.data ?? {}).slice(0, 300));
}
console.log("deployer", String(await viewer().getBalance("bh-deployer-1113.testnet")));
