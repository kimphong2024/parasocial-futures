// /present — deck engine: 16:9 stage scaling, slide navigation
// (keys, chevrons, dots, swipe, hash deep-links), live-data hydration.
import { api, esc } from "./api.js";

const stage = document.getElementById("stage");
const slides = [...stage.querySelectorAll(".slide")];
const dots = document.getElementById("dots");
const counter = document.getElementById("counter");
const N = slides.length;
let i = 0;

// ---------- 16:9 scaling ----------
function fit() {
  const s = Math.min(innerWidth / 1280, innerHeight / 720);
  stage.style.setProperty("--deck-scale", s.toFixed(4));
}
addEventListener("resize", fit, { passive: true });
fit();

// ---------- navigation ----------
dots.innerHTML = slides.map((_, k) => `<button role="tab" aria-label="Slide ${k + 1}" data-k="${k}"></button>`).join("");
const dotEls = [...dots.children];

function go(k, pushHash = true) {
  i = Math.max(0, Math.min(N - 1, k));
  slides.forEach((s, k2) => {
    const on = k2 === i;
    if (on && !s.classList.contains("now")) {
      // restart the entry animation
      s.classList.remove("now");
      void s.offsetWidth;
    }
    s.classList.toggle("now", on);
  });
  dotEls.forEach((d, k2) => d.classList.toggle("on", k2 === i));
  counter.textContent = `${String(i + 1).padStart(2, "0")} / ${String(N).padStart(2, "0")}`;
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

// swipe
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

// ---------- live hydration (baked fallbacks stay if anything fails) ----------
async function hydrate() {
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.textContent = Number(v).toLocaleString(); };
  try {
    const o = await api("/api/signals/overview");
    set("stat-signals", o.total);
    set("stat-clusters", o.clusters?.length);
    set("stat-sources", o.sources?.distinct);
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
      const sum = (sc.summary || "").split(/(?<=\.)\s+/).slice(0, 2).join(" ");
      slide.querySelector(".scen-summary").textContent = sum;
      const myth = (sc.myth || "").split(/(?<=\.)\s+/)[0].replace(/^["“]|["”]$/g, "");
      slide.querySelector(".scen-myth").textContent = myth ? "“" + myth.replace(/\.$/, "") + ".”" : "";
    }
  } catch {}
}
hydrate();

// start at the deep-linked slide
const k0 = parseInt(location.hash.slice(1), 10);
go(k0 >= 1 && k0 <= N ? k0 - 1 : 0, false);
