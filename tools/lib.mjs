// Shared helpers for the testnet scripts. Keys live in .keys/ (gitignored). Testnet only.
import { Near } from "near-kit";
import { readFileSync } from "node:fs";

export const NETWORK = { networkId: "testnet", rpcUrl: "https://rpc.testnet.near.org" };

export function loadKey(accountId) {
  return JSON.parse(readFileSync(`.keys/${accountId}.json`, "utf8"));
}

export function nearFor(accountId) {
  const k = loadKey(accountId);
  return new Near({ network: NETWORK, privateKey: k.privateKey, defaultSignerId: accountId });
}

export const viewer = () => new Near({ network: NETWORK });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
