import { buildLevels, credential, fromHex, ACTIONS } from "/merkle.js";

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
let lastChecks = null; // survives the periodic re-render

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
  const m = Math.floor(s / 60);
  s %= 60;
  return m ? `${m}m ${s}s` : `${s}s`;
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

function render() {
  const r = route();
  setTabs(r.name);
  document.getElementById("hero").hidden = r.name !== "home";
  const keep = { x: window.scrollX, y: window.scrollY };
  if (r.name === "pump") $main.innerHTML = pumpPage(r.id);
  else if (r.name === "ledger") $main.innerHTML = ledgerPage();
  else if (r.name === "about") $main.innerHTML = aboutPage();
  else $main.innerHTML = homePage();
  wire(r);
  for (const id of ["msg", "msg-fund"]) {
    const el = document.getElementById(id);
    if (el && lastMsg[id]) {
      el.className = `msg ${lastMsg[id].kind}`;
      el.innerHTML = lastMsg[id].text;
    }
  }
  window.scrollTo(keep.x, keep.y);
}

async function refresh() {
  try {
    await load();
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
  <h2 class="first">How it works</h2>
  <ol class="steps card">
    <li><b>Check before you give.</b> Press the check below: it recomputes the fund's address and shows that no one holds a key to it.</li>
    <li><b>Fund it.</b> Connect your own NEAR testnet wallet and give to a pump or to the shared pool.</li>
    <li><b>Report.</b> A household types its number and a code from its printed card to report the pump broken. A job opens.</li>
    <li><b>Fix and check.</b> A registered mechanic signs in with their own wallet, accepts and posts the fix. The reporter and ${p.sample_size} random households are asked; ${p.min_replies} replies are needed and two thirds must say it works.</li>
    <li><b>Pay and hold.</b> ${p.first_pct}% is paid at once. The rest is held for ${fmtDur(BigInt(p.hold_ns))} (short on this testnet build so it can be watched) and released unless two households report it broken again.</li>
  </ol>

  <h2>The fund</h2>
  <div class="grid cols3">
    <div class="card"><div class="label">Shared pool, free</div><div class="stat num">${near(free)} <small>NEAR</small></div></div>
    <div class="card"><div class="label">Earmarked for a pump</div><div class="stat num">${near(earmarked)} <small>NEAR</small></div></div>
    <div class="card"><div class="label">Reserved for open repairs</div><div class="stat num">${near(reserved)} <small>NEAR</small></div></div>
  </div>
  <p class="muted" style="margin-top:10px">Pool account <a class="mono" href="${explorer(CONFIG.poolId)}" target="_blank" rel="noopener">${esc(CONFIG.poolId)}</a>. It also holds a small storage reserve of NEAR that is not part of the fund (account balance ${near(S.balance, 2)} NEAR).</p>

  <h2 id="pumps">Water points</h2>
  <div class="grid cols3">
    ${S.pumps
      .map((pm) => {
        const st = pumpState(pm);
        return `<a class="card pump" href="#/pump/${pm.id}" aria-label="Open ${esc(pm.name)}">
          <div class="row between"><b>${esc(pm.name)}</b>${chipFor(st.key)}</div>
          <div class="muted">Earmarked <span class="num">${near(pm.earmark)}</span> NEAR</div>
        </a>`;
      })
      .join("") || `<div class="card empty">No water points registered yet.</div>`}
  </div>

  <section class="band" style="--img:url(/img/children-well.jpg)" aria-label="Photograph of children at a hand pump">
    <div class="wrap"><blockquote>A well is only the start. Keeping it running is the hard part.<footer>That is what this fund pays for, in the open.</footer></blockquote></div>
  </section>
  <h2 id="check">Check before you give</h2>
  <div class="card">
    <p>Nothing here asks you to trust this website. The check reads the chain and recomputes the address itself.</p>
    <button id="runcheck">Run the checks</button>
    <ul class="checks" id="checks" aria-live="polite">${checksHtml()}</ul>
  </div>`;
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
  <p class="muted">Token <span class="mono">pump-${pm.id}</span> (a non-transferable record). Earmarked: <b class="num">${near(pm.earmark)}</b> NEAR. Shared pool free: <b class="num">${near(S.cfg.free)}</b> NEAR.</p>

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
    <li><b>Prior art already works.</b> FundiFix pools monthly mobile-money payments and fixes pumps within days. This adds a donor-visible fund that nobody holds.</li>
    <li><b>Not tested with any village.</b> It needs a field pilot.</li>
  </ul>`;
}

// ---------------------------------------------------------------- interactions
function wire(r) {
  document.getElementById("runcheck")?.addEventListener("click", runCheck);
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
