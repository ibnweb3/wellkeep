// Moves the helper-funded balance of the bh-fund-* accounts into the deployer (testnet).
import { nearFor, viewer } from "./lib.mjs";
const to = "bh-deployer-1113.testnet";
for (const n of (process.argv[2] ?? "a,b,c,d").split(",")) {
  const id = `bh-fund-${n}.testnet`;
  const bal = Number(await viewer().getBalance(id)) ;
  console.log(id, "balance", bal);
  await nearFor(id).send(to, "9.5 NEAR");
}
console.log("deployer", await viewer().getBalance(to));
