// "Watch a repair": an animated, labelled example of the repair rule, driven by the pool's real
// parameters (sample size, replies needed, two-thirds rule, payment split, hold). It is an illustration,
// not chain data, and says so on screen.

const STAGES = ["Reported", "Accepted", "Asked", "Verdict", "Money"];
const HH = [20, 3, 26, 15, 13, 12, 25, 1, 22];
const SCENES = [
  { id: "paid", label: "Fixed and paid" },
  { id: "bad", label: "Not really fixed" },
  { id: "again", label: "Broken again" },
  { id: "quiet", label: "Too few replies" },
];

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function fmtHold(ns) {
  const s = Math.round(Number(ns) / 1e9);
  if (s >= 86400) return `${Math.round(s / 86400)} day${s >= 172800 ? "s" : ""}`;
  if (s >= 3600) return `${Math.round(s / 3600)} hour${s >= 7200 ? "s" : ""}`;
  return `${Math.max(1, Math.round(s / 60))} min`;
}

function buildFrames(scene, p) {
  const n = Math.min(HH.length, p.sample_size + 1);
  const need = Math.min(p.min_replies, n);
  const hold = fmtHold(p.hold_ns);
  const first = p.first_pct, rest = 100 - first;
  const idle = () => Array(n).fill("idle");
  const base = (o) => ({ stage: 0, tiles: idle(), replies: 0, yes: 0, tone: "idle", big: "No replies yet", small: `${need} needed`, paid: "none", held: "none", note: "", ...o });
  const frames = [];
  frames.push(base({ stage: 0, note: "A household types its number and a code from its printed card to report the pump broken. A job opens; the relayer pays the fee." }));
  frames.push(base({ stage: 1, paid: "reserved", note: "A registered mechanic accepts and quotes a price. The fund reserves it. Nothing is paid yet." }));
  const asked = () => Array(n).fill("asked");
  frames.push(base({ stage: 2, tiles: asked(), paid: "reserved", note: `The mechanic says it is fixed. The reporter and ${p.sample_size} random households are asked: does the pump work?` }));

  const votes = { paid: [1, 1, 1, 1, 1], again: [1, 1, 1, 1, 1], bad: [0, 0, 1, 0, 1], quiet: [1, 1, 0] }[scene];
  let tiles = asked(), yes = 0, replies = 0;
  votes.forEach((v, i) => {
    tiles = tiles.slice(); tiles[i] = v ? "yes" : "no";
    replies++; yes += v;
    const left = need - replies;
    frames.push(base({
      stage: 2, tiles, replies, yes, paid: "reserved",
      tone: left > 0 ? "wait" : "idle",
      big: `${replies} repl${replies === 1 ? "y" : "ies"}`,
      small: left > 0 ? `${yes} say it works, ${replies - yes} say it does not. ${left} more needed.` : `${yes} say it works, ${replies - yes} say it does not.`,
      note: `hh-${HH[i]} says: ${v ? "it works" : "still broken"}.`,
    }));
  });
  const last = frames[frames.length - 1];

  if (scene === "quiet") {
    frames.push({ ...last, stage: 3, tone: "wait", big: `${replies} of ${need} replies`, small: "Not enough to decide.", note: `The vote window (${fmtHold(p.vote_window_ns)}) ends with too few replies. Nobody is paid. Anyone can press "ask more households": a new random group is drawn, up to twice.` });
    return frames;
  }
  const ok = yes * 3 >= replies * 2;
  if (!ok) {
    frames.push({ ...last, stage: 3, tone: "bad", big: "Not approved", small: `${yes} of ${replies} say it works. Two thirds are needed.`, note: `Nothing is paid. The job goes back to the mechanic. After ${p.max_attempts} failed checks it is marked disputed and the fund keeps the money.`, paid: "none" });
    return frames;
  }
  frames.push({ ...last, stage: 3, tone: "ok", big: "Approved", small: `${yes} of ${replies} say it works (two thirds needed).`, note: "Enough households replied and at least two thirds say it works." });
  frames.push({ ...last, stage: 4, tone: "ok", big: "Approved", small: `${first}% paid to the mechanic now`, paid: "paid", held: "held", note: `${first}% goes to the mechanic at once. The other ${rest}% is held for ${hold}.` });
  if (scene === "paid") {
    frames.push({ ...last, stage: 4, tone: "ok", big: "Completed", small: `${rest}% released to the mechanic`, paid: "paid", held: "released", note: `The hold ends with no new complaints. Anyone can press "Release" and the last ${rest}% is paid.` });
  } else {
    frames.push({ ...last, stage: 4, tone: "wait", big: "Hold running", small: `1 of ${p.rebroken_needed} broken-again reports`, paid: "paid", held: "held", note: `During the hold, hh-${HH[5]} reports the pump broken again.` });
    frames.push({ ...last, stage: 4, tone: "bad", big: "Held share forfeited", small: `${p.rebroken_needed} different households reported it`, paid: "paid", held: "returned", note: `A second, different household (hh-${HH[6]}) reports it. The held ${rest}% goes back to the fund for the next repair.` });
  }
  return frames;
}

