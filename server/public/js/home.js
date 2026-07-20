// Home — editorial display register. Native scrolling (no smoothing, by
// request). This file only enhances: live clock, rise-in reveals, the head
// turning with scroll, gentle parallax on the interstitial, live stats.
document.documentElement.classList.add("js");

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// ---- live Singapore clock (scan-cadence timezone) ----
const clockEl = document.getElementById("clock");
function tickClock() {
  clockEl.textContent = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}
tickClock();
setInterval(tickClock, 20_000);

// ---- the head turns as the hero scrolls by: human face → porcelain face ----
const heroModel = document.getElementById("heroModel");
const hero = document.getElementById("hero");
let modelOn = false;
if (heroModel && !reduced) {
  heroModel.addEventListener("load", () => { modelOn = true; });
  heroModel.addEventListener("error", () => heroModel.remove());
} else {
  heroModel?.remove();
}

const parallaxEls = [...document.querySelectorAll("[data-parallax]")];
const topBar = document.querySelector(".fib-top");
let ticking = false;
function update() {
  ticking = false;
  topBar?.classList.toggle("scrolled", scrollY > innerHeight * 0.6);
  if (modelOn && hero) {
    const p = clamp01(scrollY / (hero.offsetHeight * 0.9));
    const theta = 90 + 95 * easeInOutCubic(p);
    heroModel.cameraOrbit = `${theta.toFixed(1)}deg 80deg 105%`;
  }
  const mid = innerHeight / 2;
  for (const el of parallaxEls) {
    const r = el.getBoundingClientRect();
    if (r.bottom < -80 || r.top > innerHeight + 80) continue;
    const offset = (r.top + r.height / 2 - mid) * -Number(el.dataset.parallax || 0.1);
    el.style.setProperty("--py", offset.toFixed(1) + "px");
  }
}
if (!reduced) {
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener("resize", update, { passive: true });
  update();
}

// ---- rise-in reveals ----
if (!reduced && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { threshold: 0.15 });
  document.querySelectorAll(".rise").forEach((el) => io.observe(el));
} else {
  document.querySelectorAll(".rise").forEach((el) => el.classList.add("in"));
}

// ---- live numbers + current scenario titles ----
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

fetch("/api/scenarios?status=published")
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => {
    if (!j) return;
    for (const el of document.querySelectorAll("[data-arch]")) {
      const sc = j.scenarios.find((s) => s.archetype === el.dataset.arch);
      if (sc) el.textContent = sc.title;
    }
  })
  .catch(() => {});
