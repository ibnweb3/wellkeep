// Wallet connection for donors and mechanics. They sign with their own account; this site never holds their key.
import { NearConnector } from "@hot-labs/near-connect";

let connector;
let current = null; // { wallet, accountId }
const listeners = new Set();
const notify = () => listeners.forEach((f) => f(current && current.accountId));

export function onAccount(fn) {
  listeners.add(fn);
  fn(current && current.accountId);
}

export async function init() {
  connector = new NearConnector({ network: "testnet" });
  connector.on("wallet:signIn", async () => {
    try {
      const { wallet, accounts } = await connector.getConnectedWallet();
      current = accounts?.[0] ? { wallet, accountId: accounts[0].accountId } : null;
    } catch {
      current = null;
    }
    notify();
  });
  connector.on("wallet:signOut", () => {
    current = null;
    notify();
  });
  try {
    const { wallet, accounts } = await connector.getConnectedWallet();
    if (accounts?.[0]) current = { wallet, accountId: accounts[0].accountId };
  } catch {
    /* not signed in */
  }
  notify();
}

export async function connect() {
  await connector.connect();
}
export async function disconnect() {
  await connector.disconnect();
  current = null;
  notify();
}
export const accountId = () => current && current.accountId;

// Calls a method on any contract, signed by the connected wallet. deposit is yoctoNEAR as a string.
// (Used for the pool, and for ft_transfer_call on the USDC contract, which needs 1 yoctoNEAR and more gas.)
export async function callContract(receiverId, method, args, deposit = "0", gas = "100000000000000") {
  if (!current) throw new Error("Connect a wallet first");
  const out = await current.wallet.signAndSendTransaction({
    receiverId,
    actions: [{ type: "FunctionCall", params: { methodName: method, args, gas, deposit } }],
  });
  const hash = out?.transaction?.hash || out?.transaction_outcome?.id || (Array.isArray(out) ? out[0]?.transaction?.hash : undefined);
  return { ok: true, hash };
}

export const callPool = (poolId, method, args, deposit = "0") => callContract(poolId, method, args, deposit);
