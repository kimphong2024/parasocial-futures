// Signal radar — the library on one dial. Rings are horizons (near future
// at the centre), slices are drivers claiming signals via their evidence
// clusters; a final slice gathers what no driver claims. Dots drift gently
// in place — position encodes meaning here, so the field stays calm.
import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";

const $ = (id) => document.getElementById(id);
const W = 1000, C = 500;                       // viewBox + centre
const R_MAX = 415, R_MIN = 60;                 // dial radii
const HCOLOR = { H1: "78,90,43", H2: "211,150,62", H3: "91,138,154" };
const HLABel = { H1: "H1 · now–2029", H2: "H2 · 2030–2035", H3: "H3 · 2036–2040+" };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

let slices = [];        // { key, name, short, a0, a1, count }
let rings = [];         // { h, r0, r1, count }
let dots = [];
let highlight = null;   // slice key

const rand = (seed) => { let x = Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B); x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); return ((x ^= x >>> 16) >>> 0) / 4294967296; };
const shortName = (n) => n
  .replace("Parasocial AI Relationship Adoption", "Adoption")
  .replace("Governance Restrictiveness of Companion AI", "Governance")
  .replace("Prosocial / Anti-Dependency Design Maturity", "Prosocial design")
  .replace("Embodiment & Persistence Maturity", "Embodiment")
  .replace("Social Legitimacy of AI Intimacy", "Legitimacy")
  .replace("Human Relational Displacement / Deskilling", "Displacement")
  .replace("Accumulated Relational Harm Burden", "Harm burden")
  .replace("Market Concentration & Persona Control", "Market control");

// ---------- build geometry from data ----------
function build(data) {
  // signal -> driver slice via cluster_json (first claimant by sort order)
  const claim = new Map();     // cluster -> slice key
  const defs = data.drivers.map((d) => ({ key: d.key, name: d.name, short: shortName(d.name), clusters: JSON.parse(d.cluster_json || "[]") }));
  for (const d of defs) for (const c of d.clusters) if (!claim.has(c)) claim.set(c, d.key);

  const bySlice = new Map(defs.map((d) => [d.key, []]));
  const unclaimed = [];
  for (const s of data.signals) {
    const k = claim.get(s.cluster);
    if (k) bySlice.get(k).push(s);
    else unclaimed.push(s);
  }
  const unclaimedClusters = [...new Set(unclaimed.map((s) => s.cluster))];
  if (unclaimedClusters.length) console.info("[radar] clusters outside every driver:", unclaimedClusters.join(", "));

  const all = [...defs.map((d) => ({ key: d.key, name: d.name, short: d.short, signals: bySlice.get(d.key) })),
               { key: "_beyond", name: "Beyond the drivers", short: "Beyond the drivers", signals: unclaimed }];

  // slices: equal angles, starting at 12 o'clock
  const n = all.length;
  slices = all.map((d, i) => ({
    key: d.key, name: d.name, short: d.short, count: d.signals.length,
    a0: -Math.PI / 2 + (i / n) * Math.PI * 2,
    a1: -Math.PI / 2 + ((i + 1) / n) * Math.PI * 2,
  }));

  // rings: area proportional to horizon counts (min band width)
  const hc = { H1: 0, H2: 0, H3: 0 };
  for (const s of data.signals) if (hc[s.horizon] !== undefined) hc[s.horizon]++;
  const total = Math.max(1, hc.H1 + hc.H2 + hc.H3);
  const A0 = R_MIN * R_MIN, A1 = R_MAX * R_MAX;
  let acc = A0;
  rings = ["H1", "H2", "H3"].map((h) => {
    const r0 = Math.sqrt(acc);
    acc += (A1 - A0) * (hc[h] / total);
    let r1 = Math.sqrt(acc);
    if (r1 - r0 < 46) { r1 = r0 + 46; acc = r1 * r1; }   // minimum band
    return { h, r0, r1, count: hc[h] };
  });
  // normalise if the min-band pushes past R_MAX
  const over = rings[2].r1 / R_MAX;
  if (over > 1) for (const r of rings) { r.r0 /= over; r.r1 /= over; }

  const sliceOf = new Map(slices.map((s) => [s.key, s]));
  const ringOf = new Map(rings.map((r) => [r.h, r]));
  dots = data.signals.map((s) => {
    const sl = sliceOf.get(claim.get(s.cluster) || "_beyond");
    const rg = ringOf.get(s.horizon) || rings[0];
    const pad = 0.035;
    const a = sl.a0 + pad + (sl.a1 - sl.a0 - pad * 2) * rand(s.id);
    const rr = rg.r0 + 10 + (rg.r1 - rg.r0 - 20) * rand(s.id * 7 + 3);
    return {
      sig: s, slice: sl.key,
      baseA: a, baseR: rr,
      p1: rand(s.id * 3) * Math.PI * 2, f1: 0.18 + rand(s.id * 11) * 0.25,
      color: HCOLOR[s.horizon] || "107,104,82",
      ring: s.urgency === "critical",
      x: 0, y: 0, a: 1, ta: 1,
    };
  });
}