const BAR_TXT = { none: "", reserved: "reserved", paid: "paid", held: "held", released: "released", returned: "returned to fund" };

let el = null; // one widget instance survives page re-renders so the animation is not reset

export function mountWatch(slot, p) {
  if (!el) el = create(p);
  slot.replaceChildren(el);
}

function create(p) {
  const root = document.createElement("section");
  root.className = "watch card";
  root.setAttribute("aria-labelledby", "watch-h");
  let scene = "paid", i = 0, playing = !reduced(), frames = buildFrames(scene, p), timer = null, visible = true;
  const n = Math.min(HH.length, p.sample_size + 1);

  root.innerHTML = `
    <div class="row between"><h2 id="watch-h" class="first">Watch a repair</h2><span class="chip">Example, not chain data</span></div>
    <p class="muted">Pick a case and watch the rule play out with this pool's real settings. The real jobs are on each water point's page.</p>
    <div class="scenes" role="group" aria-label="Choose an example">
      ${SCENES.map((s) => `<button type="button" class="scn" data-s="${s.id}" aria-pressed="${s.id === scene}">${s.label}</button>`).join("")}
    </div>
    <ol class="stages" aria-label="Stages">${STAGES.map((s, k) => `<li data-k="${k}"><span>${k + 1}</span>${s}</li>`).join("")}</ol>
    <div class="watch-grid">
      <div>
        <div class="label">Households asked</div>
        <div class="tiles" aria-hidden="true">${Array.from({ length: n }, (_, k) => `<div class="tile" data-t="${k}"><b>hh-${HH[k]}</b><i></i></div>`).join("")}</div>
        <p class="tally" data-tone="idle"><strong class="t-big"></strong><span class="t-small"></span></p>
      </div>
      <div>
        <div class="label">The quoted price</div>
        <div class="money" aria-hidden="true">
          <div class="mbar" data-m="paid" style="flex:${p.first_pct}"><b>${p.first_pct}% at once</b><span></span></div>
          <div class="mbar" data-m="held" style="flex:${100 - p.first_pct}"><b>${100 - p.first_pct}% held</b><span></span></div>
        </div>
        <p class="note" aria-live="polite"></p>
      </div>
    </div>
    <div class="row ctl">
      <button type="button" class="secondary" data-a="play"></button>
      <button type="button" class="secondary" data-a="step">Next step</button>
      <button type="button" class="secondary" data-a="restart">Restart</button>
      <span class="muted small t-count"></span>
    </div>`;

  const $ = (q) => root.querySelector(q);
  const draw = () => {
    const f = frames[i];
    root.querySelectorAll(".stages li").forEach((li) => {
      const k = Number(li.dataset.k);
      li.dataset.s = k < f.stage ? "done" : k === f.stage ? "now" : "todo";
    });
    root.querySelectorAll(".tile").forEach((t, k) => { t.dataset.s = f.tiles[k]; t.querySelector("i").textContent = { idle: "", asked: "asked", yes: "works", no: "broken" }[f.tiles[k]]; });
    const tally = $(".tally");
    tally.dataset.tone = f.tone;
    $(".t-big").textContent = f.big; $(".t-small").textContent = f.small;
    for (const m of ["paid", "held"]) {
      const bar = $(`.mbar[data-m="${m}"]`);
      const st = m === "paid" ? f.paid : f.held;
      bar.dataset.s = st;
      bar.querySelector("span").textContent = BAR_TXT[st];
    }
    $(".note").textContent = f.note;
    $(".t-count").textContent = `Step ${i + 1} of ${frames.length}`;
    $('[data-a="play"]').textContent = playing ? "Pause" : i >= frames.length - 1 ? "Play again" : "Play";
    $('[data-a="step"]').disabled = i >= frames.length - 1;
  };
  const stop = () => { clearInterval(timer); timer = null; };
  const start = () => {
    stop();
    if (!playing || !visible) return;
    timer = setInterval(() => {
      if (!root.isConnected) return;
      if (i < frames.length - 1) { i++; draw(); } else { playing = false; stop(); draw(); }
    }, 1500);
  };
  const pick = (id) => {
    scene = id; frames = buildFrames(scene, p); i = 0; playing = !reduced();
    root.querySelectorAll(".scn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.s === id)));
    draw(); start();
  };
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.s) return pick(b.dataset.s);
    if (b.dataset.a === "play") {
      if (i >= frames.length - 1) i = 0;
      playing = !playing; draw(); start();
    } else if (b.dataset.a === "step") {
      playing = false; stop(); if (i < frames.length - 1) i++; draw();
    } else if (b.dataset.a === "restart") pick(scene);
  });
  new IntersectionObserver((en) => { visible = en[0].isIntersecting; start(); }, { threshold: 0.25 }).observe(root);
  draw();
  if (reduced()) { i = frames.length - 1; draw(); }
  else start();
  return root;
}
