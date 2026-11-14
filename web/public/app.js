import { buildLevels, credential, fromHex, ACTIONS } from "/merkle.js";
import { mountWatch } from "/watch.js";

const $main = document.getElementById("main");
const $live = document.getElementById("live");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const Y = 10n ** 24n; // yoctoNEAR per NEAR (only used for the pool's NEAR storage reserve)
const U = 10n ** 6n; // USDC base units per USDC

let CONFIG, LEVELS, SLOTS, W = null;
let walletAcct = null;
let isMech = false;
let S = { cfg: null, pumps: [], mechs: [], jobs: [], ledger: [], owed: [], balance: "0", poolUsdc: "0", dao: null, chainNow: 0n, fetchedAt: 0 };
const usedCache = new Map();
let busy = false;
let lastRoute = null;
let lastChecks = null; // survives the periodic re-render
const TRY = { pump: null, hh: Math.floor(Math.random() * 150), /* a random household, so repeated visitors do not all use up the same card rows */ quote: "1", log: [] }; // the judge sandbox keeps its place across re-renders
const NFT = new Map(); // nft_token reads, cached per ownership
let CARDS = null;

// ---------------------------------------------------------------- chain reads (public RPC, direct)
// The public testnet RPCs rate-limit now and then. Try the next one on a network error, HTTP 429 or 5xx; a real
// JSON-RPC error (a contract refusing a call) is the answer and is thrown at once. The last good endpoint is kept.
let rpcFirst = 0;
async function rpc(method, params) {
  const urls = CONFIG.rpcUrls ?? [CONFIG.rpcUrl];
  let lastErr;
  for (let n = 0; n < urls.length; n++) {
    const i = (rpcFirst + n) % urls.length;
    try {
      const r = await fetch(urls[i], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`RPC ${r.status}`);
      const j = await r.json();
      if (j.error) {
        const e = new Error(j.error.data || j.error.message);
        e.rpcAnswer = true;
        throw e;
      }
      rpcFirst = i;
      return j.result;
    } catch (e) {
      if (e.rpcAnswer) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
async function viewAt(account, method, args = {}) {
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}
const view = (method, args) => viewAt(CONFIG.poolId, method, args);
const usdcOf = (account) => viewAt(CONFIG.token, "ft_balance_of", { account_id: account }).catch(() => "0");

async function loadDao() {
  if (!CONFIG.dao) return null;
  try {
    const [policy, last] = await Promise.all([viewAt(CONFIG.dao, "get_policy"), viewAt(CONFIG.dao, "get_last_proposal_id")]);
    const from = Math.max(0, Number(last) - 12);
    const proposals = Number(last) > 0 ? await viewAt(CONFIG.dao, "get_proposals", { from_index: from, limit: 12 }) : [];
    const council = policy.roles.find((r) => r.kind && r.kind.Group)?.kind.Group ?? [];
    return { policy, council, threshold: policy.default_vote_policy?.threshold, proposals: proposals.reverse(), bond: policy.proposal_bond };
  } catch {
    return null;
  }
}

async function load() {
  const cfg = await view("get_config");
  // the newest entries, so the page stays current once the lists outgrow one read
  const jobsFrom = Math.max(0, Number(cfg.job_count) - 100);
  const ledgerFrom = Math.max(0, Number(cfg.ledger_count) - 400);
  const owedFrom = Math.max(0, Number(cfg.owed_count) - 50);
  const [pumps, jobs, ledger, acct, block, mechs, poolUsdc, dao, owed] = await Promise.all([
    view("list_pumps"),
    view("list_jobs", { from: jobsFrom, limit: 100 }),
    view("list_ledger", { from: ledgerFrom, limit: 400 }),
    rpc("query", { request_type: "view_account", finality: "final", account_id: CONFIG.poolId }),
    rpc("block", { finality: "final" }),
    view("list_mechanics"),
    usdcOf(CONFIG.poolId),
    loadDao(),
    view("list_owed", { from: owedFrom, limit: 50 }),
  ]);
  const vaultBal = await Promise.all(pumps.map(([, p]) => usdcOf(p.vault)));
  const all = pumps.map(([id, p], i) => ({ id, ...p, vaultBal: vaultBal[i] }));
  S = { cfg, allPumps: all, pumps: all.filter((p) => !(CONFIG.hiddenPumps || []).includes(p.id)), mechs, jobs, ledger, owed, balance: acct.amount, poolUsdc, dao, chainNow: BigInt(block.header.timestamp), fetchedAt: Date.now() };
  usedCache.clear();
}
const nowNs = () => S.chainNow + BigInt(Date.now() - S.fetchedAt) * 1_000_000n;

// ---------------------------------------------------------------- formatting
function near(y, digits = 3) {
  const v = BigInt(y);
  const whole = v / Y;
  const frac = ((v % Y) * 10n ** BigInt(digits)) / Y;
  const f = frac.toString().padStart(digits, "0").replace(/0+$/, "");
  return f ? `${whole}.${f}` : `${whole}`;
}
/** A USDC amount (6 decimals) with two decimals, e.g. 2.10 */
function usd(u, digits = 2) {
  const v = BigInt(u);
  const whole = v / U;
  const frac = ((v % U) * 10n ** BigInt(digits)) / U;
  return `${whole}.${frac.toString().padStart(digits, "0")}`;
}
const toUnits = (n) => BigInt(Math.round(Number(n) * 1e6));
const when = (ns) => (BigInt(ns) === 0n ? "" : new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString());
const iso = (ns) => (BigInt(ns) === 0n ? "" : new Date(Number(BigInt(ns) / 1_000_000n)).toISOString());
const explorer = (acc) => `${CONFIG.explorer}/address/${acc}`;
const txLink = (h) => (h ? ` <a href="${CONFIG.explorer}/txns/${h}" target="_blank" rel="noopener">transaction</a>` : "");
const short = (id) => (id.length > 24 ? `${id.slice(0, 10)}...${id.slice(-6)}` : id);
const acctLink = (a, label) => `<a class="mono" href="${explorer(a)}" target="_blank" rel="noopener">${esc(label ?? short(a))}</a>`;
const isDao = (a) => !!CONFIG.dao && a === CONFIG.dao;
const holderName = (a) => (isDao(a) ? "the village committee (Sputnik DAO)" : a === CONFIG.sandboxSteward ? `${a} (sandbox steward)` : a);

function fmtDur(ns) {
  let s = Math.max(0, Math.ceil(Number(ns) / 1e9));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s %= 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

// ---------------------------------------------------------------- CSV for the bookkeeper
function csv(rows) {
  return rows.map((r) => r.map((c) => { const s = String(c ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
}
function download(name, rows) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv(rows)], { type: "text/csv" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const invNo = (j) => `WK-${String(j.id + 1).padStart(4, "0")}`;
const pumpOf = (id) => S.allPumps.find((p) => p.id === id);
function entriesFor(j, kind) {
  return S.ledger.find((e) => e.job === j.id && e.kind === kind);
}
function invoiceRows() {
  const head = ["invoice", "opened_utc", "water_point", "paid_from_account", "payee", "quote_usdc", "paid_usdc", "held_usdc", "status", "first_paid_utc", "held_paid_utc", "network", "token"];
  const rows = S.jobs.map((j) => {
    const p = pumpOf(j.pump);
    return [invNo(j), iso(j.opened_ns), p?.name ?? j.pump, p?.vault ?? "", j.mechanic ?? "", usd(j.price), usd(j.paid), usd(j.held), invoiceStatus(j), iso(entriesFor(j, "pay_first")?.ts ?? 0), iso(entriesFor(j, "pay_held")?.ts ?? 0), "NEAR testnet", `USDC ${CONFIG.token}`];
  });
  return [head, ...rows];
}
function ledgerRows() {
  return [["time_utc", "event", "job", "water_point", "amount_usdc", "who"], ...S.ledger.map((e) => [iso(e.ts), e.kind, e.job ?? "", e.pump ?? "pool", BigInt(e.amount) ? usd(e.amount) : "", e.who])];
}

// ---------------------------------------------------------------- derived views
const jobById = (id) => S.jobs.find((j) => j.id === id);
function pumpState(p) {
  if (p.open_job !== null && p.open_job !== undefined) {
    const j = jobById(p.open_job);
    return { key: j.status, job: j };
  }
  if (p.held_job !== null && p.held_job !== undefined) return { key: "Approved", job: jobById(p.held_job) };
  return { key: "Working", job: null };
}
const STATE_LABEL = {
  Working: ["Working", "ok"],
  Reported: ["Reported broken", "warn"],
  Quoted: ["Quote waits for the steward", "warn"],
  Accepted: ["Mechanic repairing", "warn"],
  Voting: ["Awaiting village check", "warn"],
  Approved: ["Fixed, 30% on hold", "ok"],
  Disputed: ["Disputed", "bad"],
};
const chipFor = (k) => {
  const [t, c] = STATE_LABEL[k] || [k, ""];
  return `<span class="chip ${c}">${esc(t)}</span>`;
};
function invoiceStatus(j) {
  return (
    {
      Reported: "Open, no quote yet",
      Quoted: "Quote awaiting the steward",
      Accepted: "Money reserved, repair under way",
      Voting: "Money reserved, village checking",
      Approved: "First share paid, rest held",
      Completed: "Paid in full",
      Forfeited: "First share paid, held share returned to the pump",
      Disputed: "Disputed",
      Cancelled: "Cancelled",
    }[j.status] || j.status
  );
}
function reservedTotal() {
  return S.jobs.reduce((a, j) => {
    if (["Accepted", "Voting", "Approved", "Disputed"].includes(j.status)) return a + (BigInt(j.price) - BigInt(j.paid));
    return a;
  }, 0n);
}
const mechRec = (a) => S.mechs.find((m) => m.account === a);

// ---------------------------------------------------------------- household cards (typed in by the household)
function readCard(prefix, action) {
  const hh = Number(document.getElementById(prefix + "-hh").value);
  const slot = Number(document.getElementById(prefix + "-slot").value) - 1;
  const code = document.getElementById(prefix + "-code").value.trim().toUpperCase();
  if (!Number.isInteger(hh) || hh < 0 || hh >= S.cfg.total_households) return { error: `Household number must be 0 to ${S.cfg.total_households - 1}.` };
  if (!code) return { error: "Type the code from the card." };
  return { hh, cred: credential(LEVELS, SLOTS, hh, slot, action, code) };
}
function cardFields(prefix, codeLabel) {
  const rows = Array.from({ length: SLOTS }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
  return `<div class="row fields">
    <label>Household number<input id="${prefix}-hh" type="number" min="0" max="${S.cfg.total_households - 1}" inputmode="numeric" autocomplete="off" spellcheck="false" required></label>
    <label>Card row<select id="${prefix}-slot">${rows}</select></label>
    <label>${esc(codeLabel)}<input id="${prefix}-code" type="text" autocomplete="off" spellcheck="false" autocapitalize="characters" required></label>
  </div>`;
}

// ---------------------------------------------------------------- server calls (relayer only)
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
const lastMsg = {}; // survives the re-render that follows every action
function say(el, text, kind = "") {
  if (el) {
    el.className = `msg ${kind}`;
    el.innerHTML = text;
    if (el.id) lastMsg[el.id] = { text, kind };
  }
  $live.textContent = String(text).replace(/<[^>]+>/g, "");
}
async function run(msgEl, label, fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  say(msgEl, `${esc(label)}...`);
  try {
    const out = await fn();
    if (out && out.ok === false) say(msgEl, `Not accepted: ${esc(out.error)}`, "err");
    else say(msgEl, `${esc(label)}: done.${out?.hash ? txLink(out.hash) : ""}`, "good");
  } catch (e) {
    const m = String(e.message || e);
    const panic = m.match(/Smart contract panicked: ([^"\n]+)/);
    say(msgEl, `Failed: ${esc(panic ? panic[1] : m)}`, "err");
  } finally {
    busy = false;
    await refresh();
    // The chain's views trail a new transaction by a few seconds, so look again until the page shows the next step.
    for (const wait of [3000, 6000, 10000]) setTimeout(() => { if (!busy && !document.activeElement?.matches("select, input, textarea")) refresh(); }, wait);
  }
}
const relay = (method, args) => post("/api/relay", { method, args });

// ---------------------------------------------------------------- routing and render
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  let m = h.match(/^\/pump\/(\d+)$/);
  if (m) return { name: "pump", id: Number(m[1]) };
  m = h.match(/^\/job\/(\d+)$/);
  if (m) return { name: "job", id: Number(m[1]) };
  if (h === "/ledger") return { name: "ledger" };
  if (h === "/community") return { name: "community" };
  if (h === "/try") return { name: "try" };
  if (h === "/about") return { name: "about" };
  return { name: "home" };
}
function setTabs(name) {
  const tab = name === "pump" ? "home" : name === "job" ? "ledger" : name;
  document.querySelectorAll(".tabs a").forEach((a) => {
    if (a.dataset.route === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

let revealedOnce = false;
function render() {
  const r = route();
  const before = {};
  document.querySelectorAll("[data-k]").forEach((e) => (before[e.dataset.k] = e.textContent));
  const sameRoute = r.name === lastRoute;
  lastRoute = r.name;
  setTabs(r.name);
  document.getElementById("hero").hidden = r.name !== "home";
  const keep = { x: window.scrollX, y: window.scrollY };
  if (r.name === "pump") $main.innerHTML = pumpPage(r.id);
  else if (r.name === "job") $main.innerHTML = invoicePage(r.id);
  else if (r.name === "ledger") $main.innerHTML = ledgerPage();
  else if (r.name === "community") $main.innerHTML = communityPage();
  else if (r.name === "try") $main.innerHTML = tryPage();
  else if (r.name === "about") $main.innerHTML = aboutPage();
  else $main.innerHTML = homePage();
  $main.classList.toggle("home", r.name === "home");
  wire(r);
  if (r.name === "home") {
    const slot = document.getElementById("watch-slot");
    if (slot) mountWatch(slot, S.cfg.params);
    document.querySelectorAll("[data-k]").forEach((e) => {
      if (sameRoute && before[e.dataset.k] !== undefined && before[e.dataset.k] !== e.textContent) {
        e.classList.add("flash");
        setTimeout(() => e.classList.remove("flash"), 1200);
      }
    });
    setupReveal();
  }
  for (const id of ["msg", "msg-fund", "msg-try", "msg-steward", "msg-owed"]) {
    const el = document.getElementById(id);
    if (el && lastMsg[id]) {
      el.className = `msg ${lastMsg[id].kind}`;
      el.innerHTML = lastMsg[id].text;
    }
  }
  window.scrollTo(keep.x, keep.y);
}

let updatedAt = Date.now();
let revObs = null;
function setupReveal() {
  const items = document.querySelectorAll(".reveal");
  if (revealedOnce || !("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    items.forEach((e) => e.classList.add("in"));
    return;
  }
  document.documentElement.classList.add("reveal-ready");
  revObs?.disconnect();
  revObs = new IntersectionObserver((en) => en.forEach((x) => { if (x.isIntersecting) { x.target.classList.add("in"); revObs.unobserve(x.target); } }), { threshold: 0.08 });
  items.forEach((e) => revObs.observe(e));
  revealedOnce = true;
}
setInterval(() => {
  const el = document.getElementById("ago");
  if (el) {
    const s = Math.round((Date.now() - updatedAt) / 1000);
    el.textContent = s < 5 ? "just now" : s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
  }
}, 1000);

async function refresh() {
  try {
    await load();
    updatedAt = Date.now();
  } catch (e) {
    if (S.cfg) return; // a background refresh failed (for example the public RPC rate-limited us): keep what is on screen
    $main.innerHTML = `<div class="card"><h2>Could not read the chain</h2><p class="muted">${esc(e.message)}</p><button id="retry">Try again</button></div>`;
    document.getElementById("retry")?.addEventListener("click", refresh);
    return;
  }
  render();
}

// ---------------------------------------------------------------- pages
function homePage() {
  const cfg = S.cfg;
  const inVaults = S.allPumps.reduce((a, p) => a + BigInt(p.vaultBal), 0n);
  const free = BigInt(cfg.free);
  const reserved = reservedTotal();
  const p = cfg.params;
  return `
  <div class="statrow reveal">
    <div><div class="label">Shared pool, free</div><div class="stat num"><span data-k="free">${usd(free)}</span> <small>USDC</small></div></div>
    <div><div class="label">Held in the pumps' own accounts</div><div class="stat num"><span data-k="earm">${usd(inVaults)}</span> <small>USDC</small></div></div>
    <div><div class="label">Reserved for open repairs</div><div class="stat num"><span data-k="resv">${usd(reserved)}</span> <small>USDC</small></div></div>
  </div>
  <p class="poolline row between"><span>Pool account <a class="mono" href="${explorer(CONFIG.poolId)}" target="_blank" rel="noopener">${esc(CONFIG.poolId)}</a>. The money is Circle's test USDC. Each water point's share sits in its own keyless account, read from the USDC contract. The pool also holds ${near(S.balance, 2)} NEAR for gas and for creating those accounts; that is not part of the fund.</span><span class="livebar" role="status"><i class="live-dot" aria-hidden="true"></i>Live from the chain, updated <span id="ago">just now</span></span></p>

  <a class="trystrip reveal" href="#/try"><span><span class="kicker">For judges and curious visitors</span><b>Play every role: villager, mechanic, steward, village vote</b><em>Real NEAR testnet transactions. No wallet needed.</em></span><span aria-hidden="true">&rarr;</span></a>

  <section class="sec reveal" aria-labelledby="pumps">
    <div class="sec-head"><div><span class="kicker">Water points</span><h2 id="pumps">The pumps this fund keeps running</h2></div></div>
    <ol class="plist">
    ${S.pumps
      .map((pm) => {
        const st = pumpState(pm);
        return `<li><a href="#/pump/${pm.id}" aria-label="Open ${esc(pm.name)}"><b>${esc(pm.name)}<small class="nfttag">NFT pump-${pm.id}</small></b><span class="ear">Own account holds <span class="num">${usd(pm.vaultBal)}</span> USDC</span>${chipFor(st.key)}<span class="go" aria-hidden="true">&rarr;</span></a></li>`;
      })
      .join("") || `<li class="empty">No water points registered yet.</li>`}
    </ol>
  </section>

  <section class="sec reveal" aria-label="The idea">
    <span class="kicker">The idea</span>
    <p class="statement">A well is only the start. Keeping it running is the hard part.</p>
    <p class="statement-sub">That is what this fund pays for, in the open, in a stablecoin.</p>
  </section>

  <section class="bandblack reveal" aria-labelledby="how-h">
    <div class="wrap">
      <span class="eyebrow">How it works</span>
      <h2 id="how-h">Five steps. Nobody holds a key.</h2>
      <ol class="steps">
        <li><b>Check before you give</b>Press the check below: it recomputes the fund's address and shows that no one holds a key to it or to any pump's account.</li>
        <li><b>Fund it</b>Send USDC from your own NEAR testnet wallet to one pump's account or to the shared pool.</li>
        <li><b>Report</b>A household types its number and a code from its printed card to report the pump broken. A job opens.</li>
        <li><b>Quote, fix and check</b>A registered mechanic quotes in USDC. A quote above their track-record limit waits for the pump's steward. After the fix, the reporter and ${p.sample_size} random households are asked; ${p.min_replies} replies are needed and two thirds must say it works.</li>
        <li><b>Pay and hold</b>${p.first_pct}% is paid from the pump's own account at once. The rest is held for ${fmtDur(BigInt(p.hold_ns))} (short on this testnet build so it can be watched) and released unless two households report it broken again.</li>
      </ol>
    </div>
  </section>

  <section class="sec reveal" aria-label="Watch a repair"><div id="watch-slot"></div></section>

  <section class="sec reveal" aria-labelledby="why-near">
    <div class="sec-head"><div><span class="kicker">Why NEAR</span><h2 id="why-near">Every pump is an NFT and an account</h2></div></div>
    <div class="facts">
      <div><b>The NFT owns the money</b><p>Each water point is an NEP-171 token <em>and</em> a keyless sub-account that holds its repair fund. Whoever holds the NFT is the pump's steward. Transfer the token and the stewardship moves; the money stays in the pump's account.</p></div>
      <div><b>No key, no swap</b><p>The pool and every pump account have no access keys, and the pool's code is a global contract referenced by hash. The publisher cannot sign for them or change the code, and the chain says so.</p></div>
      <div><b>A real committee</b><p>The village committee is a Sputnik DAO. It holds the pump NFTs, so approving a big repair quote is an ordinary DAO proposal that the council votes on. Villagers hold no NEAR: a relayer pays their fees.</p></div>
    </div>
    <div class="stack">
      <span class="label">NEAR pieces used in this build</span>
      <ul>
        <li><b>NEAR testnet</b> holds the fund, the jobs and the ledger.</li>
        <li><b>Global contract by hash</b> and a deterministic <span class="mono">0s</span> account: the pool's code cannot be swapped and its address commits to its code.</li>
        <li><b>Sub-accounts</b>: one keyless account per water point, created by the pool, that holds its USDC.</li>
        <li><b>NEP-171 NFTs</b>: <span data-nft-supply>...</span> in total; water points transfer, household passes are credentials that do not.</li>
        <li><b>NEP-141 USDC</b> (Circle's testnet USDC) is the money, sent with <span class="mono">ft_transfer_call</span>.</li>
        <li><b>Sputnik DAO</b> is the village committee. <b>NEAR on-chain random seed</b> draws the voters.</li>
        <li><b>near-sdk</b> (Rust) contracts, <b>near-kit</b> in the relayer, a <b>NEAR wallet</b>, the NEAR RPC and NEAR Explorer.</li>
      </ul>
    </div>
    <p class="muted small facts-note">The repair rule itself could be written on another chain. What it would not have is an address that proves its own code, a token that is also the account holding the money, or a committee that is an ordinary DAO.</p>
  </section>

  <section class="sec reveal" aria-labelledby="check">
    <div class="sec-head"><div><span class="kicker">Verify</span><h2 id="check">Check before you give</h2></div></div>
    <div class="card">
      <p>Nothing here asks you to trust this website. The check reads the chain and recomputes the address itself.</p>
      <button id="runcheck">Run the checks</button>
      <ul class="checks" id="checks" aria-live="polite">${checksHtml()}</ul>
    </div>
  </section>`;
}

function checksHtml() {
  if (!lastChecks) return "";
  return lastChecks
    .map((r) => `<li><span class="chip ${r.ok ? "ok" : "bad"}">${r.ok ? "PASS" : "FAIL"}</span><div><div>${esc(r.title)}</div><div class="detail">${esc(r.detail)}</div></div></li>`)
    .join("");
}

function timeline(j) {
  const steps = [
    ["Reported", ["Reported", "Quoted", "Accepted", "Voting", "Approved", "Completed"]],
    ["Mechanic quoted, money reserved", ["Accepted", "Voting", "Approved", "Completed"]],
    ["Fix posted, village asked", ["Voting", "Approved", "Completed"]],
    ["Village confirmed, first share paid", ["Approved", "Completed"]],
    ["Held share released", ["Completed"]],
  ];
  const rank = { Reported: 0, Quoted: 0, Accepted: 1, Voting: 2, Approved: 3, Completed: 4 };
  const at = j.status === "Completed" ? 5 : (rank[j.status] ?? -1); // a finished job has every step done
  return `<ul class="timeline">${steps
    .map(([t], i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}"><span>${esc(t)}</span></li>`)
    .join("")}</ul>`;
}

function jobCard(j, full) {
  const asked = j.eligible;
  const replies = j.yes.length + j.no.length;
  const needed = Math.min(S.cfg.params.min_replies, asked.length);
  let extra = "";
  if (j.status === "Quoted") {
    const rec = mechRec(j.mechanic);
    extra = `<p>The quote of <b class="num">${usd(j.price)}</b> USDC is above ${rec ? `this mechanic's automatic limit of <b class="num">${usd(rec.auto_cap)}</b> USDC` : "the automatic limit"}, so nobody's money is reserved until it is approved. ${j.above_mid ? `It is above the <b class="num">${usd(S.cfg.params.mid_cap)}</b> USDC council-member limit, so only the pump's steward (for Village A, a DAO vote) can approve it.` : `It is within the <b class="num">${usd(S.cfg.params.mid_cap)}</b> USDC council-member limit, so one council member (a deputy of the pump) or the steward can approve it.`}</p>`;
  }
  if (j.status === "Voting") {
    extra = `<p>Asked: ${asked.length} households. Replies ${replies} of ${needed} needed. Works: ${j.yes.length}, still broken: ${j.no.length}.</p>
      <div class="asked">${asked.map((h) => `<span class="hh ${j.yes.includes(h) ? "yes" : j.no.includes(h) ? "no" : ""}">hh-${h}</span>`).join("")}</div>`;
  }
  if (j.status === "Approved") {
    const end = BigInt(j.approved_ns) + BigInt(S.cfg.params.hold_ns);
    const left = end - nowNs();
    extra = `<p>Paid <b class="num">${usd(j.paid)}</b> USDC. Held <b class="num">${usd(j.held)}</b> USDC. ${left > 0n ? `Releases in <span class="num" data-countdown="${end}">${fmtDur(left)}</span>.` : "The hold has passed: anyone can release it."} Broken-again reports so far: ${j.rebroken.length} of ${S.cfg.params.rebroken_needed}.</p>`;
  }
  if (j.status === "Completed") extra = `<p>Paid in full: <b class="num">${usd(j.paid)}</b> USDC to <span class="mono">${esc(j.mechanic || "")}</span>.</p>`;
  if (j.status === "Forfeited") extra = `<p>The held share went back to the pump's own account after households reported the pump broken again. Paid so far: <b class="num">${usd(j.paid)}</b> USDC.</p>`;
  if (j.status === "Disputed") extra = `<p>The village check did not settle. Both signers must cancel it (the reserved money then returns to the pump's balance).</p>`;
  if (j.status === "Cancelled") extra = `<p>Cancelled; reserved money returned to the pump's balance.</p>`;
  if (j.attempts > 0 && j.status === "Accepted") extra += `<p class="muted">The village said the first fix did not work. The mechanic must try again.</p>`;
  return `<div class="card">
    <div class="row between"><b>Job #${j.id}</b><span class="chip">${esc(j.status)}</span></div>
    ${j.mechanic ? `<p class="muted">Mechanic <span class="mono">${esc(j.mechanic)}</span>, quote <span class="num">${usd(j.price)}</span> USDC</p>` : `<p class="muted">Reported by ${j.reporters.length} household(s): ${j.reporters.map((h) => "hh-" + h).join(", ")}. Waiting for a mechanic.</p>`}
    ${full ? timeline(j) : ""}${extra}
    <p class="small"><a href="#/job/${j.id}">Invoice ${invNo(j)}</a></p>
  </div>`;
}

// ---- NFT record and history of one water point
function nftHtml(t, pm) {
  const holders = pm
    ? `<ol class="holders">${pm.holders.map((h, i) => `<li><span class="mono">${esc(h.account)}</span><small>${i === pm.holders.length - 1 ? "holds it now" : "held it"} since ${esc(when(h.since_ns))}</small></li>`).join("")}</ol>`
    : "";
  return `<dl class="nft"><dt>token_id</dt><dd class="mono">${esc(t.token_id)}</dd><dt>owner_id</dt><dd class="mono">${esc(t.owner_id)}</dd>${t.account_id ? `<dt>its own account</dt><dd>${acctLink(t.account_id, t.account_id)}</dd>` : ""}<dt>title</dt><dd>${esc(t.title)}</dd><dt>transferable</dt><dd>${t.transferable ? "yes (NEP-171 nft_transfer)" : "no, a credential"}</dd></dl>${holders}`;
}
const nftBox = (id, pm) => {
  const key = pm ? `${id}@${pm.steward}` : id;
  return `<div data-nft="${esc(id)}" data-nftkey="${esc(key)}">${NFT.has(key) ? (NFT.get(key) ? nftHtml(NFT.get(key), pm) : "No such record.") : "Reading nft_token from the chain..."}</div>`;
};
async function fillNft() {
  for (const el of document.querySelectorAll("[data-nft]")) {
    const id = el.dataset.nft, key = el.dataset.nftkey;
    if (NFT.has(key)) continue;
    try {
      NFT.set(key, await view("nft_token", { token_id: id }));
      if (el.isConnected) {
        const pm = id.startsWith("pump-") ? pumpOf(Number(id.slice(5))) : null;
        el.innerHTML = NFT.get(key) ? nftHtml(NFT.get(key), pm) : "No such record.";
      }
    } catch {
      if (el.isConnected) el.textContent = "Could not read the record just now.";
    }
  }
  const sup = document.querySelectorAll("[data-nft-supply]");
  if (sup.length) {
    try {
      const n = await view("nft_total_supply");
      sup.forEach((e) => (e.textContent = n));
    } catch { /* leave the placeholder */ }
  }
}

function pumpPage(id) {
  const pm = S.pumps.find((x) => x.id === id);
  if (!pm) return `<p><a href="#/">Back</a></p><div class="card empty">No such water point.</div>`;
  const st = pumpState(pm);
  const j = st.job;
  const history = S.jobs.filter((x) => x.pump === id && (!j || x.id !== j.id)).reverse();
  const p = S.cfg.params;
  const maxPrice = usd(pm.quote_cap);
  const isSteward = walletAcct && walletAcct === pm.steward;
  const isDeputy = walletAcct && pm.deputies.includes(walletAcct);
  const mine = walletAcct ? mechRec(walletAcct) : null;

  const mechNote = walletAcct
    ? isMech
      ? `<p class="muted">Signed in as <span class="mono">${esc(walletAcct)}</span>, a registered mechanic${mine ? ` with ${mine.paid_jobs} finished job(s). Quotes up to <b class="num">${usd(mine.auto_cap)}</b> USDC are taken at once; above that the steward must approve.` : "."}</p>`
      : `<p class="muted">Signed in as <span class="mono">${esc(walletAcct)}</span>, which is not a registered mechanic. The contract will refuse. Both signers must register an account first.</p>`
    : `<p class="muted">Connect your wallet (top right) with a registered mechanic account.</p>`;
  let action = "";
  if (!j) {
    action = `<h3>Report this pump broken</h3>
      <p class="muted">A household reports with a one-time code from its printed card. The relayer submits it and pays the fee; the household holds no NEAR.</p>
      ${cardFields("rep", "Code (column: Report broken)")}
      <button id="act-report">Report broken</button>`;
  } else if (j.status === "Reported") {
    action = `<h3>Next: a mechanic quotes</h3>
      <p class="muted">The price is reserved from this pump's own account first, then the shared pool. This pump accepts quotes up to ${maxPrice} USDC.</p>
      ${mechNote}
      <label>Quote (USDC)<input id="quote" type="number" autocomplete="off" spellcheck="false" min="0.1" max="${maxPrice}" step="0.1" value="1" inputmode="decimal"></label>
      <p><button id="act-accept">Send the quote</button></p>`;
  } else if (j.status === "Quoted") {
    const canDecide = isSteward || (isDeputy && !j.above_mid);
    action = `<h3>A quote waits for approval</h3>
      <p class="muted">${esc(j.mechanic)} quoted <b class="num">${usd(j.price)}</b> USDC, above the mechanic's automatic limit. ${j.above_mid ? `It is above the <b class="num">${usd(p.mid_cap)}</b> USDC council-member limit, so only the steward can approve it. ${isDao(pm.steward) ? "The steward is the village committee DAO: that is a proposal its council votes on (see Community)." : ""}` : `It is within the <b class="num">${usd(p.mid_cap)}</b> USDC council-member limit: one deputy of this pump (${pm.deputies.length ? pm.deputies.map((d) => `<span class="mono">${esc(d)}</span>`).join(", ") : "none set"}) or the steward can approve it alone.`}</p>
      ${canDecide ? `<div class="row"><button id="act-sapprove">Approve the quote</button><button id="act-sreject" class="secondary">Turn it down</button></div>` : `<p class="muted">${j.above_mid ? `Only the holder of NFT pump-${pm.id}` : `A deputy of this pump or the holder of NFT pump-${pm.id}`} can decide.</p>`}
      ${walletAcct && walletAcct === j.mechanic ? `<p><button id="act-withdraw" class="secondary">Withdraw my quote</button></p>` : ""}`;
  } else if (j.status === "Accepted") {
    action = `<h3>Next: the mechanic says it is fixed</h3>
      <p class="muted">Posting the fix draws ${p.sample_size} random households (plus the reporters) to be asked whether the pump works.</p>
      ${mechNote}
      <button id="act-fix">Post the fix</button>`;
  } else if (j.status === "Voting") {
    const replied = new Set([...j.yes, ...j.no]);
    const pending = j.eligible.filter((h) => !replied.has(h));
    const windowEnd = BigInt(j.draw_ns) + BigInt(p.vote_window_ns);
    const needed = Math.min(p.min_replies, j.eligible.length);
    const late = nowNs() > windowEnd && j.yes.length + j.no.length < needed;
    action = `<h3>Village check</h3>
      <p class="muted">Only the asked households can vote, and each code works once. Two thirds of the replies must say the pump works. Still to reply: ${pending.length ? pending.map((h) => "hh-" + h).join(", ") : "nobody"}.</p>
      ${cardFields("vote", "Code (column: It works, or Still broken)")}
      <div class="row" style="margin-top:10px">
        <button id="act-yes">It works</button>
        <button id="act-no" class="secondary">Still broken</button>
      </div>
      ${late ? `<p><button id="act-redraw" class="secondary">Too few replied in time: ask more households</button></p>` : ""}`;
  } else if (j.status === "Approved") {
    const end = BigInt(j.approved_ns) + BigInt(p.hold_ns);
    const due = nowNs() >= end;
    action = `<h3>Held share</h3>
      <p class="muted">If two different households report it broken again before the hold ends, the held share goes back to this pump's balance instead.</p>
      ${due ? `<button id="act-release">Release the held share to the mechanic</button>` : `<p>Not yet: <span class="num" data-countdown="${end}">${fmtDur(end - nowNs())}</span> left.</p>`}
      <h3 style="margin-top:18px">Or: it broke again</h3>
      ${cardFields("rep", "Code (column: Report broken)")}
      <button id="act-report" class="danger">Report broken again</button>`;
  } else if (j.status === "Disputed") {
    action = `<p>This job needs both signers to cancel it. That is an admin step done outside this page.</p>`;
  }

  const steward = isSteward
    ? `<div class="card">
        <div class="row between"><b>Steward desk</b><span class="chip ok">you hold NFT pump-${pm.id}</span></div>
        <p class="muted">Only the holder of this NFT can do these. They are the NEP-171 token's behaviour: ownership decides who controls the pump.</p>
        <div class="row fields"><label>Highest quote this pump accepts (USDC)<input id="cap" type="number" min="0.1" max="${usd(p.max_price)}" step="0.1" value="${usd(pm.quote_cap)}" inputmode="decimal"></label></div>
        <p><button id="act-cap" class="secondary">Set the cap</button></p>
        <div class="row fields"><label>Hand this pump to another account<input id="xfer-to" type="text" placeholder="account.testnet" autocomplete="off" spellcheck="false"></label></div>
        <p><button id="act-xfer" class="danger">Transfer NFT pump-${pm.id}</button></p>
        <p class="muted small">The new holder becomes steward at once. The money stays in the pump's own account, and a payout already in progress still goes to its mechanic.</p>
        <div class="row fields"><label>Deputy: a council member who may approve quotes up to ${usd(p.mid_cap)} USDC alone<input id="dep-acct" type="text" placeholder="account.testnet" autocomplete="off" spellcheck="false"></label></div>
        <div class="row"><button id="act-depadd" class="secondary">Add as deputy</button><button id="act-depdel" class="secondary">Remove deputy</button></div>
        <div class="msg" id="msg-steward" role="status"></div>
      </div>`
    : "";

  return `<p><a href="#/">&larr; All water points</a></p>
  <div class="row between"><h1 style="margin:0">${esc(pm.name)}</h1>${chipFor(st.key)}</div>
  <p class="muted">Its own account holds <b class="num">${usd(pm.vaultBal)}</b> USDC. Shared pool free: <b class="num">${usd(S.cfg.free)}</b> USDC. <a href="#/try">Play every role on this site</a> without a wallet.</p>
  <div class="card">
    <div class="row between"><b>NFT <span class="mono">pump-${pm.id}</span> and its account</b><span class="chip">NEP-171, transferable</span></div>
    ${nftBox("pump-" + pm.id, pm)}
    <div class="grid cols2 small" style="margin-top:12px">
      <div><span class="label">Steward</span><p>${esc(holderName(pm.steward))}</p></div>
      <div><span class="label">Its keyless account</span><p>${acctLink(pm.vault, pm.vault)}<br><span class="muted">holds ${usd(pm.vaultBal)} USDC, read from the USDC contract</span></p></div>
      <div><span class="label">Paid out so far</span><p class="num">${usd(pm.paid_total)} USDC in ${pm.jobs_paid} finished repair(s); ${pm.forfeits} held share(s) returned</p></div>
      <div><span class="label">Highest quote it takes</span><p class="num">${usd(pm.quote_cap)} USDC</p></div>
      <div><span class="label">Deputies (one can approve up to ${usd(p.mid_cap)} USDC)</span><p>${pm.deputies.length ? pm.deputies.map((d) => `<span class="mono">${esc(d)}</span>`).join("<br>") : "none: only the steward approves"}</p></div>
    </div>
  </div>

  <div class="grid cols2">
    <div class="card">
      <h3>Add funds</h3>
      <p class="muted">${walletAcct ? `Giving from <span class="mono">${esc(walletAcct)}</span>.` : "Connect your NEAR testnet wallet (top right) to give."} You send USDC with <span class="mono">ft_transfer_call</span> and sign it yourself; this site never holds your key. Testnet USDC comes from <a href="https://faucet.circle.com/" target="_blank" rel="noopener">Circle's faucet</a>. Giving from another chain through NEAR Intents is not built: Intents has no testnet.</p>
      <label>Amount (USDC)<input id="don-amt" type="number" min="0.1" step="0.1" value="2" inputmode="decimal" autocomplete="off"></label>
      <div class="row" style="margin-top:10px">
        <button id="don-pump" class="secondary">Give to this pump's account</button>
        <button id="don-pool" class="secondary">Give to shared pool</button>
      </div>
      <div class="msg" id="msg-fund" role="status"></div>
    </div>
    <div class="card">
      ${action}
      <div class="msg" id="msg" role="status"></div>
    </div>
  </div>
  ${steward}
  ${j ? `<h2>Current job</h2>${jobCard(j, true)}` : ""}
  ${history.length ? `<h2>History</h2><div class="grid cols2">${history.map((x) => jobCard(x, false)).join("")}</div>` : ""}`;
}

// ---- transaction links for an invoice's payment lines, from the explorer's token-transfer index.
// The vault pays the mechanic with a USDC transfer; the explorer lists it with the transaction that caused it.
// If the index is unreachable the cell links to the pump account's token transfers instead.
const TXCACHE = new Map();
async function vaultTransfers(vault) {
  if (TXCACHE.has(vault)) return TXCACHE.get(vault);
  const r = await fetch(`${CONFIG.explorerApi}/v1/account/${vault}/ft-txns?per_page=50`);
  if (!r.ok) throw new Error(`explorer ${r.status}`);
  const rows = (await r.json()).txns ?? [];
  TXCACHE.set(vault, rows);
  return rows;
}
async function fillInvoiceTx(j) {
  const cells = [...document.querySelectorAll("[data-tx]")];
  if (!cells.length) return;
  const pm = pumpOf(j.pump);
  const fallback = pm ? `<a href="${CONFIG.explorer}/address/${pm.vault}?tab=tokentxns" target="_blank" rel="noopener">pump account's transfers</a>` : "";
  let rows = null;
  try { rows = await vaultTransfers(pm.vault); } catch { /* fall back below */ }
  const price = BigInt(j.price), first = price * BigInt(S.cfg.params.first_pct) / 100n, held = price - first;
  for (const el of cells) {
    const want = el.dataset.tx === "first" ? first : held;
    const hit = rows?.find((t) => BigInt(t.delta_amount) === -want && t.involved_account_id === j.mechanic && t.cause === "TRANSFER");
    if (el.isConnected) el.innerHTML = hit ? `<a href="${CONFIG.explorer}/txns/${hit.transaction_hash}" target="_blank" rel="noopener">transaction</a>` : fallback;
  }
}

// ---- an invoice a bookkeeper can read
function invoicePage(id) {
  const j = jobById(id);
  if (!j) return `<p><a href="#/ledger">Back</a></p><div class="card empty">No such job.</div>`;
  const pm = pumpOf(j.pump);
  const price = BigInt(j.price);
  const first = price * BigInt(S.cfg.params.first_pct) / 100n;
  const held = price - first;
  const firstE = entriesFor(j, "pay_first"), heldE = entriesFor(j, "pay_held");
  const paidFirst = BigInt(j.paid) > 0n, paidHeld = j.status === "Completed" && held > 0n;
  const line = (label, amt, state, ts, tx) => `<tr><td>${esc(label)}</td><td class="num">${usd(amt)}</td><td>${esc(state)}</td><td class="num">${ts ? esc(when(ts)) : ""}</td><td>${tx ? `<span data-tx="${tx}">...</span>` : ""}</td></tr>`;
  return `<p><a href="#/ledger">&larr; Public ledger</a></p>
  <div class="invoice card">
    <div class="row between"><h1 style="margin:0">Invoice ${invNo(j)}</h1><span class="chip ${j.status === "Completed" ? "ok" : ""}">${esc(invoiceStatus(j))}</span></div>
    <div class="grid cols2 small" style="margin-top:14px">
      <div><span class="label">Paid from</span><p>${pm ? `${esc(pm.name)}<br>${acctLink(pm.vault, pm.vault)}` : "unknown"}</p></div>
      <div><span class="label">Payee (mechanic)</span><p>${j.mechanic ? acctLink(j.mechanic, j.mechanic) : "No mechanic yet"}</p></div>
      <div><span class="label">Opened</span><p>${esc(when(j.opened_ns))}</p></div>
      <div><span class="label">Approved by</span><p>${j.yes.length} of ${j.eligible.length} households asked said it works</p></div>
    </div>
    <div class="tablewrap" style="margin-top:14px"><table>
      <thead><tr><th>Line</th><th>USDC</th><th>Status</th><th>Time</th><th>Transaction</th></tr></thead>
      <tbody>
        ${price > 0n ? line("Repair, quoted total", price, j.status === "Quoted" ? "awaiting steward" : "reserved from the pump's account", 0) : line("Repair, quoted total", 0, "no quote yet", 0)}
        ${price > 0n ? line(`${S.cfg.params.first_pct}% at village approval`, first, paidFirst ? "paid" : "due when the village approves", firstE?.ts, paidFirst ? "first" : "") : ""}
        ${price > 0n ? line(`${100 - S.cfg.params.first_pct}% held ${fmtDur(BigInt(S.cfg.params.hold_ns))}`, held, paidHeld ? "paid" : j.status === "Forfeited" ? "returned to the pump" : j.status === "Approved" ? "held" : "pending", heldE?.ts, paidHeld ? "held" : "") : ""}
      </tbody>
    </table></div>
    <p class="muted small">Currency: Circle's test USDC on NEAR testnet (<span class="mono">${esc(short(CONFIG.token))}</span>). Fees: paid by the relayer or the signer's own NEAR, not deducted here. Every payment is also in the <a href="#/ledger">public ledger</a>.</p>
    <div class="row"><button class="secondary" id="csv-one">Download this invoice (CSV)</button><button class="secondary" id="print">Print</button></div>
  </div>`;
}

function ledgerPage() {
  const rows = [...S.ledger].reverse();
  const KIND = {
    fund: "Funds added",
    pump_added: "Water point and its account created",
    nft_transfer: "NFT handed to a new steward",
    set_cap: "Steward set the quote cap",
    deputy_added: "Steward added a deputy (council member)",
    deputy_removed: "Steward removed a deputy",
    report: "Pump reported broken",
    quote: "Quote above the mechanic's limit, awaiting approval",
    steward_ok: "Quote approved (deputy or steward)",
    quote_rejected: "Quote turned down (deputy or steward)",
    quote_withdrawn: "Mechanic withdrew the quote",
    accept: "Mechanic took the job (price reserved)",
    fix_posted: "Fix posted, households asked",
    vote: "Household voted",
    pay_first: "First share paid to mechanic",
    pay_held: "Held share paid to mechanic",
    pay_failed_first: "First payment refused by the USDC contract (owed)",
    pay_failed_held: "Held payment refused by the USDC contract (owed)",
    pay_retry: "Refused payment tried again",
    pay_recovered: "Refused payment paid after all",
    pay_retry_failed: "Retry refused again",
    pay_reassigned: "Both signers pointed a refused payment at another account",
    forfeit: "Held share returned to the pump",
    rejected: "Village said not fixed",
    redraw: "More households asked",
    disputed: "Marked disputed",
    cancelled: "Cancelled, money returned",
  };
  return `<h1>Public ledger</h1>
  <p class="lead">Every entry is stored by the contract, so anyone can read the same list straight from the chain. Votes show a household number and a time, never a name.</p>
  <div class="row" style="margin-bottom:14px"><button class="secondary" id="csv-jobs">Invoices as CSV (for a bookkeeper)</button><button class="secondary" id="csv-ledger">Ledger as CSV</button></div>
  <h2>Failed payments</h2>
  ${
    S.owed.length
      ? `<p class="muted">If the USDC contract ever refuses a payout, the money stays in the pump's own account and is listed here. Anyone can retry it; the pool registers the payee with the token first. If the payee's account is gone, both signers can point it at another account.</p>
         <div class="card tablewrap"><table><thead><tr><th>#</th><th>Job</th><th>Payee</th><th>Amount (USDC)</th><th>State</th><th></th></tr></thead><tbody>${S.owed
           .map((o) => `<tr><td class="num">${o.id}</td><td><a href="#/job/${o.job}">${invNo({ id: o.job })}</a></td><td class="mono">${esc(o.to)}</td><td class="num">${usd(o.amount)}</td><td>${esc({ Open: "waiting for a retry", Retrying: "retry in progress", Paid: "paid after a retry" }[o.state] ?? o.state)}</td><td>${o.state === "Open" ? `<button class="secondary" data-retry="${o.id}">Retry payment</button>` : ""}</td></tr>`)
           .join("")}</tbody></table></div>
         <div class="msg" id="msg-owed" role="status"></div>`
      : `<p class="muted">No payment has been refused. If the USDC contract ever refuses a payout, the money stays in the pump's own account and is listed here, and anyone can retry it.</p>`
  }
  <h2>Invoices</h2>
  <div class="card tablewrap"><table>
    <thead><tr><th>Invoice</th><th>Water point</th><th>Payee</th><th>Quote (USDC)</th><th>Paid (USDC)</th><th>Status</th></tr></thead>
    <tbody>${
      [...S.jobs].reverse().map((j) => `<tr><td><a href="#/job/${j.id}">${invNo(j)}</a></td><td>${esc(pumpOf(j.pump)?.name ?? j.pump)}</td><td class="mono">${esc(j.mechanic ?? "")}</td><td class="num">${BigInt(j.price) ? usd(j.price) : ""}</td><td class="num">${BigInt(j.paid) ? usd(j.paid) : ""}</td><td>${esc(invoiceStatus(j))}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No repairs yet.</td></tr>`
    }</tbody></table></div>
  <h2>Everything that happened</h2>
  <div class="card tablewrap"><table>
    <thead><tr><th>Time</th><th>What happened</th><th>Job</th><th>Pump</th><th>Amount (USDC)</th><th>Who</th></tr></thead>
    <tbody>${
      rows
        .map(
          (e) => `<tr><td class="num">${esc(when(e.ts))}</td><td>${esc(KIND[e.kind] || e.kind)}</td><td class="num">${e.job === null || e.job === undefined ? "" : "#" + e.job}</td><td class="num">${e.pump === null || e.pump === undefined ? "pool" : e.pump}</td><td class="num">${BigInt(e.amount) ? usd(e.amount) : ""}</td><td class="mono">${esc(e.who)}</td></tr>`,
        )
        .join("") || `<tr><td colspan="6" class="empty">Nothing yet. Fund a pump to start the ledger.</td></tr>`
    }</tbody></table></div>`;
}

// ---- mechanic records and the village committee
/** A DAO proposal in plain words: the function it calls on the pool and the job it is about. */
function propText(p) {
  try {
    const a = p.kind.FunctionCall.actions[0];
    const job = JSON.parse(atob(a.args)).job;
    const verb = { steward_approve: "Approve the quote on", steward_reject: "Turn down the quote on", nft_transfer: "Hand over the pump (nft_transfer), job" }[a.method_name] ?? a.method_name;
    return `${verb} job #${job}${p.kind.FunctionCall.receiver_id === CONFIG.poolId ? "" : " of an earlier, superseded pool"}`;
  } catch {
    return p.description;
  }
}
function communityPage() {
  const t = S.cfg.params;
  const d = S.dao;
  const rows = S.mechs
    .map((m) => `<tr><td class="mono">${esc(m.account)}${m.active ? "" : " (removed)"}</td><td class="num">${m.paid_jobs}</td><td class="num">${m.forfeits}</td><td class="num">${m.score}</td><td class="num">${usd(m.earned)}</td><td class="num">${usd(m.auto_cap)}</td></tr>`)
    .join("");
  const props = d?.proposals ?? [];
  const votes = (p) => {
    const v = p.vote_counts?.council ?? [0, 0, 0];
    return `${v[0]} yes, ${v[1]} no`;
  };
  return `<h1>Community</h1>
  <p class="lead">Who is allowed to do repairs, how they earned that trust, and who decides on big quotes.</p>
  <h2>Mechanic records</h2>
  <p class="muted">A mechanic's score is their finished repairs minus two for each held share that was forfeited. Every point traces to a job in the ledger. The score sets the largest quote they may take with no approval at all: <b class="num">${usd(t.tier0_cap)}</b> USDC at score 0, <b class="num">${usd(t.tier1_cap)}</b> at score 1 or 2, <b class="num">${usd(t.max_price)}</b> at score 3 or more.</p>
  <h3>Three approval tiers</h3>
  <ol class="tiers">
    <li><b>Small, from a trusted mechanic</b>: within their limit above. Taken at once, nobody has to approve.</li>
    <li><b>Mid-size, up to ${usd(t.mid_cap)} USDC</b>: one deputy (a council member of that pump) or the steward approves alone.</li>
    <li><b>Large, up to ${usd(t.max_price)} USDC</b>: only the pump's steward approves. For the Village A pumps the steward is the committee DAO, so this is a proposal the whole council votes on.</li>
  </ol>
  <div class="card tablewrap"><table>
    <thead><tr><th>Mechanic</th><th>Finished jobs</th><th>Forfeits</th><th>Score</th><th>Earned (USDC)</th><th>Takes quotes up to (USDC)</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="6" class="empty">No mechanics registered yet.</td></tr>`}</tbody></table></div>
  <h2>The village committee</h2>
  ${
    d
      ? `<p class="muted">The committee is a Sputnik DAO, ${acctLink(CONFIG.dao, CONFIG.dao)}. It holds the NFTs of the water points it stewards, so its council votes on any large quote (above the council-member limit). Council: ${d.council.map((c) => `<span class="mono">${esc(c)}</span>`).join(", ")}. A proposal passes with more than ${d.threshold ? `${d.threshold[0]}/${d.threshold[1]}` : "half"} of the council (2 of 3). The same three council accounts are the pumps' deputies for mid-size quotes. Each proposal needs a ${near(d.bond, 0)} NEAR bond, returned afterwards.</p>
         <div class="card tablewrap"><table>
           <thead><tr><th>#</th><th>Proposal</th><th>Council votes</th><th>Status</th></tr></thead>
           <tbody>${props.map((p) => `<tr><td class="num">${p.id}</td><td>${esc(propText(p))}</td><td class="num">${votes(p)}</td><td>${esc(p.status)}</td></tr>`).join("") || `<tr><td colspan="4" class="empty">No proposals yet.</td></tr>`}</tbody></table></div>`
      : `<p class="muted">The committee could not be read just now.</p>`
  }`;
}

// ---------------------------------------------------------------- judge sandbox: play every role with real testnet transactions
async function sandboxCred(hh, action) {
  CARDS ??= await fetch("/demo/sandbox-cards.json").then((r) => r.json());
  for (let slot = 0; slot < SLOTS; slot++) {
    if (await view("is_slot_used", { hh, slot })) continue;
    const row = CARDS.cards[hh].rows[slot];
    const code = action === ACTIONS.report ? row.report : action === ACTIONS.yes ? row.yes : row.no;
    return credential(LEVELS, SLOTS, hh, slot, action, code);
  }
  throw new Error(`hh-${hh} has used every row on its printed card. Pick another household.`);
}
const sandbox = (method, args) => post("/api/sandbox", { method, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tryRun(label, fn) {
  return run(document.getElementById("msg-try"), label, async () => {
    const out = await fn();
    if (out && out.ok !== false) {
      if (!out.skipLog) TRY.log.unshift({ label, hash: out.hash });
      TRY.log.length = Math.min(TRY.log.length, 14);
      await sleep(5000); // the public RPC serves finalised state a few seconds late
    }
    return out;
  });
}
const hhOptions = (sel) => Array.from({ length: S.cfg.total_households }, (_, i) => `<option value="${i}"${i === sel ? " selected" : ""}>hh-${i}</option>`).join("");

function tryPage() {
  const pumps = S.pumps;
  if (!pumps.length) return `<h1>Try every role</h1><div class="card empty">No water points registered yet.</div>`;
  if (TRY.pump === null || !pumps.find((x) => x.id === TRY.pump)) TRY.pump = (pumps.find((x) => x.steward === CONFIG.sandboxSteward) ?? pumps[0]).id;
  const pm = pumps.find((x) => x.id === TRY.pump);
  const st = pumpState(pm), j = st.job, p = S.cfg.params;
  const sandboxPump = pm.steward === CONFIG.sandboxSteward;
  const who = {
    villager: `<span class="role">Villager</span> signed by the relayer, which only passes on a household's one-time card code. The pool checks the code on-chain.`,
    mechanic: `<span class="role">Mechanic</span> signed by <span class="mono">${esc(CONFIG.sandboxSteward)}</span>, an account registered on the pool as a sandbox mechanic. Real mechanics use their own wallet on the water point's page.`,
    steward: `<span class="role">Steward</span> the holder of the pump's NFT. For this pump that is <span class="mono">${esc(pm.steward)}</span>, which this page can sign for. Pumps held by the village committee DAO need a council vote instead.`,
  };
  const quoteOpts = [["0.5", "within a new mechanic's limit: taken at once"], ["1", "within a new mechanic's limit: taken at once"], ["2.5", "mid-size: one deputy or the steward approves"], ["4", "large: only the steward approves"]];
  let stage;
  if (!j) {
    stage = `<h3>Step 1. A villager reports the pump broken</h3>
      <p class="muted">${who.villager}</p>
      <div class="row fields"><label>Household<select id="try-hh">${hhOptions(TRY.hh)}</select></label></div>
      <button data-try="report">Report this pump broken</button>`;
  } else if (j.status === "Reported") {
    stage = `<h3>Step 2. A mechanic quotes in USDC</h3>
      <p class="muted">${who.mechanic} A quote up to the mechanic's automatic limit (<b class="num">${usd(mechRec(CONFIG.sandboxSteward)?.auto_cap ?? p.tier0_cap)}</b> USDC) reserves the money at once; up to ${usd(p.mid_cap)} USDC one council member or the steward must approve; above that only the steward.</p>
      <div class="row fields"><label>Quote<select id="try-quote">${quoteOpts.map(([q, note]) => `<option value="${q}"${q === TRY.quote ? " selected" : ""}>${Number(q).toFixed(2)} USDC (${note})</option>`).join("")}</select></label></div>
      <button data-try="accept">Send the quote as the sandbox mechanic</button>`;
  } else if (j.status === "Quoted") {
    stage = `<h3>Step 2b. The steward decides on a big quote</h3>
      <p class="muted">${who.steward} The quote is <b class="num">${usd(j.price)}</b> USDC, above the mechanic's limit, so nothing is reserved yet. ${j.above_mid ? "It is above the council-member limit, so only the steward may approve." : "It is within the council-member limit, so a deputy of the pump could also approve it."}</p>
      ${sandboxPump ? `<div class="row"><button data-try="sapprove">Approve as the steward</button><button class="secondary" data-try="sreject">Turn the quote down</button></div>` : `<p>This pump is held by ${esc(holderName(pm.steward))}. Approval is a DAO proposal that its council votes on: see <a href="#/community">Community</a>. Pick a Village B pump to play the steward yourself.</p>`}`;
  } else if (j.status === "Accepted") {
    stage = `<h3>Step 3. The mechanic says it is fixed</h3>
      <p class="muted">${who.mechanic} Posting the fix draws ${p.sample_size} random households, using NEAR's on-chain random seed.</p>
      <button data-try="fix">Post the fix</button>
      ${j.attempts > 0 ? `<p class="muted">The village said the first fix did not work, so the mechanic is trying again.</p>` : ""}`;
  } else if (j.status === "Voting") {
    const replied = new Set([...j.yes, ...j.no]);
    const pending = j.eligible.filter((h) => !replied.has(h));
    const need = Math.min(p.min_replies, j.eligible.length);
    const windowEnd = BigInt(j.draw_ns) + BigInt(p.vote_window_ns);
    const late = nowNs() > windowEnd && j.yes.length + j.no.length < need;
    stage = `<h3>Step 4. The village checks the pump</h3>
      <p class="muted">${who.villager} ${need} replies are needed and two thirds must say it works. So far: ${j.yes.length} works, ${j.no.length} still broken.</p>
      <ul class="voters">${pending
        .map((h) => `<li><b>hh-${h}</b><span class="row"><button class="secondary" data-try="vote" data-hh="${h}" data-works="1">It works</button><button class="secondary" data-try="vote" data-hh="${h}" data-works="0">Still broken</button></span></li>`)
        .join("") || `<li class="muted">Every asked household has replied.</li>`}</ul>
      <div class="row" style="margin-top:12px"><button data-try="allyes">Make the village say it works</button>${late ? `<button class="secondary" data-try="redraw">Too few replied: ask more households</button>` : ""}</div>`;
  } else if (j.status === "Approved") {
    const end = BigInt(j.approved_ns) + BigInt(p.hold_ns);
    const due = nowNs() >= end;
    stage = `<h3>Step 5. Paid from the pump's own account, with a share held</h3>
      <p>The mechanic was paid <b class="num">${usd(j.paid)}</b> USDC at once, straight from <span class="mono">${esc(short(pm.vault))}</span>. <b class="num">${usd(j.held)}</b> USDC is held. ${due ? "The hold has passed." : `It can be released in <span class="num" data-countdown="${end}">${fmtDur(end - nowNs())}</span>.`} Broken-again reports so far: ${j.rebroken.length} of ${p.rebroken_needed}.</p>
      ${due ? `<button data-try="release">Release the held share to the mechanic</button>` : ""}
      <h3 style="margin-top:18px">Or: it breaks again during the hold</h3>
      <p class="muted">${who.villager} Two different households must report it. Then the held share goes back to the pump's own balance.</p>
      <div class="row fields"><label>Household<select id="try-hh">${hhOptions(TRY.hh)}</select></label></div>
      <button class="danger" data-try="report">Report broken again</button>`;
  } else {
    stage = `<h3>This job has ended: ${esc(j.status)}</h3><p class="muted">Pick another water point to start a fresh repair.</p>`;
  }
  const hh = TRY.hh;
  return `<h1>Try every role</h1>
  <p class="lead">Play a whole repair yourself, on NEAR testnet. Every button sends a real transaction to the pool contract and shows its link. No wallet is needed. The money is Circle's test USDC.</p>
  <div class="roles">
    <div><span class="role">Villager</span><p>Reports and votes with a one-time code from a printed card. The relayer pays the gas.</p></div>
    <div><span class="role">Mechanic</span><p>Quotes, and posts the fix. Here a sandbox account signs; on the water point's page you use your own wallet.</p></div>
    <div><span class="role">Steward</span><p>Holds the pump's NFT and approves big quotes. On Village B pumps this page signs for the steward; on Village A pumps a council member or the committee DAO decides.</p></div>
    <div><span class="role">Donor</span><p>Sends USDC from a NEAR wallet. <a href="#/pump/${pm.id}">Open this water point</a> to give.</p></div>
    <div><span class="role">Observer</span><p>Reads the public ledger, invoices, mechanic records and each pump's NFT. Nothing to sign.</p></div>
  </div>
  <div class="card">
    <div class="row between"><label>Water point<select id="try-pump">${pumps.map((x) => `<option value="${x.id}"${x.id === TRY.pump ? " selected" : ""}>${esc(x.name)}${x.steward === CONFIG.sandboxSteward ? " (sandbox steward)" : " (committee DAO)"}</option>`).join("")}</select></label>${chipFor(st.key)}</div>
    <div style="margin-top:18px">${stage}</div>
    <div class="msg" id="msg-try" role="status"></div>
  </div>
  <div class="grid cols2">
    <div class="card"><div class="row between"><b>NFT of this water point, and its account</b><span class="chip">NEP-171, transferable</span></div>${nftBox("pump-" + pm.id, pm)}<p class="muted small">Its own account holds <b class="num">${usd(pm.vaultBal)}</b> USDC right now.</p></div>
    <div class="card"><div class="row between"><b>NFT of household hh-${hh}</b><span class="chip">credential, not transferable</span></div>${nftBox("hh-" + hh)}</div>
  </div>
  ${TRY.log.length ? `<h2>What you sent</h2><ol class="txlog">${TRY.log.map((e) => `<li>${esc(e.label)}${e.hash ? txLink(e.hash) : ""}</li>`).join("")}</ol>` : ""}
  <p class="muted small">Each action waits a few seconds for the public RPC to catch up. <a href="#/ledger">The public ledger</a> shows the same events.</p>`;
}

function tryAct(kind, d) {
  const pm = S.pumps.find((x) => x.id === TRY.pump);
  const j = pm && pumpState(pm).job;
  const hhSel = () => Number(document.getElementById("try-hh")?.value ?? TRY.hh);
  if (kind === "report") {
    const hh = hhSel();
    return tryRun(`hh-${hh} reports the pump broken`, async () => relay("report_broken", { pump: TRY.pump, cred: await sandboxCred(hh, ACTIONS.report) }));
  }
  if (kind === "accept") {
    const price = toUnits(document.getElementById("try-quote").value).toString();
    return tryRun("Sandbox mechanic sends a quote", () => sandbox("accept_job", { job: j.id, price }));
  }
  if (kind === "sapprove") return tryRun("Steward approves the quote", () => sandbox("steward_approve", { job: j.id }));
  if (kind === "sreject") return tryRun("Steward turns the quote down", () => sandbox("steward_reject", { job: j.id }));
  if (kind === "fix") return tryRun("Sandbox mechanic posts the fix", () => sandbox("post_fix", { job: j.id }));
  if (kind === "vote") {
    const hh = Number(d.hh), works = d.works === "1";
    return tryRun(`hh-${hh} says ${works ? "it works" : "it is still broken"}`, async () => relay("vote", { job: j.id, works, cred: await sandboxCred(hh, works ? ACTIONS.yes : ACTIONS.no) }));
  }
  if (kind === "allyes") {
    return tryRun("The village says it works", async () => {
      const p = S.cfg.params, replied = new Set([...j.yes, ...j.no]);
      const need = Math.max(1, Math.min(p.min_replies, j.eligible.length) - replied.size);
      for (const h of j.eligible.filter((x) => !replied.has(x)).slice(0, need)) {
        const out = await relay("vote", { job: j.id, works: true, cred: await sandboxCred(h, ACTIONS.yes) });
        if (out.ok === false) return out;
        TRY.log.unshift({ label: `hh-${h} says it works`, hash: out.hash });
      }
      return { ok: true, skipLog: true };
    });
  }
  if (kind === "redraw") return tryRun("Asking more households", () => relay("redraw_sample", { job: j.id }));
  if (kind === "release") return tryRun("Releasing the held share", () => relay("release_held", { job: j.id }));
}

function aboutPage() {
  return `<h1>What this is not, and where it can fail</h1>
  <p class="lead">Read this before relying on anything here.</p>
  <ul>
    <li><b>A vote is not proof.</b> The village confirming a repair means the village said so. A sensor on the handle would be stronger; this is the cheap fallback.</li>
    <li><b>The roll is a one-time trust point.</b> Two independent signers enrol the households. If both are dishonest, they can pad it.</li>
    <li><b>Cards can be bought or stolen.</b> Keep each payout smaller than the cost of buying enough codes.</li>
    <li><b>Votes can be linked to a card.</b> Anyone who knows which card belongs to whom can see who voted what. The chain cannot stop pressure on villagers.</li>
    <li><b>Phones.</b> The SMS path is described, not built. Where there is almost no phone coverage this does not work.</li>
    <li><b>The money is Circle's testnet USDC.</b> It has no value. Cash-out to mobile money for the mechanic and NEAR Intents top-ups from other chains are not built (Intents has no testnet). A real deployment needs a licensed off-ramp partner and local stablecoin rules checked.</li>
    <li><b>The stewards on this demo are test accounts.</b> The village committee is a real Sputnik DAO, but its three council accounts are ours. A real village would choose its own people.</li>
    <li><b>Refused payouts are recoverable.</b> If the USDC contract refuses a payout, the amount is recorded as owed and stays in the pump's account until it is paid or pointed at another account by both signers. The records never count it as paid in the meantime.</li>
    <li><b>Direct gifts to a pump's account.</b> Send USDC with <span class="mono">ft_transfer_call</span> (the buttons do this) so the pool records it. A plain transfer to a pump's account is held safely but is not counted by the pool until it is credited.</li>
    <li><b>Gas.</b> Villagers and the sandbox are gasless through the relayer. Real mechanics and stewards sign with their own wallet and need a little testnet NEAR; a full meta-transaction relay for them is not built.</li>
    <li><b>"Five-mile walk" is an illustration, not a measurement.</b> The headline is rhetoric; I have no source for a typical distance, and the distance varies enormously between places.</li>
    <li><b>The problem is real, the numbers are not ours.</b> The "about one in four handpumps out of order" line comes from a review of field data from sub-Saharan Africa and Asia-Pacific (<a href="https://waterpointdata.org/wp-content/uploads/2020/11/Functionality-of-handpump-water-supplies.pdf" target="_blank" rel="noopener">Foster and others, Functionality of handpump water supplies</a>). The review itself warns that "functional" is defined differently from source to source, so treat it as an order of magnitude.</li>
    <li><b>Prior art already works.</b> FundiFix pools monthly mobile-money payments and fixes pumps within days. This adds a donor-visible fund that nobody holds.</li>
    <li><b>Not tested with any village.</b> It needs a field pilot.</li>
  </ul>`;
}

// ---------------------------------------------------------------- interactions
function wire(r) {
  document.getElementById("runcheck")?.addEventListener("click", runCheck);
  fillNft();
  if (r.name === "ledger") {
    document.getElementById("csv-jobs")?.addEventListener("click", () => download("wellkeep-invoices.csv", invoiceRows()));
    document.getElementById("csv-ledger")?.addEventListener("click", () => download("wellkeep-ledger.csv", ledgerRows()));
    $main.querySelectorAll("[data-retry]").forEach((b) =>
      b.addEventListener("click", () => run(document.getElementById("msg-owed"), "Retrying the payment", () => relay("retry_payment", { id: Number(b.dataset.retry) }))),
    );
    return;
  }
  if (r.name === "job") {
    document.getElementById("print")?.addEventListener("click", () => window.print());
    fillInvoiceTx(jobById(r.id));
    document.getElementById("csv-one")?.addEventListener("click", () => {
      const rows = invoiceRows();
      const no = invNo(jobById(r.id));
      download(`${no}.csv`, [rows[0], rows.find((x) => x[0] === no)]);
    });
    return;
  }
  if (r.name === "try") {
    $main.querySelectorAll("[data-try]").forEach((b) => b.addEventListener("click", () => tryAct(b.dataset.try, b.dataset)));
    document.getElementById("try-pump")?.addEventListener("change", (e) => { TRY.pump = Number(e.target.value); render(); });
    document.getElementById("try-hh")?.addEventListener("change", (e) => { TRY.hh = Number(e.target.value); render(); });
    document.getElementById("try-quote")?.addEventListener("change", (e) => { TRY.quote = e.target.value; });
    return;
  }
  if (r.name !== "pump") return;
  const id = r.id;
  const msg = document.getElementById("msg");
  const fmsg = document.getElementById("msg-fund");
  const smsg = document.getElementById("msg-steward");
  const donate = (to) =>
    run(fmsg, "Giving", () => {
      const amt = Number(document.getElementById("don-amt").value);
      if (!(amt >= 0.1)) return { ok: false, error: "The smallest gift is 0.1 USDC." };
      return W.callContract(CONFIG.token, "ft_transfer_call", { receiver_id: CONFIG.poolId, amount: toUnits(amt).toString(), msg: to === null ? "pool" : `pump:${to}` }, "1", "200000000000000");
    });
  document.getElementById("don-pump")?.addEventListener("click", () => donate(id));
  document.getElementById("don-pool")?.addEventListener("click", () => donate(null));

  const pm = S.pumps.find((x) => x.id === id);
  const j = pm && pumpState(pm).job;
  document.getElementById("act-report")?.addEventListener("click", () =>
    run(msg, "Reporting the pump broken", async () => {
      const c = readCard("rep", ACTIONS.report);
      if (c.error) return { ok: false, error: c.error };
      return relay("report_broken", { pump: id, cred: c.cred });
    }),
  );
  document.getElementById("act-accept")?.addEventListener("click", () =>
    run(msg, "Sending the quote", () => {
      const price = toUnits(document.getElementById("quote").value);
      return W.callPool(CONFIG.poolId, "accept_job", { job: j.id, price: price.toString() });
    }),
  );
  document.getElementById("act-sapprove")?.addEventListener("click", () => run(msg, "Approving the quote", () => W.callPool(CONFIG.poolId, "steward_approve", { job: j.id })));
  document.getElementById("act-sreject")?.addEventListener("click", () => run(msg, "Turning the quote down", () => W.callPool(CONFIG.poolId, "steward_reject", { job: j.id })));
  document.getElementById("act-withdraw")?.addEventListener("click", () => run(msg, "Withdrawing the quote", () => W.callPool(CONFIG.poolId, "withdraw_quote", { job: j.id })));
  document.getElementById("act-fix")?.addEventListener("click", () => run(msg, "Posting the fix", () => W.callPool(CONFIG.poolId, "post_fix", { job: j.id })));
  const deputy = (on) => run(smsg, on ? "Adding the deputy" : "Removing the deputy", () => {
    const account = document.getElementById("dep-acct").value.trim();
    if (!account) return { ok: false, error: "Type the account of the council member." };
    return W.callPool(CONFIG.poolId, "set_deputy", { pump: id, account, on });
  });
  document.getElementById("act-depadd")?.addEventListener("click", () => deputy(true));
  document.getElementById("act-depdel")?.addEventListener("click", () => deputy(false));
  document.getElementById("act-cap")?.addEventListener("click", () =>
    run(smsg, "Setting the cap", () => W.callPool(CONFIG.poolId, "set_quote_cap", { pump: id, cap: toUnits(document.getElementById("cap").value).toString() })),
  );
  document.getElementById("act-xfer")?.addEventListener("click", () =>
    run(smsg, "Transferring the NFT", () => {
      const to = document.getElementById("xfer-to").value.trim();
      if (!to) return { ok: false, error: "Type the account that should hold the pump." };
      return W.callContract(CONFIG.poolId, "nft_transfer", { receiver_id: to, token_id: `pump-${id}` }, "1", "50000000000000");
    }),
  );
  const voteAs = async (works) => {
    const c = readCard("vote", works ? ACTIONS.yes : ACTIONS.no);
    if (c.error) return { ok: false, error: c.error };
    return relay("vote", { job: j.id, works, cred: c.cred });
  };
  document.getElementById("act-yes")?.addEventListener("click", () => run(msg, "Vote: it works", () => voteAs(true)));
  document.getElementById("act-no")?.addEventListener("click", () => run(msg, "Vote: still broken", () => voteAs(false)));
  document.getElementById("act-redraw")?.addEventListener("click", () => run(msg, "Asking more households", () => relay("redraw_sample", { job: j.id })));
  document.getElementById("act-release")?.addEventListener("click", () => run(msg, "Releasing the held share", () => relay("release_held", { job: j.id })));
}

async function runCheck() {
  const btn = document.getElementById("runcheck");
  const list = document.getElementById("checks");
  btn.disabled = true;
  list.innerHTML = `<li class="muted">Reading the chain...</li>`;
  try {
    const { runChecks } = await import("/verify-bundle.js");
    const results = await runChecks({ rpcUrl: CONFIG.rpcUrls ?? CONFIG.rpcUrl, poolId: CONFIG.poolId, wasmUrl: "/evidence/wellkeep_pool.wasm", vaultWasmUrl: "/evidence/wellkeep_vault.wasm", stateUrl: "/evidence/state-init.json" });
    lastChecks = results;
    list.innerHTML = checksHtml();
    say(null, results.every((x) => x.ok) ? "All checks passed" : "Some checks failed");
  } catch (e) {
    list.innerHTML = `<li class="msg err">The check could not run: ${esc(e.message)}</li>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- boot
setInterval(() => {
  document.querySelectorAll("[data-countdown]").forEach((el) => {
    const left = BigInt(el.dataset.countdown) - nowNs();
    el.textContent = left > 0n ? fmtDur(left) : "now";
    if (left <= 0n && !busy && !el.dataset.refreshed) {
      el.dataset.refreshed = "1";
      refresh(); // the hold just ended: show the release button
    }
  });
}, 1000);
setInterval(() => {
  if (!busy && document.visibilityState === "visible" && !document.activeElement?.matches("select, input, textarea") && !document.querySelector("details[open]")) refresh();
}, 30000);
window.addEventListener("hashchange", () => {
  for (const k in lastMsg) delete lastMsg[k];
  render();
});

(async function boot() {
  try {
    CONFIG = await (await fetch("/config.json")).json();
    const leaves = await fetch("/demo/leaves.json").then((r) => r.json());
    SLOTS = leaves.slots;
    LEVELS = await buildLevels(leaves.leaves.map(fromHex));
  } catch (e) {
    $main.innerHTML = `<div class="card"><h2>Could not start</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  await refresh();
  initWallet();
})();

async function initWallet() {
  const btn = document.getElementById("wallet-btn");
  try {
    W = await import("/wallet-bundle.js");
    await W.init();
  } catch (e) {
    btn.textContent = "Wallet unavailable";
    btn.disabled = true;
    return;
  }
  W.onAccount(async (acct) => {
    walletAcct = acct;
    isMech = false;
    if (acct) {
      btn.textContent = `${short(acct)} (disconnect)`;
      try { isMech = await view("is_mechanic", { account: acct }); } catch { /* leave false */ }
    } else btn.textContent = "Connect wallet";
    if (!busy && S.cfg) render();
  });
  btn.addEventListener("click", async () => {
    try {
      if (walletAcct) await W.disconnect();
      else await W.connect();
    } catch (e) {
      say(null, `Wallet: ${e.message || e}`);
    }
  });
}

document.getElementById("gocheck")?.addEventListener("click", () => {
  document.getElementById("check")?.scrollIntoView({ behavior: "smooth", block: "start" });
  runCheck();
});

// Looping typewriter for the opening fact: types, holds, erases, types again. The full text stays in the DOM
// (screen readers get it at once). Skipped for reduced motion; pauses while the tab or the hero is off screen.
(function typewriter() {
  const span = document.querySelector("#hero-fact .tw");
  if (!span || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const full = span.textContent;
  span.innerHTML = `<span class="sr">${esc(full)}</span><span aria-hidden="true"><span class="tw-d typing"></span><span class="tw-r">${esc(full)}</span></span>`;
  const done = span.querySelector(".tw-d"), rest = span.querySelector(".tw-r");
  const hero = document.getElementById("hero");
  let n = 0, dir = 1, hold = 0;
  const show = () => { done.textContent = full.slice(0, n); rest.textContent = full.slice(n); };
  const tick = () => {
    const seen = !document.hidden && !hero.hidden && hero.getBoundingClientRect().bottom > 0;
    let wait = dir > 0 ? 30 : 12;
    if (seen) {
      if (hold > 0) { hold -= 1; wait = 100; }
      else if (dir > 0) {
        n += 1; show();
        if (n >= full.length) { dir = -1; hold = 30; } // read it for about 3 s
      } else {
        n -= 1; show();
        if (n <= 0) { dir = 1; hold = 5; }
      }
    } else wait = 300;
    setTimeout(tick, wait);
  };
  setTimeout(tick, 700);
})();