// ---------- SVG frame ----------
function drawFrame() {
  const svg = $("radarSvg");
  const axis = rings.map((r) => `
    <text class="radar-hlabel" x="${C + 8}" y="${(C - (r.r0 + r.r1) / 2).toFixed(1)}">${HLABel[r.h]} · ${r.count}</text>`).join("");
  const labels = slices.map((s) => {
    const mid = (s.a0 + s.a1) / 2;
    const lr = rings[2].r1 + 26;
    const x = C + Math.cos(mid) * lr, y = C + Math.sin(mid) * lr;
    const anchor = Math.abs(Math.cos(mid)) < 0.25 ? "middle" : (Math.cos(mid) > 0 ? "start" : "end");
    return `<g class="radar-slice-label" data-slice="${esc(s.key)}" role="button" tabindex="0" aria-label="${esc(s.name)} — highlight">
      <text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}">${esc(s.short.toUpperCase())} <tspan class="n">${s.count}</tspan></text>
    </g>`;
  }).join("");
  svg.innerHTML = `
    ${axis}${labels}
    <text class="radar-now" x="${C}" y="${C + 4}" text-anchor="middle">NOW</text>`;
  for (const g of svg.querySelectorAll(".radar-slice-label")) {
    const key = g.dataset.slice;
    g.addEventListener("mouseenter", () => { highlight = key; applyDim(); });
    g.addEventListener("mouseleave", () => { highlight = null; applyDim(); });
    g.addEventListener("click", () => { highlight = highlight === key ? null : key; applyDim(); });
  }
}

function applyDim() {
  for (const d of dots) d.ta = highlight && d.slice !== highlight ? 0.12 : 1;
  for (const chip of document.querySelectorAll(".radar-chip")) chip.classList.toggle("dim", !!highlight && chip.dataset.slice !== highlight);
  if (reduced) drawDots(0, true);
}

// ---------- legend ----------
function drawLegend() {
  $("radarLegend").innerHTML = slices.map((s) => `
    <button class="radar-chip" data-slice="${esc(s.key)}">${esc(s.short)} <b>${s.count}</b></button>`).join("");
  for (const chip of document.querySelectorAll(".radar-chip")) {
    const key = chip.dataset.slice;
    chip.addEventListener("mouseenter", () => { highlight = key; applyDim(); });
    chip.addEventListener("mouseleave", () => { highlight = null; applyDim(); });
  }
}

// ---------- canvas dots ----------
const canvas = $("radarCanvas");
const ctx = canvas.getContext("2d");
const svg = $("radarSvg");

function fitCanvas() {
  const r = svg.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform((r.width / W) * dpr, 0, 0, (r.width / W) * dpr, 0, 0);
}
addEventListener("resize", () => { fitCanvas(); if (reduced) drawDots(0, true); }, { passive: true });

function paintDial() {
  // face + hole
  ctx.beginPath(); ctx.arc(C, C, rings[2].r1, 0, Math.PI * 2);
  ctx.fillStyle = "#F2E9D4"; ctx.fill();
  ctx.beginPath(); ctx.arc(C, C, rings[0].r0, 0, Math.PI * 2);
  ctx.fillStyle = "#FFFEF9"; ctx.fill();
  // ring outlines
  ctx.strokeStyle = "#E2DBC2"; ctx.lineWidth = 1.5;
  for (const r of rings) { ctx.beginPath(); ctx.arc(C, C, r.r1, 0, Math.PI * 2); ctx.stroke(); }
  // slice dividers
  ctx.strokeStyle = "rgba(19,19,9,0.1)"; ctx.lineWidth = 1;
  for (const s of slices) {
    ctx.beginPath();
    ctx.moveTo(C + Math.cos(s.a0) * rings[0].r0, C + Math.sin(s.a0) * rings[0].r0);
    ctx.lineTo(C + Math.cos(s.a0) * rings[2].r1, C + Math.sin(s.a0) * rings[2].r1);
    ctx.stroke();
  }
  // the axis the horizon labels sit on
  ctx.save();
  ctx.setLineDash([2, 4]);
  ctx.strokeStyle = "rgba(19,19,9,0.25)";
  ctx.beginPath(); ctx.moveTo(C, C - rings[0].r0); ctx.lineTo(C, C - rings[2].r1); ctx.stroke();
  ctx.restore();
}

