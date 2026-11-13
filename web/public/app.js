import { buildLevels, credential, fromHex, ACTIONS } from "/merkle.js";
import { mountWatch } from "/watch.js";

const $main = document.getElementById("main");
const $live = document.getElementById("live");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const Y = 10n ** 24n;

let CONFIG, LEVELS, SLOTS, W = null;
let walletAcct = null;
let isMech = false;
let S = { cfg: null, pumps: [], jobs: [], ledger: [], balance: "0", chainNow: 0n, fetchedAt: 0 };
const usedCache = new Map();
let busy = false;
let lastRoute = null;
let lastChecks = null; // survives the periodic re-render
const TRY = { pump: null, hh: 20, quote: "0.2", log: [] }; // the judge sandbox keeps its place across re-renders
const NFT = new Map(); // nft_token reads, cached (a record never changes)
let CARDS = null;

// ---------------------------------------------------------------- chain reads (public RPC, direct)
async function rpc(method, params) {
  const r = await fetch(CONFIG.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.data || j.error.message);
  return j.result;
}
async function view(method, args = {}) {
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONFIG.poolId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
}

async function load() {
  const [cfg, pumps, jobs, ledger, acct, block] = await Promise.all([
    view("get_config"),
    view("list_pumps"),
    view("list_jobs", { from: 0, limit: 100 }),
    view("list_ledger", { from: 0, limit: 400 }),
    rpc("query", { request_type: "view_account", finality: "final", account_id: CONFIG.poolId }),
    rpc("block", { finality: "final" }),
  ]);
  S = { cfg, allPumps: pumps.map(([id, p]) => ({ id, ...p })), pumps: pumps.filter(([id]) => !(CONFIG.hiddenPumps || []).includes(id)).map(([id, p]) => ({ id, ...p })), jobs, ledger, balance: acct.amount, chainNow: BigInt(block.header.timestamp), fetchedAt: Date.now() };
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
const toYocto = (n) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 18n;
const when = (ns) => (BigInt(ns) === 0n ? "" : new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString());
const explorer = (acc) => `${CONFIG.explorer}/address/${acc}`;
const txLink = (h) => (h ? ` <a href="${CONFIG.explorer}/txns/${h}" target="_blank" rel="noopener">transaction</a>` : "");
const short = (id) => (id.length > 24 ? `${id.slice(0, 10)}...${id.slice(-6)}` : id);

function fmtDur(ns) {
  let s = Math.max(0, Math.ceil(Number(ns) / 1e9));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s %= 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
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
  Accepted: ["Mechanic repairing", "warn"],
  Voting: ["Awaiting village check", "warn"],
  Approved: ["Fixed, 30% on hold", "ok"],
  Disputed: ["Disputed", "bad"],
};
const chipFor = (k) => {
  const [t, c] = STATE_LABEL[k] || [k, ""];
  return `<span class="chip ${c}">${esc(t)}</span>`;
};
function reservedTotal() {
  return S.jobs.reduce((a, j) => {
    if (["Accepted", "Voting", "Approved", "Disputed"].includes(j.status)) return a + (BigInt(j.price) - BigInt(j.paid));
    return a;
  }, 0n);
}

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
  }
}
const relay = (method, args) => post("/api/relay", { method, args });

