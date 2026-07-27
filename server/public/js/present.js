// /present — deck engine: 16:9 stage scaling, navigation (keys, chevrons,
// dots, swipe, hash deep-links), live hydration, and per-slide interactions:
// count-ups, animated cluster bars, the live map embed, the artifact table.
import { api, esc } from "./api.js";

const $ = (id) => document.getElementById(id);
const stage = document.getElementById("stage");
const slides = [...stage.querySelectorAll(".slide")];
const dots = document.getElementById("dots");
const counter = document.getElementById("counter");
const N = slides.length;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
let i = 0;

// ---------- 16:9 scaling ----------
function fit() {
  const s = Math.min(innerWidth / 1280, innerHeight / 720);
  stage.style.setProperty("--deck-scale", s.toFixed(4));
}
addEventListener("resize", fit, { passive: true });
fit();

// ---------- count-up numerals ----------
function countUp(el) {
  const target = Number(el.dataset.n || el.textContent.replace(/\D/g, "")) || 0;
  if (reduced) { el.textContent = target.toLocaleString(); return; }
  const t0 = performance.now(), dur = 1100;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 4);
    el.textContent = Math.round(target * eased).toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------- navigation ----------
dots.innerHTML = slides.map((_, k) => `<button role="tab" aria-label="Slide ${k + 1}" data-k="${k}"></button>`).join("");
const dotEls = [...dots.children];

function enter(slide) {
  // per-slide entry behaviours
  slide.querySelectorAll(".lib-count, .hz-n").forEach(countUp);
  // the live map iframe loads only when its slide first shows
  const frame = slide.querySelector("#mapFrame");
  if (frame && !frame.src) frame.src = "/map";
}

function go(k, pushHash = true) {
  i = Math.max(0, Math.min(N - 1, k));
  slides.forEach((s, k2) => {
    const on = k2 === i;
    if (on && !s.classList.contains("now")) { s.classList.remove("now"); void s.offsetWidth; }
    s.classList.toggle("now", on);
  });
  dotEls.forEach((d, k2) => d.classList.toggle("on", k2 === i));
  counter.textContent = `${String(i + 1).padStart(2, "0")} / ${String(N).padStart(2, "0")}`;
  enter(slides[i]);
  if (pushHash) history.replaceState(null, "", "#" + (i + 1));
}

document.getElementById("prev").addEventListener("click", () => go(i - 1));
document.getElementById("next").addEventListener("click", () => go(i + 1));
dots.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) go(Number(b.dataset.k)); });

addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) { e.preventDefault(); go(i + 1); }
  else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) { e.preventDefault(); go(i - 1); }
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(N - 1);
  else if (e.key.toLowerCase() === "f") {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
});

let x0 = null;
addEventListener("pointerdown", (e) => { x0 = e.clientX; }, { passive: true });
addEventListener("pointerup", (e) => {
  if (x0 === null) return;
  const dx = e.clientX - x0; x0 = null;
  if (Math.abs(dx) > 60) go(i + (dx < 0 ? 1 : -1));
}, { passive: true });

addEventListener("hashchange", () => {
  const k = parseInt(location.hash.slice(1), 10);
  if (k >= 1 && k <= N) go(k - 1, false);
});

// ---------- slide 9: the pyramid ----------
const pyr = document.getElementById("claPyr");
const claNote = document.getElementById("claNote");
pyr?.addEventListener("click", (e) => {
  const tier = e.target.closest(".tier");
  if (!tier) return;
  pyr.querySelectorAll(".tier").forEach((t) => t.classList.toggle("now", t === tier));
  claNote.textContent = tier.dataset.note;
});

// the stage is a scaled canvas — convert the cursor into its 1280x720 space
function placeTip(tip, e) {
  const r = stage.getBoundingClientRect();
  const scale = r.width / 1280;
  let x = (e.clientX - r.left) / scale + 18;
  let y = (e.clientY - r.top) / scale + 18;
  x = Math.min(x, 1280 - tip.offsetWidth - 40);
  y = Math.min(y, 720 - tip.offsetHeight - 30);
  tip.style.left = Math.max(40, x) + "px";
  tip.style.top = Math.max(20, y) + "px";
}

// ---------- slide 4: the belief that updates ----------
// A wide prior narrows and shifts as evidence lands, then resets — the
// Bayesian loop drawn rather than described.
const bell = (mu, sigma, w = 420, h = 148) => {
  const pts = [];
  for (let i = 0; i <= 72; i++) {
    const x = i / 72;
    const y = Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
    pts.push(`L${(x * w).toFixed(1)},${(h - y * h * 0.84).toFixed(1)}`);
  }
  return `M0,${h} ${pts.join(" ")} L${w},${h} Z`;
};
const PRIOR = { mu: 0.42, sigma: 0.2 }, POST = { mu: 0.6, sigma: 0.095 };