function drawDots(t, once = false) {
  ctx.clearRect(0, 0, W, W);
  paintDial();
  for (const d of dots) {
    const wob = once || reduced ? 0 : Math.sin(t * d.f1 + d.p1) * 3;
    const a = d.baseA + (once || reduced ? 0 : Math.cos(t * d.f1 * 0.7 + d.p1) * 0.004);
    const rr = d.baseR + wob;
    d.x = C + Math.cos(a) * rr;
    d.y = C + Math.sin(a) * rr;
    d.a += (d.ta - d.a) * 0.15;
    if (d.a < 0.02) continue;
    ctx.beginPath();
    ctx.arc(d.x, d.y, 4.6, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${d.color},${0.2 * d.a})`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(d.x, d.y, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${d.color},${0.9 * d.a})`;
    ctx.fill();
    if (d.ring) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 6.4, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(19,19,9,${0.45 * d.a})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

let t0 = performance.now();
function tick(now) {
  drawDots((now - t0) / 1000);
  requestAnimationFrame(tick);
}

// ---------- tooltip + click ----------
const tip = $("radarTip");
const wrap = $("radarWrap");
const tipPos = { x: 0, y: 0, tx: 0, ty: 0 };
const sliceName = (k) => slices.find((s) => s.key === k)?.short || "";

function toView(e) {
  const r = svg.getBoundingClientRect();
  const s = W / r.width;
  return [(e.clientX - r.left) * s, (e.clientY - r.top) * s, r];
}
function nearest(mx, my, maxD2) {
  let best = null, bd = maxD2;
  for (const d of dots) {
    if (d.a < 0.2) continue;
    const dx = d.x - mx, dy = d.y - my;
    const dist = dx * dx + dy * dy;
    if (dist < bd) { bd = dist; best = d; }
  }
  return best;
}
wrap.addEventListener("pointermove", (e) => {
  if (!dots.length) return;
  const [mx, my, r] = toView(e);
  const best = nearest(mx, my, 420);
  wrap.style.cursor = best ? "pointer" : "default";
  if (!best) { tip.classList.remove("on"); return; }
  tip.innerHTML = `<i style="background:rgb(${best.color})"></i><div><b>${esc(best.sig.title)}</b><span>${esc(best.sig.cluster)} · ${esc(sliceName(best.slice))} · ${esc(best.sig.horizon || "")} · click to read</span></div>`;
  tip.classList.add("on");
  tip.hidden = false;
  tipPos.tx = Math.min(e.clientX - r.left + 16, r.width - 330);
  tipPos.ty = e.clientY - r.top + 16;
});
wrap.addEventListener("pointerleave", () => tip.classList.remove("on"));
(function glide() {
  tipPos.x += (tipPos.tx - tipPos.x) * 0.3;
  tipPos.y += (tipPos.ty - tipPos.y) * 0.3;
  tip.style.left = tipPos.x + "px";
  tip.style.top = tipPos.y + "px";
  requestAnimationFrame(glide);
})();

wrap.addEventListener("click", (e) => {
  if (e.target.closest(".radar-slice-label")) return;
  const [mx, my] = toView(e);
  const best = nearest(mx, my, 700);
  if (best) openSignal(best.sig.id);
});

function closeDrawer() { document.body.classList.remove("drawer-open"); }
$("backdrop").addEventListener("click", closeDrawer);

async function openSignal(id) {
  let s = {};
  try { s = await api(`/api/signals/${id}`); } catch { return; }
  $("drawer").innerHTML = `
    <button class="drawer-close" id="drawerClose" aria-label="Close">&times;</button>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <span class="tag tag-olive">${esc(s.cluster || "")}</span>
      ${s.horizon ? `<span class="tag tag-dim">${esc(s.horizon)}</span>` : ""}
    </div>
    <h3 class="mt-2" style="font-size:21px">${esc(s.title)}</h3>
    ${s.summary ? `<p class="mt-2">${esc(s.summary)}</p>` : ""}
    ${s.horizon_reasoning ? `<h4 class="mt-4">Horizon reasoning</h4><p class="caption" style="line-height:1.7">${esc(s.horizon_reasoning)}</p>` : ""}
    ${s.url ? `<p class="mt-4"><a href="${esc(s.url)}" target="_blank" rel="noopener">Read the source →</a></p>` : ""}
    ${s.source || s.date ? `<p class="caption mt-2">${esc(s.source || "")}${s.date ? " · " + esc(fmtDate(s.date)) : ""}</p>` : ""}
    ${noteCard(s)}`;
  wireNoteCard($("drawer"));
  document.body.classList.add("drawer-open");
  $("drawerClose").onclick = closeDrawer;
}

// ---------- boot ----------
async function boot() {
  const data = await api("/api/signals/radar");
  build(data);
  drawFrame();
  drawLegend();
  fitCanvas();
  if (reduced) drawDots(0, true);
  else requestAnimationFrame(tick);
}

renderNav("/radar");
boot();