// ---------------------------------------------------------------- routing and render
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const m = h.match(/^\/pump\/(\d+)$/);
  if (m) return { name: "pump", id: Number(m[1]) };
  if (h === "/ledger") return { name: "ledger" };
  if (h === "/try") return { name: "try" };
  if (h === "/about") return { name: "about" };
  return { name: "home" };
}
function setTabs(name) {
  document.querySelectorAll(".tabs a").forEach((a) => {
    const on = a.dataset.route === (name === "pump" ? "home" : name);
    if (on) a.setAttribute("aria-current", "page");
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
  else if (r.name === "ledger") $main.innerHTML = ledgerPage();
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
  for (const id of ["msg", "msg-fund", "msg-try"]) {
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
    $main.innerHTML = `<div class="card"><h2>Could not read the chain</h2><p class="muted">${esc(e.message)}</p><button id="retry">Try again</button></div>`;
    document.getElementById("retry")?.addEventListener("click", refresh);
    return;
  }
  render();
}

// ---------------------------------------------------------------- pages
function homePage() {
  const cfg = S.cfg;
  const earmarked = S.allPumps.reduce((a, p) => a + BigInt(p.earmark), 0n);
  const free = BigInt(cfg.free);
  const reserved = reservedTotal();
  const p = cfg.params;
  return `
  <div class="statrow reveal">
    <div><div class="label">Shared pool, free</div><div class="stat num"><span data-k="free">${near(free)}</span> <small>NEAR</small></div></div>
    <div><div class="label">Earmarked for a pump</div><div class="stat num"><span data-k="earm">${near(earmarked)}</span> <small>NEAR</small></div></div>
    <div><div class="label">Reserved for open repairs</div><div class="stat num"><span data-k="resv">${near(reserved)}</span> <small>NEAR</small></div></div>
  </div>
  <p class="poolline row between"><span>Pool account <a class="mono" href="${explorer(CONFIG.poolId)}" target="_blank" rel="noopener">${esc(CONFIG.poolId)}</a>. It also holds a small storage reserve of NEAR that is not part of the fund (account balance ${near(S.balance, 2)} NEAR).</span><span class="livebar" role="status"><i class="live-dot" aria-hidden="true"></i>Live from the chain, updated <span id="ago">just now</span></span></p>

  <a class="trystrip reveal" href="#/try"><span><span class="kicker">For judges and curious visitors</span><b>Play every role: villager, mechanic, village vote</b><em>Real NEAR testnet transactions. No wallet needed.</em></span><span aria-hidden="true">&rarr;</span></a>

  <section class="sec reveal" aria-labelledby="pumps">
    <div class="sec-head"><div><span class="kicker">Water points</span><h2 id="pumps">The pumps this fund keeps running</h2></div></div>
    <ol class="plist">
    ${S.pumps
      .map((pm) => {
        const st = pumpState(pm);
        return `<li><a href="#/pump/${pm.id}" aria-label="Open ${esc(pm.name)}"><b>${esc(pm.name)}<small class="nfttag">NFT pump-${pm.id}</small></b><span class="ear">Earmarked <span class="num">${near(pm.earmark)}</span> NEAR</span>${chipFor(st.key)}<span class="go" aria-hidden="true">&rarr;</span></a></li>`;
      })
      .join("") || `<li class="empty">No water points registered yet.</li>`}
    </ol>
  </section>

  <section class="sec reveal" aria-label="The idea">
    <span class="kicker">The idea</span>
    <p class="statement">A well is only the start. Keeping it running is the hard part.</p>
    <p class="statement-sub">That is what this fund pays for, in the open.</p>
  </section>

  <section class="bandblack reveal" aria-labelledby="how-h">
    <div class="wrap">
      <span class="eyebrow">How it works</span>
      <h2 id="how-h">Five steps. Nobody holds a key.</h2>
      <ol class="steps">
        <li><b>Check before you give</b>Press the check below: it recomputes the fund's address and shows that no one holds a key to it.</li>
        <li><b>Fund it</b>Connect your own NEAR testnet wallet and give to a pump or to the shared pool.</li>
        <li><b>Report</b>A household types its number and a code from its printed card to report the pump broken. A job opens.</li>
        <li><b>Fix and check</b>A registered mechanic signs in with their own wallet, accepts and posts the fix. The reporter and ${p.sample_size} random households are asked; ${p.min_replies} replies are needed and two thirds must say it works.</li>
        <li><b>Pay and hold</b>${p.first_pct}% is paid at once. The rest is held for ${fmtDur(BigInt(p.hold_ns))} (short on this testnet build so it can be watched) and released unless two households report it broken again.</li>
      </ol>
    </div>
  </section>

  <section class="sec reveal" aria-label="Watch a repair"><div id="watch-slot"></div></section>

  <section class="sec reveal" aria-labelledby="why-near">
    <div class="sec-head"><div><span class="kicker">Why NEAR</span><h2 id="why-near">An address that proves its own rules</h2></div></div>
    <div class="facts">
      <div><b>The address is the proof</b><p>On NEAR, a deterministic account's address is derived from its code and starting state. This page recomputes it in your browser and compares it with the fund's address.</p></div>
      <div><b>No key, no swap</b><p>The fund has no access keys, and its code is a global contract referenced by hash. The publisher cannot sign for it or change the code, and the chain says so.</p></div>
      <div><b>Villagers hold no NEAR</b><p>A relayer pays the fee for reports and votes. Donors and mechanics sign with their own wallets. Only the relayer runs on this server.</p></div>
    </div>
    <div class="stack">
      <span class="label">NEAR pieces used in this build</span>
      <ul>
        <li><b>NEAR testnet</b> holds the fund, the jobs and the ledger.</li>
        <li><b>Global contract by hash</b>: the code cannot be swapped.</li>
        <li><b>Deterministic <span class="mono">0s</span> account</b>: its address commits to its code and state.</li>
        <li><b>NEP-171 NFT records</b>: <span data-nft-supply>...</span> in total, one per water point and per household. Read with <span class="mono">nft_token</span>.</li>
        <li><b>NEAR on-chain random seed</b> draws the households who vote.</li>
        <li><b>near-sdk</b> (Rust) contract, <b>near-kit</b> in the relayer, a <b>NEAR wallet</b> for donors and mechanics, the NEAR RPC and NEAR Explorer.</li>
      </ul>
    </div>
    <p class="muted small facts-note">The repair rule itself could be written on another chain. What it would not have is an address that proves its own code, so a donor still has to trust whoever deployed it.</p>
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
    ["Reported", ["Reported", "Accepted", "Voting", "Approved", "Completed"]],
    ["Mechanic accepted", ["Accepted", "Voting", "Approved", "Completed"]],
    ["Fix posted, village asked", ["Voting", "Approved", "Completed"]],
    ["Village confirmed, first share paid", ["Approved", "Completed"]],
    ["Held share released", ["Completed"]],
  ];
  const rank = { Reported: 0, Accepted: 1, Voting: 2, Approved: 3, Completed: 4 };
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
  if (j.status === "Voting") {
    extra = `<p>Asked: ${asked.length} households. Replies ${replies} of ${needed} needed. Works: ${j.yes.length}, still broken: ${j.no.length}.</p>
      <div class="asked">${asked.map((h) => `<span class="hh ${j.yes.includes(h) ? "yes" : j.no.includes(h) ? "no" : ""}">hh-${h}</span>`).join("")}</div>`;
  }
  if (j.status === "Approved") {
    const end = BigInt(j.approved_ns) + BigInt(S.cfg.params.hold_ns);
    const left = end - nowNs();
    extra = `<p>Paid <b class="num">${near(j.paid)}</b> NEAR. Held <b class="num">${near(j.held)}</b> NEAR. ${left > 0n ? `Releases in <span class="num" data-countdown="${end}">${fmtDur(left)}</span>.` : "The hold has passed: anyone can release it."} Broken-again reports so far: ${j.rebroken.length} of ${S.cfg.params.rebroken_needed}.</p>`;
  }
  if (j.status === "Completed") extra = `<p>Paid in full: <b class="num">${near(j.paid)}</b> NEAR to <span class="mono">${esc(j.mechanic || "")}</span>.</p>`;
  if (j.status === "Forfeited") extra = `<p>The held share went back to the fund after households reported the pump broken again. Paid so far: <b class="num">${near(j.paid)}</b> NEAR.</p>`;
  if (j.status === "Disputed") extra = `<p>The village check did not settle. Both signers must cancel it (the reserved money then returns to the fund).</p>`;
  if (j.status === "Cancelled") extra = `<p>Cancelled; reserved money returned to the fund.</p>`;
  if (j.attempts > 0 && j.status === "Accepted") extra += `<p class="muted">The village said the first fix did not work. The mechanic must try again.</p>`;
  return `<div class="card">
    <div class="row between"><b>Job #${j.id}</b><span class="chip">${esc(j.status)}</span></div>
    ${j.mechanic ? `<p class="muted">Mechanic <span class="mono">${esc(j.mechanic)}</span>, quote <span class="num">${near(j.price)}</span> NEAR</p>` : `<p class="muted">Reported by ${j.reporters.length} household(s): ${j.reporters.map((h) => "hh-" + h).join(", ")}. Waiting for a mechanic.</p>`}
    ${full ? timeline(j) : ""}${extra}
  </div>`;
}

function pumpPage(id) {
  const pm = S.pumps.find((x) => x.id === id);
  if (!pm) return `<p><a href="#/">Back</a></p><div class="card empty">No such water point.</div>`;
  const st = pumpState(pm);
  const j = st.job;
  const history = S.jobs.filter((x) => x.pump === id && (!j || x.id !== j.id)).reverse();
  const p = S.cfg.params;
  const maxPrice = near(p.max_price);

  const mechNote = walletAcct
    ? isMech
      ? `<p class="muted">Signed in as <span class="mono">${esc(walletAcct)}</span>, a registered mechanic.</p>`
      : `<p class="muted">Signed in as <span class="mono">${esc(walletAcct)}</span>, which is not a registered mechanic. The contract will refuse. Both signers must register an account first.</p>`
    : `<p class="muted">Connect your wallet (top right) with a registered mechanic account.</p>`;
  let action = "";
  if (!j) {
    action = `<h3>Report this pump broken</h3>
      <p class="muted">A household reports with a one-time code from its printed card. The relayer submits it and pays the fee; the household holds no NEAR.</p>
      ${cardFields("rep", "Code (column: Report broken)")}
      <button id="act-report">Report broken</button>`;
  } else if (j.status === "Reported") {
    action = `<h3>Next: a mechanic takes the job</h3>
      <p class="muted">The price is reserved from the fund (earmark first), capped at ${maxPrice} NEAR.</p>
      ${mechNote}
      <label>Quote (NEAR)<input id="quote" type="number" autocomplete="off" spellcheck="false" min="0.01" max="${maxPrice}" step="0.01" value="0.5" inputmode="decimal"></label>
      <p><button id="act-accept">Accept the job</button></p>`;
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
      <p class="muted">If two different households report it broken again before the hold ends, the held share goes back to the fund instead.</p>
      ${due ? `<button id="act-release">Release the held share to the mechanic</button>` : `<p>Not yet: <span class="num" data-countdown="${end}">${fmtDur(end - nowNs())}</span> left.</p>`}
      <h3 style="margin-top:18px">Or: it broke again</h3>
      ${cardFields("rep", "Code (column: Report broken)")}
      <button id="act-report" class="danger">Report broken again</button>`;
  } else if (j.status === "Disputed") {
    action = `<p>This job needs both signers to cancel it. That is an admin step done outside this page.</p>`;
  }

  return `<p><a href="#/">&larr; All water points</a></p>
  <div class="row between"><h1 style="margin:0">${esc(pm.name)}</h1>${chipFor(st.key)}</div>
  <p class="muted">Earmarked: <b class="num">${near(pm.earmark)}</b> NEAR. Shared pool free: <b class="num">${near(S.cfg.free)}</b> NEAR. <a href="#/try">Play every role on this site</a> without a wallet.</p>
  <div class="card"><div class="row between"><b>NFT record <span class="mono">pump-${pm.id}</span></b><span class="chip">NEP-171 read, non-transferable</span></div>${nftBox("pump-" + pm.id)}<p class="muted small">Read live from <span class="mono">nft_token</span> on the pool contract. <span class="mono">nft_transfer</span> is disabled on purpose: this is a record of the water point, not a tradable asset.</p></div>

  <div class="grid cols2">
    <div class="card">
      <h3>Add funds</h3>
      <p class="muted">${walletAcct ? `Giving from <span class="mono">${esc(walletAcct)}</span> (testnet NEAR).` : "Connect your NEAR testnet wallet (top right) to give. You sign the payment yourself; this site never holds your key."} Giving from another chain through NEAR Intents is not built: Intents has no testnet.</p>
      <label>Amount (NEAR)<input id="don-amt" type="number" min="0.1" step="0.1" value="1" inputmode="decimal" autocomplete="off"></label>
      <div class="row" style="margin-top:10px">
        <button id="don-pump" class="secondary">Give to this pump</button>
        <button id="don-pool" class="secondary">Give to shared pool</button>
      </div>
      <div class="msg" id="msg-fund" role="status"></div>
    </div>
    <div class="card">
      ${action}
      <div class="msg" id="msg" role="status"></div>
    </div>
  </div>
  ${j ? `<h2>Current job</h2>${jobCard(j, true)}` : ""}
  ${history.length ? `<h2>History</h2><div class="grid cols2">${history.map((x) => jobCard(x, false)).join("")}</div>` : ""}`;
}

function ledgerPage() {
  const rows = [...S.ledger].reverse();
  const KIND = {
    fund: "Funds added",
    report: "Pump reported broken",
    accept: "Mechanic accepted (price reserved)",
    fix_posted: "Fix posted, households asked",
    vote: "Household voted",
    pay_first: "First share paid to mechanic",
    pay_held: "Held share paid to mechanic",
    forfeit: "Held share returned to fund",
    rejected: "Village said not fixed",
    redraw: "More households asked",
    disputed: "Marked disputed",
    cancelled: "Cancelled, money returned",
  };
  return `<h1>Public ledger</h1>
  <p class="lead">Every entry is stored by the contract, so anyone can read the same list straight from the chain. Votes show a household number and a time, never a name.</p>
  <div class="card tablewrap"><table>
    <thead><tr><th>Time</th><th>What happened</th><th>Job</th><th>Pump</th><th>Amount (NEAR)</th><th>Who</th></tr></thead>
    <tbody>${
      rows
        .map(
          (e) => `<tr><td class="num">${esc(when(e.ts))}</td><td>${esc(KIND[e.kind] || e.kind)}</td><td class="num">${e.job === null || e.job === undefined ? "" : "#" + e.job}</td><td class="num">${e.pump === null || e.pump === undefined ? "pool" : e.pump}</td><td class="num">${BigInt(e.amount) ? near(e.amount) : ""}</td><td class="mono">${esc(e.who)}</td></tr>`,
        )
        .join("") || `<tr><td colspan="6" class="empty">Nothing yet. Fund a pump to start the ledger.</td></tr>`
    }</tbody></table></div>`;
}

// ---------------------------------------------------------------- NFT records (NEP-171 read interface of the pool)
const nftHtml = (t) =>
  `<dl class="nft"><dt>token_id</dt><dd class="mono">${esc(t.token_id)}</dd><dt>owner_id</dt><dd class="mono">${esc(t.owner_id)}</dd><dt>title</dt><dd>${esc(t.title)}</dd><dt>description</dt><dd>${esc(t.description)}</dd></dl>`;
const nftBox = (id) => `<div data-nft="${esc(id)}">${NFT.has(id) ? (NFT.get(id) ? nftHtml(NFT.get(id)) : "No such record.") : "Reading nft_token from the chain..."}</div>`;
async function fillNft() {
  for (const el of document.querySelectorAll("[data-nft]")) {
    const id = el.dataset.nft;
    if (NFT.has(id)) continue;
    try {
      NFT.set(id, await view("nft_token", { token_id: id }));
      if (el.isConnected) el.innerHTML = NFT.get(id) ? nftHtml(NFT.get(id)) : "No such record.";
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
  if (TRY.pump === null || !pumps.find((x) => x.id === TRY.pump)) TRY.pump = pumps[0].id;
  const pm = pumps.find((x) => x.id === TRY.pump);
  const st = pumpState(pm), j = st.job, p = S.cfg.params;
  const who = {
    villager: `<span class="role">Villager</span> signed by the relayer, which only passes on a household's one-time card code. The pool checks the code on-chain.`,
    mechanic: `<span class="role">Mechanic</span> signed by <span class="mono">bh-relay.testnet</span>, an account registered on the pool as a sandbox mechanic. Real mechanics use their own wallet on the water point's page.`,
  };
  let stage;
  if (!j) {
    stage = `<h3>Step 1. A villager reports the pump broken</h3>
      <p class="muted">${who.villager}</p>
      <div class="row fields"><label>Household<select id="try-hh">${hhOptions(TRY.hh)}</select></label></div>
      <button data-try="report">Report this pump broken</button>`;
  } else if (j.status === "Reported") {
    stage = `<h3>Step 2. A mechanic accepts the job</h3>
      <p class="muted">${who.mechanic} The price is reserved from the fund.</p>
      <div class="row fields"><label>Quote<select id="try-quote">${["0.1", "0.2", "0.3"].map((q) => `<option value="${q}"${q === TRY.quote ? " selected" : ""}>${q} NEAR</option>`).join("")}</select></label></div>
      <button data-try="accept">Accept the job as the sandbox mechanic</button>`;
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
    stage = `<h3>Step 5. Paid, with a share held</h3>
      <p>The mechanic was paid <b class="num">${near(j.paid)}</b> NEAR at once. <b class="num">${near(j.held)}</b> NEAR is held. ${due ? "The hold has passed." : `It can be released in <span class="num" data-countdown="${end}">${fmtDur(end - nowNs())}</span>.`} Broken-again reports so far: ${j.rebroken.length} of ${p.rebroken_needed}.</p>
      ${due ? `<button data-try="release">Release the held share to the mechanic</button>` : ""}
      <h3 style="margin-top:18px">Or: it breaks again during the hold</h3>
      <p class="muted">${who.villager} Two different households must report it. Then the held share goes back to the fund.</p>
      <div class="row fields"><label>Household<select id="try-hh">${hhOptions(TRY.hh)}</select></label></div>
      <button class="danger" data-try="report">Report broken again</button>`;
  } else {
    stage = `<h3>This job has ended: ${esc(j.status)}</h3><p class="muted">Pick another water point to start a fresh repair.</p>`;
  }
  const hh = TRY.hh;
  return `<h1>Try every role</h1>
  <p class="lead">Play a whole repair yourself, on NEAR testnet. Every button sends a real transaction to the pool contract and shows its link. No wallet is needed. The money is test money.</p>
  <div class="roles">
    <div><span class="role">Villager</span><p>Reports and votes with a one-time code from a printed card. The relayer pays the gas.</p></div>
    <div><span class="role">Mechanic</span><p>Accepts a job and posts the fix. Here a sandbox account signs; on the water point's page you use your own wallet.</p></div>
    <div><span class="role">Donor</span><p>Gives from a NEAR wallet and signs the payment. <a href="#/pump/${pm.id}">Open this water point</a> to give.</p></div>
    <div><span class="role">Observer</span><p>Reads the public ledger and each pump's and household's NFT record. Nothing to sign.</p></div>
  </div>
  <div class="card">
    <div class="row between"><label>Water point<select id="try-pump">${pumps.map((x) => `<option value="${x.id}"${x.id === TRY.pump ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>${chipFor(st.key)}</div>
    <div style="margin-top:18px">${stage}</div>
    <div class="msg" id="msg-try" role="status"></div>
  </div>
  <div class="grid cols2">
    <div class="card"><div class="row between"><b>NFT record of this water point</b><span class="chip">NEP-171 read</span></div>${nftBox("pump-" + pm.id)}</div>
    <div class="card"><div class="row between"><b>NFT record of household hh-${hh}</b><span class="chip">non-transferable</span></div>${nftBox("hh-" + hh)}</div>
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
    const price = toYocto(document.getElementById("try-quote").value).toString();
    return tryRun("Sandbox mechanic accepts the job", () => sandbox("accept_job", { job: j.id, price }));
  }
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
    <li><b>The money is testnet NEAR.</b> Mobile-money cash-out for the mechanic and NEAR Intents top-ups are not built.</li>
    <li><b>The problem is real, the numbers are not ours.</b> The "about one in four handpumps out of order" line comes from a review of field data from sub-Saharan Africa and Asia-Pacific (<a href="https://waterpointdata.org/wp-content/uploads/2020/11/Functionality-of-handpump-water-supplies.pdf" target="_blank" rel="noopener">Foster and others, Functionality of handpump water supplies</a>). The review itself warns that "functional" is defined differently from source to source, so treat it as an order of magnitude.</li>
    <li><b>Prior art already works.</b> FundiFix pools monthly mobile-money payments and fixes pumps within days. This adds a donor-visible fund that nobody holds.</li>
    <li><b>Not tested with any village.</b> It needs a field pilot.</li>
  </ul>`;
}

// ---------------------------------------------------------------- interactions
function wire(r) {
  document.getElementById("runcheck")?.addEventListener("click", runCheck);
  fillNft();
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
  const donate = (pump) =>
    run(fmsg, "Giving", () => {
      const amt = Number(document.getElementById("don-amt").value);
      if (!(amt >= 0.1)) return { ok: false, error: "The smallest gift is 0.1 NEAR." };
      return W.callPool(CONFIG.poolId, "fund", { pump }, toYocto(amt).toString());
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
    run(msg, "Accepting the job", () => {
      const price = toYocto(document.getElementById("quote").value);
      return W.callPool(CONFIG.poolId, "accept_job", { job: j.id, price: price.toString() });
    }),
  );
  document.getElementById("act-fix")?.addEventListener("click", () => run(msg, "Posting the fix", () => W.callPool(CONFIG.poolId, "post_fix", { job: j.id })));
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
    const results = await runChecks({ rpcUrl: CONFIG.rpcUrl, poolId: CONFIG.poolId, wasmUrl: "/evidence/borehole_pool.wasm", stateUrl: "/evidence/state-init.json" });
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
}, 15000);
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
