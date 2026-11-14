// Cloudflare Worker: serves the static site and runs one relayer endpoint.
//
// What this Worker is, honestly:
//   - /api/relay  a relayer. It pays the gas for household calls (report, vote, redraw, release) and for retrying a refused payout.
//                 It has no special rights on the contract: every call still needs a valid
//                 one-time code or is open to anyone, checked on-chain.
//   - /api/sandbox the judge sandbox: it lets a visitor play the MECHANIC and STEWARD roles without a wallet. The relayer
//                 account (bh-relay.testnet) is registered on the pool as a mechanic and is the steward (NFT holder) of the
//                 sandbox water points, so this endpoint can sign accept_job and post_fix as the mechanic and
//                 steward_approve / steward_reject as the steward. The contract still checks who holds each NFT:
//                 pumps held by the village committee DAO refuse these calls. Quotes are capped. Real mechanics use their own wallets.
// Donors and mechanics sign with their own wallets in the browser; this server never holds their keys.
// The relayer key is a throwaway TESTNET key held as a Worker secret. Nothing here touches mainnet.
// Both endpoints are rate limited per caller and overall (a Durable Object counter), because anyone on the internet can call them.
import { Near } from "near-kit";
import { DurableObject } from "cloudflare:workers";

const RELAY_METHODS = new Set(["report_broken", "vote", "redraw_sample", "release_held", "retry_payment"]);
const SANDBOX_METHODS = new Set(["accept_job", "post_fix", "steward_approve", "steward_reject"]);
const SANDBOX_MAX_PRICE = 4000000n; // 4 USDC (6 decimals): keeps the test fund from being drained by one click
const GAS = "150 Tgas";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function client(env) {
  const key = env.RELAY_KEY;
  const id = env.RELAY_ID;
  if (!key || !id) throw new Error("the relayer is not configured on this server");
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

/**
 * Exact fixed-window counters in one Durable Object (a single instance, so the counts are strongly consistent;
 * Cloudflare's Rate Limiting binding is eventually consistent and let a 200-request burst through in testing).
 * The counters live in memory, so they reset if the object is evicted, which only ever makes the limit more lenient.
 */
export class Limiter extends DurableObject {
  buckets = new Map();
  hit(key, limit, windowMs) {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.start >= windowMs) this.buckets.delete(k);
    const b = this.buckets.get(key) ?? { start: now, n: 0 };
    b.n += 1;
    this.buckets.set(key, b);
    return b.n <= limit;
  }
}

const PER_IP_LIMIT = 30; // requests a minute per caller: a full repair on the Try page is about 9
const ALL_LIMIT = 120; // requests a minute for everyone together: caps what the demo can spend on gas

/** One caller cannot spend the relayer's gas or burn the demo's one-time card codes. Returns an error text, or null. */
async function overLimit(req, env) {
  if (!env.LIMITER) return null; // not configured (for example a plain local run)
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const box = env.LIMITER.get(env.LIMITER.idFromName("limits"));
  if (!(await box.hit(`ip:${ip}`, PER_IP_LIMIT, 60_000))) return "Too many requests from your connection. Wait a minute and try again.";
  if (!(await box.hit("all", ALL_LIMIT, 60_000))) return "The test relayer is busy right now. Wait a minute and try again.";
  return null;
}

async function handle(req, env) {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const busy = await overLimit(req, env);
  if (busy) return json({ ok: false, error: busy }, 429);
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
      return json(await send(client(env), pool, body.method, body.args ?? {}));
    }
    if (path === "/api/sandbox") {
      if (!SANDBOX_METHODS.has(body.method)) return json({ ok: false, error: "method not allowed" }, 400);
      const job = Number(body.args?.job);
      if (!Number.isInteger(job) || job < 0) return json({ ok: false, error: "job must be a number" }, 400);
      if (body.method !== "accept_job") return json(await send(client(env), pool, body.method, { job }));
      let price;
      try { price = BigInt(body.args?.price); } catch { return json({ ok: false, error: "price must be a whole number of USDC base units" }, 400); }
      if (price <= 0n || price > SANDBOX_MAX_PRICE) return json({ ok: false, error: "sandbox quotes are limited to 4 USDC" }, 400);
      return json(await send(client(env), pool, "accept_job", { job, price: price.toString() }));
    }
    return json({ ok: false, error: "not found" }, 404);
  } catch (e) {
    return json({ ok: false, error: cleanError(e) }, 200);
  }
}

/**
 * The sandbox mechanic is the relayer account, so every sandbox repair pays test USDC to it. Left alone, the demo would
 * drain. Every ten minutes this sends what the relayer holds above a small float back into the shared pool (a normal
 * donation, signed by the relayer), so the sandbox keeps working for the next visitor. It moves nothing else.
 */
const KEEP = 2_000_000n; // the relayer keeps 2 USDC
async function recycle(env) {
  if (!env.TOKEN_ID) return { skipped: "no token configured" };
  const near = client(env);
  const have = BigInt(await near.view(env.TOKEN_ID, "ft_balance_of", { account_id: env.RELAY_ID }));
  if (have <= KEEP + 500_000n) return { skipped: "nothing worth returning", have: have.toString() };
  const amount = have - KEEP;
  const out = await near.call(env.TOKEN_ID, "ft_transfer_call", { receiver_id: env.POOL_ID, amount: amount.toString(), msg: "pool" }, { gas: GAS, attachedDeposit: "1 yocto" });
  return { returned: amount.toString(), hash: out?.transaction?.hash ?? null };
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) return handle(req, env);
    return env.ASSETS.fetch(req);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      recycle(env)
        .then((r) => console.log("recycle", JSON.stringify(r)))
        .catch((e) => console.log("recycle failed:", String(e?.message || e).slice(0, 300))),
    );
  },
};
