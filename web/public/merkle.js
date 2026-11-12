// Merkle tree + credential helper. Must match contract/src/lib.rs (check_credential) byte for byte:
//   leaf = sha256("bh1" | hh as u32 LE | slot as u8 | action as u8 | code utf8)
//   parent = sha256(min(a,b) | max(a,b)), an odd last node is promoted unchanged.
// Leaf order: index = ((hh * SLOTS + slot) * 3 + action), action 0 = report, 1 = works, 2 = broken.
export const ACTIONS = { report: 0, yes: 1, no: 2 };
const enc = new TextEncoder();

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
export const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
export const toB64 = (u8) => btoa(String.fromCharCode(...u8));

export async function leafHash(hh, slot, action, code) {
  const head = enc.encode("bh1");
  const code8 = enc.encode(code);
  const out = new Uint8Array(3 + 4 + 1 + 1 + code8.length);
  out.set(head, 0);
  new DataView(out.buffer).setUint32(3, hh, true);
  out[7] = slot;
  out[8] = action;
  out.set(code8, 9);
  return sha256(out);
}

function cmp(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function pair(a, b) {
  const [lo, hi] = cmp(a, b) <= 0 ? [a, b] : [b, a];
  const buf = new Uint8Array(64);
  buf.set(lo, 0);
  buf.set(hi, 32);
  return sha256(buf);
}

export async function buildLevels(leaves) {
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? await pair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return levels;
}

export function proofFor(levels, index) {
  const proof = [];
  let idx = index;
  for (const level of levels.slice(0, -1)) {
    const sib = idx ^ 1;
    if (sib < level.length) proof.push(level[sib]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export const leafIndex = (hh, slot, action, slots) => (hh * slots + slot) * 3 + action;

/** Builds the argument object the contract expects for a credential. */
export function credential(levels, slots, hh, slot, action, code) {
  const proof = proofFor(levels, leafIndex(hh, slot, action, slots)).map(toB64);
  return { batch: 0, hh, slot, code, proof };
}
