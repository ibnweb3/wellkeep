// "Check before you give": every check a donor can run against the pool, with no trust in this site.
// Runs in the browser (bundled) and in Node (tools/verify.mjs). Only reads; spends nothing.
import { deriveAccountId } from "near-kit";

const A58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(u8) {
  let n = 0n;
  for (const b of u8) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = A58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of u8) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.data || j.error.message || "rpc error");
  return j.result;
}

/** Decodes the Borsh bytes of the contract's initial state (layout in contract/src/lib.rs). */
export function decodeInitialState(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u8 = () => bytes[o++];
  const u32 = () => {
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const u64 = () => {
    const v = dv.getBigUint64(o, true);
    o += 8;
    return v;
  };
  const u128 = () => {
    const lo = dv.getBigUint64(o, true);
    const hi = dv.getBigUint64(o + 8, true);
    o += 16;
    return (hi << 64n) | lo;
  };
  const str = () => {
    const n = u32();
    const s = new TextDecoder().decode(bytes.slice(o, o + n));
    o += n;
    return s;
  };
  const vec = () => {
    const n = u32();
    const v = bytes.slice(o, o + n);
    o += n;
    return v;
  };
  const signers = [str(), str()];
  const params = {
    hold_ns: u64().toString(),
    vote_window_ns: u64().toString(),
    min_replies: u32(),
    sample_size: u32(),
    max_price: u128().toString(),
    first_pct: u8(),
    rebroken_needed: u32(),
    max_attempts: u8(),
  };
  const nb = u32();
  const batches = [];
  for (let i = 0; i < nb; i++) batches.push({ root: vec(), start: u32(), count: u32() });
  return { signers, params, batches };
}

/**
 * @param {{rpcUrl:string, poolId:string, wasmUrl:string, stateUrl:string}} o
 * @returns {Promise<{id:string,title:string,ok:boolean,detail:string}[]>}
 */
export async function runChecks({ rpcUrl, poolId, wasmUrl, stateUrl }) {
  const out = [];
  const add = (id, title, ok, detail) => out.push({ id, title, ok, detail });
  const T_WASM = "The code at that hash is the wasm shipped in this repository";
  const T_CHAIN = "The code the chain stores under that hash is byte-identical to the repository wasm";
  const T_ADDR = "The address is derived from exactly this code and this starting state";
  const T_RULES = "The signers, rules and household-code root reported today match the committed starting state";

  let acct;
  try {
    acct = await rpc(rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: poolId });
  } catch (e) {
    add("account", "The account exists on-chain", false, String(e.message));
    return out;
  }
  add("account", "The account exists on-chain", true, poolId);

  const keys = await rpc(rpcUrl, "query", { request_type: "view_access_key_list", finality: "final", account_id: poolId });
  add("keys", "It has no access keys, so nobody can sign for it", keys.keys.length === 0, `${keys.keys.length} access keys`);

  const byHash = acct.global_contract_hash;
  const byAcct = acct.global_contract_account_id;
  add(
    "byhash",
    "Its code is referenced by hash, so the publisher cannot change it",
    !!byHash && !byAcct,
    byHash ? `global code hash ${byHash}` : byAcct ? `referenced by publisher account ${byAcct}, which CAN update it` : "no global code reference",
  );

  let wasm;
  try {
    wasm = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());
  } catch (e) {
    add("wasm", T_WASM, false, String(e.message));
    return out;
  }
  const hash = await sha256(wasm);
  const hashB58 = base58(hash);
  add("wasm", T_WASM, hashB58 === byHash, `repository wasm ${wasm.length} bytes, sha256 as base58: ${hashB58}`);

  try {
    const g = await rpc(rpcUrl, "query", { request_type: "view_global_contract_code", finality: "final", code_hash: byHash });
    const chain = b64(g.code_base64);
    add("chaincode", T_CHAIN, eq(chain, wasm), `${chain.length} bytes read back from the chain`);
  } catch (e) {
    add("chaincode", T_CHAIN, false, String(e.message));
  }

  let stateRaw;
  try {
    stateRaw = await (await fetch(stateUrl)).json();
  } catch (e) {
    add("address", T_ADDR, false, String(e.message));
    return out;
  }
  const data = new Map(Object.entries(stateRaw).map(([k, v]) => [b64(k), b64(v)]));
  const derived = deriveAccountId({ code: { codeHash: hash }, data });
  add("address", T_ADDR, derived === poolId, `recomputed here: ${derived}`);

  const init = decodeInitialState([...data.values()][0]);
  let cfg;
  try {
    const r = await rpc(rpcUrl, "query", {
      request_type: "call_function",
      finality: "final",
      account_id: poolId,
      method_name: "get_config",
      args_base64: btoa("{}"),
    });
    cfg = JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
  } catch (e) {
    add("rules", T_RULES, false, String(e.message));
    return out;
  }
  const p = cfg.params;
  const q = init.params;
  const sameParams =
    String(p.hold_ns) === q.hold_ns &&
    String(p.vote_window_ns) === q.vote_window_ns &&
    p.min_replies === q.min_replies &&
    p.sample_size === q.sample_size &&
    String(p.max_price) === q.max_price &&
    p.first_pct === q.first_pct &&
    p.rebroken_needed === q.rebroken_needed &&
    p.max_attempts === q.max_attempts;
  const sameSigners = cfg.signers[0] === init.signers[0] && cfg.signers[1] === init.signers[1];
  const rootInit = btoa(String.fromCharCode(...init.batches[0].root));
  add(
    "rules",
    T_RULES,
    sameParams && sameSigners && cfg.batches[0]?.root === rootInit,
    `signers ${init.signers.join(" + ")}; ${init.batches[0].count} households; code root ${hex(init.batches[0].root).slice(0, 16)}...`,
  );
  return out;
}
