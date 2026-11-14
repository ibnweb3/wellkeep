// Prints the Circle testnet USDC balance of the project accounts.
import { viewer } from "./lib.mjs";
const T = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
for (const a of ["bh-donor", "bh-relay", "bh-mechanic", "bh-council-1", "bh-council-2", "bh-council-3", "bh-signer-a", "bh-signer-b", "bh-deployer-1113"]) {
  const b = await viewer().view(T, "ft_balance_of", { account_id: `${a}.testnet` });
  console.log(a.padEnd(18), (Number(b) / 1e6).toFixed(2), "USDC");
}
