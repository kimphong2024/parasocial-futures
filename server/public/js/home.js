// Home choreography — rAF scroll driving CSS custom properties.
// Act 1 has three phases across a 440vh track:
//   reveal (p 0–0.45): the specimen brightens out of darkness
//   hold   (p 0.45–0.68): annotations report; slight parallax drift
//   dive   (p 0.68–1): zoom through the lit gap, UI falls away, glow blooms
// Everything is visible without JS; this file only enhances.
document.documentElement.classList.add("js");

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
// Native scrolling on the landing page — smoothed wheel handling made the
// long pinned acts feel slow, so the home keeps the browser's 1:1 scroll.
const stage = document.querySelector(".specimen-stage");
const act = document.getElementById("specimen");
const nav = document.getElementById("homeNav");
const annos = [...document.querySelectorAll(".act-specimen .anno")];
const parallaxEls = [...document.querySelectorAll("[data-parallax]")];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOutExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const easeInCubic = (x) => x * x * x;
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// --- 3D Janus head: crossfades in over the still image once the GLB loads.
// The scroll then turns the head (moss face → porcelain face) and the dive
// pushes the camera into the glowing seam. Any failure leaves the image hero.
const heroModel = document.getElementById("heroModel");
let modelOn = false;
if (heroModel && !reduced) {
  heroModel.addEventListener("load", () => {
    modelOn = true;
    document.getElementById("specimenFigure")?.classList.add("model-on");
  });
  heroModel.addEventListener("error", () => heroModel.remove());
} else {
  heroModel?.remove();   // reduced motion / no element: the still image stays
}

// per-annotation drift rates (px across the hold + dive) — depth, not decoration
const DRIFT = [-34, 26, -20, 30];
const ANNO_STARTS = [0.30, 0.41, 0.52, 0.63];

let ticking = false;
function update() {
  ticking = false;

  if (stage) {
    const rect = act.getBoundingClientRect();
    const track = rect.height - innerHeight;
    const p = clamp01(-rect.top / track);

    // reveal
    const lit = easeOutExpo(clamp01(p / 0.45));
    stage.style.setProperty("--reveal", (0.06 + 0.94 * lit).toFixed(4));

    // dive: zoom into the gap; base settle 1.10 -> 1.0 during reveal
    const settle = 1.10 - 0.10 * clamp01(p / 0.45);
    const zoom = 1 + 1.9 * easeInCubic(clamp01((p - 0.68) / 0.32));
    stage.style.setProperty("--scale", (settle * zoom).toFixed(4));

    // UI lifecycle
    stage.style.setProperty("--headline-o", easeOutExpo(clamp01((p - 0.16) / 0.16)).toFixed(4));
    stage.style.setProperty("--ui", (1 - clamp01((p - 0.68) / 0.12)).toFixed(4));
    stage.style.setProperty("--p", p.toFixed(4));
    annos.forEach((el, i) => {
      el.style.setProperty("--o", easeOutExpo(clamp01((p - ANNO_STARTS[i]) / 0.10)).toFixed(4));
      el.style.setProperty("--dy", (DRIFT[i] * clamp01((p - 0.45) / 0.55)).toFixed(2));
    });

    // bloom at the end of the dive, then the specimen dissolves into the void
    stage.style.setProperty("--glow", (0.9 * easeInCubic(clamp01((p - 0.80) / 0.20)) * (1 - clamp01((p - 0.96) / 0.04))).toFixed(4));
    stage.style.setProperty("--exit", (1 - clamp01((p - 0.93) / 0.06)).toFixed(4));

    // 3D head: turn moss→porcelain across the reveal + hold, then dive into the seam
    if (modelOn) {
      const theta = 215 - 190 * easeInOutCubic(clamp01(p / 0.66));
      const radius = 105 - 63 * easeInCubic(clamp01((p - 0.7) / 0.3));
      heroModel.cameraOrbit = `${theta.toFixed(1)}deg 80deg ${radius.toFixed(1)}%`;
    }

    nav.classList.toggle("scrolled", scrollY > innerHeight * 0.5);
  }

  // generic parallax: elements shift against scroll, factor from data-parallax
  const mid = innerHeight / 2;
  for (const el of parallaxEls) {
    const r = el.getBoundingClientRect();
    if (r.bottom < -80 || r.top > innerHeight + 80) continue;
    const offset = (r.top + r.height / 2 - mid) * -Number(el.dataset.parallax || 0.1);
    (el.querySelector("img") || el).style.setProperty("--py", offset.toFixed(1) + "px");
  }
}
function onScroll() {
  if (!ticking) { ticking = true; requestAnimationFrame(update); }
}
if (!reduced) {
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll, { passive: true });
  update();
} else {
  nav?.classList.add("scrolled");
}

// --- Rise-in reveals for the later acts ---
if (!reduced && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { threshold: 0.15 });
  document.querySelectorAll(".rise").forEach((el) => io.observe(el));
} else {
  document.querySelectorAll(".rise").forEach((el) => el.classList.add("in"));
}

// --- Live numbers (public counts only; baked defaults if the fetch fails) ---
fetch("/api/public/stats")
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => {
    if (!s) return;
    for (const el of document.querySelectorAll("[data-stat]")) {
      const v = s[el.dataset.stat];
      if (v !== null && v !== undefined) el.textContent = v;
    }
  })
  .catch(() => {});
