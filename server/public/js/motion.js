// Motion bootstrap — Lenis smooth scroll + mask-wipe reveals + drag strips.
// Ported interaction language from the weareepoch reference, hand-rolled to
// match this app's no-build architecture. Content is fully visible without
// JS: the hidden reveal state only applies under html.mjs (set below).
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
document.documentElement.classList.add("mjs");

// ---------- Lenis smooth scroll ----------
if (!reduced && window.Lenis) {
  const lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 1 });
  const raf = (t) => { lenis.raf(t); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  // inner scrollables keep native wheel behaviour
  addEventListener("load", () => {
    for (const el of document.querySelectorAll("main *")) {
      const o = getComputedStyle(el).overflowY;
      if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight)
        el.setAttribute("data-lenis-prevent", "");
    }
  });
}

// ---------- mask-wipe reveals ----------
// Auto-tag the recurring structures so pages need no markup changes.
const REVEAL = [
  ".page-head",
  "main.container > .card",
  ".stats-row .stat-tile",
  ".review-card",
  "table.data tbody tr:nth-child(-n+12)",
];
const EXCLUDE = ".chamber, .chamber *, .specimen-stage, .specimen-stage *";

const io = reduced ? null : new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add("in");
    io.unobserve(e.target);
  }
}, { threshold: 0.12, rootMargin: "0px 0px -4% 0px" });

function tag(el) {
  if (el.classList.contains("mreveal") || el.matches(EXCLUDE)) return;
  el.classList.add("mreveal");
  if (!io) { el.classList.add("in"); return; }
  io.observe(el); // fires immediately for elements already in view
}

function sweep(root) {
  for (const sel of REVEAL)
    for (const el of root.querySelectorAll?.(sel) || []) tag(el);
}
sweep(document);

// App pages render most content async — tag new structures as they land.
new MutationObserver((muts) => {
  for (const m of muts)
    for (const n of m.addedNodes)
      if (n.nodeType === 1) { sweep(n); for (const sel of REVEAL) if (n.matches?.(sel)) tag(n); }
}).observe(document.body, { childList: true, subtree: true });

// ---------- drag-to-scroll strips ----------
document.addEventListener("pointerdown", (e) => {
  const strip = e.target.closest("[data-drag-scroll]");
  if (!strip || e.button !== 0) return;
  const startX = e.clientX, startLeft = strip.scrollLeft;
  let lastX = e.clientX, lastT = performance.now(), vel = 0, moved = false;
  const move = (ev) => {
    const dx = ev.clientX - startX;
    if (Math.abs(dx) > 4 && !moved) { moved = true; strip.classList.add("dragging"); }
    if (!moved) return;
    strip.scrollLeft = startLeft - dx;
    const t = performance.now();
    vel = (ev.clientX - lastX) / Math.max(1, t - lastT);
    lastX = ev.clientX; lastT = t;
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    strip.classList.remove("dragging");
    if (reduced || Math.abs(vel) < 0.1) return;
    let v = -vel * 16; // px per frame
    const glide = () => {
      strip.scrollLeft += v;
      v *= 0.94;
      if (Math.abs(v) > 0.4) requestAnimationFrame(glide);
    };
    requestAnimationFrame(glide);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
});