function bayesLoop() {
  const prior = $("bayesPrior"), post = $("bayesPost");
  if (!prior || !post) return;
  prior.setAttribute("d", bell(PRIOR.mu, PRIOR.sigma));
  if (reduced) { post.setAttribute("d", bell(POST.mu, POST.sigma)); return; }
  const t0 = performance.now();
  const step = (now) => {
    const c = ((now - t0) / 1000) % 7;                   // 7s cycle
    // 0-2.4s: evidence moves the belief · hold · 5.6-7s: a new prior widens again
    const p = c < 2.4 ? c / 2.4 : c < 5.6 ? 1 : 1 - (c - 5.6) / 1.4;
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    post.setAttribute("d", bell(PRIOR.mu + (POST.mu - PRIOR.mu) * e, PRIOR.sigma + (POST.sigma - PRIOR.sigma) * e));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- slide 8: live drivers with hover descriptions ----------
const DRV_SHORT = {
  "Parasocial AI Relationship Adoption": "Adoption",
  "Governance Restrictiveness of Companion AI": "Governance",
  "Prosocial / Anti-Dependency Design Maturity": "Prosocial design",
  "Embodiment & Persistence Maturity": "Embodiment",
  "Social Legitimacy of AI Intimacy": "Social legitimacy",
  "Human Relational Displacement / Deskilling": "Displacement",
  "Accumulated Relational Harm Burden": "Harm burden",
  "Market Concentration & Persona Control": "Market control",
};
const FALLBACK_DRIVERS = ["Adoption", "Governance", "Prosocial design", "Embodiment", "Social legitimacy", "Displacement", "Harm burden", "Market control"]
  .map((n) => ({ name: n, description: "", unit: "" }));

function renderDrivers(list) {
  const grid = $("drvGrid");
  if (!grid) return;
  grid.innerHTML = list.map((d, i) => {
    const short = DRV_SHORT[d.name] || d.name;
    return `<span data-i="${i}">${esc(short)}</span>`;
  }).join("");
  const tip = $("drvTip");
  const place = (e) => placeTip(tip, e);
  grid.querySelectorAll("span").forEach((el) => {
    const d = list[Number(el.dataset.i)];
    if (!d?.description) return;
    el.addEventListener("mouseenter", (e) => {
      tip.innerHTML = `<b>${esc(DRV_SHORT[d.name] || d.name)}</b><p>${esc(d.description || "")}</p>${d.unit ? `<span class="unit">Measured as: ${esc(d.unit)}</span>` : ""}`;
      tip.hidden = false;
      place(e);
      requestAnimationFrame(() => tip.classList.add("on"));
    });
    el.addEventListener("mousemove", place);
    el.addEventListener("mouseleave", () => tip.classList.remove("on"));
  });
}

// ---------- learnings: click through the five lessons ----------
const LEARNINGS = [
  { t: "Breadth has a price", who: "machine", x: "Machines add breadth and rigour — hundreds of candidates a night, judged consistently. They also produce confident false positives, which is why every automated judgment ends at a gate." },
  { t: "Suggest, then refine", who: "both", x: "Machines can suggest; humans can refine. The best drafts on this platform were machine-first and human-finished — never the reverse, never machine-only." },
  { t: "Make it teach you", who: "machine", x: "Ask the machine to show you what it does — the prompts, the gate text, the written reasoning behind every horizon call. A tool you can interrogate is a tool you can trust." },
  { t: "No single tool", who: "both", x: "Each tool has its use: one searches wide, one reads deep, one judges, one embeds. The best tool turned out to be the combination — a pipeline, not a product." },
  { t: "Humans bring the what-if", who: "human", x: "Storytelling and imagination stayed human all term. The more colorful, provocative what-ifs — the throuple, the fire code, the third at the table — came from us." },
];
const learnPanel = document.getElementById("learnPanel");
const learnNums = document.getElementById("learnNums");
function showLearning(k) {
  const L = LEARNINGS[k];
  learnNums?.querySelectorAll(".ln").forEach((b) => b.classList.toggle("now", Number(b.dataset.k) === k));
  if (!learnPanel) return;
  learnPanel.innerHTML = `
    <span class="learn-who ${L.who}">${L.who === "both" ? "machine + human" : L.who}</span>
    <h2 class="learn-title">${esc(L.t)}</h2>
    <p class="learn-text">${esc(L.x)}</p>`;
}
learnNums?.addEventListener("click", (e) => {
  const b = e.target.closest(".ln");
  if (b) showLearning(Number(b.dataset.k));
});
showLearning(0);

// ---------- slide 14: the artifact table ----------
const artTable = document.getElementById("artTable");
const artCaption = document.getElementById("artCaption");
let artList = [
  { src: "/img/artifacts/growth-companion-continuity-receipt.jpg", cap: "Receipt · Tuned Tool" },
  { src: "/img/artifacts/collapse-befriend-something-alive.jpg", cap: "Embroidered patch · Reality Break" },
  { src: "/img/artifacts/growth-companion-disclosure-card.jpg", cap: "Identity card · Tuned Tool" },
];
let artIdx = 0;
const ROTS = [-7, 5, -2, 8, -5];
function dealArtifacts() {
  if (!artTable) return;
  // the top card plus two beneath, strewn like objects on a table
  const shown = [0, 1, 2].map((k) => artList[(artIdx + k) % artList.length]);
  artTable.innerHTML = shown.map((a, k) => `
    <img src="${esc(a.src)}" alt="${esc(a.cap)}" loading="lazy" data-k="${k}" style="
      z-index: ${3 - k};
      left: ${[70, 10, 150][k]}px; top: ${[60, 190, 230][k]}px;
      transform: rotate(${ROTS[(artIdx + k) % ROTS.length]}deg) scale(${k === 0 ? 1.12 : 0.94});
      opacity: ${k === 0 ? 1 : 0.75};">`).join("");
  artCaption.textContent = shown[0].cap;
  // hovering an object tells you what it is and what it reveals
  const tip = $("artTip");
  artTable.querySelectorAll("img").forEach((img) => {
    const a = shown[Number(img.dataset.k)];
    if (!a?.blurb) return;
    img.addEventListener("mouseenter", (e) => {
      tip.innerHTML = `<span class="kind">${esc(a.type)} · ${esc(a.scenario)}</span><b>${esc(a.title)}</b><p>${esc(a.blurb)}</p>`;
      tip.hidden = false;
      placeTip(tip, e);
      requestAnimationFrame(() => tip.classList.add("on"));
    });
    img.addEventListener("mousemove", (e) => placeTip(tip, e));
    img.addEventListener("mouseleave", () => tip.classList.remove("on"));
  });
}
document.getElementById("artNext")?.addEventListener("click", (e) => {
  e.stopPropagation();
  artIdx = (artIdx + 1) % artList.length;
  dealArtifacts();
});

// ---------- live hydration (baked fallbacks stay if anything fails) ----------
async function hydrate() {
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) { el.textContent = Number(v).toLocaleString(); el.dataset.n = v; } };
  try {
    const o = await api("/api/signals/overview");
    const lib = document.getElementById("libCount");
    if (lib && o.total) lib.dataset.n = o.total;
    set("stat-clusters", o.clusters?.length);
    set("stat-sources", o.sources?.distinct);
    // top clusters as animated bars
    const bars = document.getElementById("libBars");
    if (bars && o.clusters?.length) {
      const top = o.clusters.slice(0, 9);
      const max = top[0].n;
      bars.innerHTML = top.map((c) => `
        <div class="lib-bar">
          <span class="nm">${esc(c.v)}</span>
          <span class="tr"><span class="fl" style="width:${((c.n / max) * 100).toFixed(1)}%"></span></span>
          <span class="n">${c.n}</span>
        </div>`).join("");
    }
  } catch {}
  try {
    const f = await api("/api/signals/facets");
    const h = Object.fromEntries((f.horizon || []).map((r) => [r.v, r.n]));
    set("stat-h1", h.H1); set("stat-h2", h.H2); set("stat-h3", h.H3);
  } catch {}
  try {
    const j = await api("/api/scenarios?status=published");
    for (const sc of j.scenarios || []) {
      const slide = stage.querySelector(`.scen[data-arch="${CSS.escape(sc.archetype)}"]`);
      if (!slide) continue;
      slide.querySelector(".scen-title").textContent = sc.title;
      slide.querySelector(".scen-summary").textContent = (sc.summary || "").split(/(?<=\.)\s+/).slice(0, 2).join(" ");
      const myth = (sc.myth || "").split(/(?<=\.)\s+/)[0].replace(/^["“]|["”]$/g, "");
      slide.querySelector(".scen-myth").textContent = myth ? "“" + myth.replace(/\.$/, "") + ".”" : "";
    }
  } catch {}
  try {
    const j = await api("/api/drivers");
    renderDrivers((j.drivers || []).filter((d) => d.enabled !== 0).slice(0, 8));
  } catch { renderDrivers(FALLBACK_DRIVERS); }
  try {
    const j = await api("/api/artifacts");
    const all = (j.scenarios || []).flatMap((s) => s.artifacts.map((a) => ({
      src: `/img/artifacts/${s.archetype}-${a.slug}.jpg`,
      cap: `${a.type} · ${s.title}`,
      type: a.type, scenario: s.title, title: a.title, blurb: a.blurb,
    })));
    if (all.length) { artList = all; artIdx = 0; }
  } catch {}
  dealArtifacts();
  // re-run count-ups on the current slide with hydrated numbers
  enter(slides[i]);
}
hydrate();

bayesLoop();

const k0 = parseInt(location.hash.slice(1), 10);
go(k0 >= 1 && k0 <= N ? k0 - 1 : 0, false);
