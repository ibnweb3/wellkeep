// Cloudflare Worker: serves the static site and runs the small demo "operator" endpoints.
//
// What this Worker is, honestly:
//   - /api/relay    a relayer. It pays the gas for household calls. It has no special rights on the
//                   contract: every call still needs a valid one-time code, checked on-chain.
//   - /api/mechanic a DEMO mechanic account operated by this page, so a judge can play the
//                   mechanic without a wallet. In real use the mechanic signs with their own key.
//   - /api/donate   a DEMO donor account (testnet NEAR, small capped amounts).
// All three use throwaway TESTNET keys held as Worker secrets. Nothing here touches mainnet.
import { Near } from "near-kit";

const RELAY_METHODS = new Set(["report_broken", "vote", "redraw_sample", "release_held"]);
const DONATE_OK = new Set(["0.1", "0.5"]);
const GAS = "150 Tgas";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function client(env, which) {
  const key = { relay: env.RELAY_KEY, mechanic: env.MECHANIC_KEY, donor: env.DONOR_KEY }[which];
  const id = { relay: env.RELAY_ID, mechanic: env.MECHANIC_ID, donor: env.DONOR_ID }[which];
  if (!key || !id) throw new Error(`${which} account is not configured on this server`);
  return new Near({
    network: { networkId: "testnet", rpcUrl: env.RPC_URL || "https://test.rpc.fastnear.com" },
    privateKey: key,
    defaultSignerId: id,
  });
}

function cleanError(e) {
  const m = String(e?.message || e);
  const at = m.indexOf("Smart contract panicked: ");
  return (at >= 0 ? m.slice(at + "Smart contract panicked: ".length) : m).slice(0, 300);
}

async function send(near, pool, method, args, deposit) {
  const run = () => near.call(pool, method, args, { gas: GAS, ...(deposit ? { attachedDeposit: deposit } : {}) });
  let out;
  try {
    out = await run();
  } catch (e) {
    if (/nonce/i.test(String(e?.message))) out = await run(); // two callers collided on a nonce: retry once
    else throw e;
  }
  return { ok: true, hash: out?.transaction?.hash ?? null };
}

async function handle(req, env) {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad JSON" }, 400);
  }
  const pool = env.POOL_ID;
  const path = new URL(req.url).pathname;
  try {
    if (path === "/api/relay") {
      if (!RELAY_METHODS.has(body.method)) return json({ ok: false, error: "method not allowed" }, 400);
      return json(await send(client(env, "relay"), pool, body.method, body.args ?? {}));
    }
    if (path === "/api/mechanic") {
      if (body.action === "accept_job") {
        const price = BigInt(body.price);
        return json(await send(client(env, "mechanic"), pool, "accept_job", { job: Number(body.job), price: price.toString() }));
      }
      if (body.action === "post_fix") return json(await send(client(env, "mechanic"), pool, "post_fix", { job: Number(body.job) }));
      return json({ ok: false, error: "action not allowed" }, 400);
    }
    if (path === "/api/donate") {
      if (!DONATE_OK.has(String(body.amount))) return json({ ok: false, error: "amount must be 0.1 or 0.5" }, 400);
      const pump = body.pump === null || body.pump === undefined ? null : Number(body.pump);
      return json(await send(client(env, "donor"), pool, "fund", { pump }, `${body.amount} NEAR`));
    }
    return json({ ok: false, error: "not found" }, 404);
  } catch (e) {
    return json({ ok: false, error: cleanError(e) }, 200);
  }
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) return handle(req, env);
    return env.ASSETS.fetch(req);
  },
};
