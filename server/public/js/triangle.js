// Futures Triangle — live physics view. Dots drift in fluid motion near the
// force they exert; vertices reach with mass; the pointer parts the field;
// hover a corner or chip to feel a cohort; click a dot for the signal itself.
// The API self-heals on read and the page polls while work is in flight.
import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";

const $ = (id) => document.getElementById(id);
const CORNERS = ["pull", "push", "weight"];
const COLORS = { pull: "225,184,59", push: "78,90,43", weight: "172,114,34" };
const NAMES = { pull: "Pull of the future", push: "Push of the present", weight: "Weight of history" };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// stage geometry (viewBox space)
const W = 900, H = 660;
const CENTER = [450, 350];
const DIRS = { pull: [0, -1], push: [-Math.sin(Math.PI / 3), 0.5], weight: [Math.sin(Math.PI / 3), 0.5] };
const BASE_R = 280;

let data = null;
let dots = [];
const verts = {}, targets = {};
for (const c of CORNERS) { verts[c] = [CENTER[0] + DIRS[c][0] * BASE_R, CENTER[1] + DIRS[c][1] * BASE_R]; targets[c] = [...verts[c]]; }

let highlight = null;          // corner key, from hover
let hoverId = null;            // the dot under the cursor — exempt from repulsion
let filter = null;             // { kind: "cluster"|"horizon", value } or null
const pointer = { x: -9999, y: -9999, on: false, sp: 0 };   // sp: smoothed speed — the force only acts while sweeping
const POINTER_R = 90, POINTER_R2 = POINTER_R * POINTER_R, POINTER_S = 5.5;

const rand = (seed) => { let x = Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B); x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); return ((x ^= x >>> 16) >>> 0) / 4294967296; };

// ---------- mass -> vertex targets ----------
function retarget() {
  const total = Math.max(1, data.counts.pull + data.counts.push + data.counts.weight);
  for (const c of CORNERS) {
    const share = data.counts[c] / total;
    const scale = Math.min(1.3, Math.max(0.62, 0.66 + share * 1.02));
    targets[c] = [CENTER[0] + DIRS[c][0] * BASE_R * scale, CENTER[1] + DIRS[c][1] * BASE_R * scale];
  }
}

// ---------- particles ----------
function rebuildDots() {
  const all = [...data.corners.pull, ...data.corners.push, ...data.corners.weight];
  const known = new Map(dots.map((d) => [d.id, d]));
  const bornBase = performance.now();
  dots = all.map((s) => {
    const prev = known.get(s.id);
    const own = 0.52 + rand(s.id) * 0.28;
    const rest = 1 - own;
    const split = rand(s.id * 7 + 1);
    const w = { pull: 0, push: 0, weight: 0 };
    w[s.triangle] = own;
    const others = CORNERS.filter((c) => c !== s.triangle);
    w[others[0]] = rest * split;
    w[others[1]] = rest * (1 - split);
    return {
      id: s.id, sig: s, w,
      r: s.urgency === "critical" ? 4.6 : 3.8,
      ring: s.urgency === "critical",
      color: COLORS[s.triangle],
      p1: rand(s.id * 3) * Math.PI * 2, p2: rand(s.id * 5) * Math.PI * 2,
      f1: 0.25 + rand(s.id * 11) * 0.35, f2: 0.11 + rand(s.id * 13) * 0.2,
      amp: 7 + rand(s.id * 17) * 11,
      born: prev ? 0 : bornBase + rand(s.id * 23) * 600,   // stagger new arrivals
      // new dots swim in from their own vertex
      x: prev ? prev.x : verts[s.triangle][0],
      y: prev ? prev.y : verts[s.triangle][1],
      vx: prev?.vx || 0, vy: prev?.vy || 0,
      a: prev?.a ?? 0, ta: 1,
    };
  });
  applyDimming();
}

const home = (d) => [
  d.w.pull * verts.pull[0] + d.w.push * verts.push[0] + d.w.weight * verts.weight[0],
  d.w.pull * verts.pull[1] + d.w.push * verts.push[1] + d.w.weight * verts.weight[1],
];

const matches = (d) => !filter
  || (filter.kind === "cluster" && d.sig.cluster === filter.value)
  || (filter.kind === "horizon" && d.sig.horizon === filter.value);

function applyDimming() {
  for (const d of dots) {
    let a = 1;
    if (filter && !matches(d)) a = 0.08;
    if (highlight && d.sig.triangle !== highlight) a = Math.min(a, 0.15);
    d.ta = a;
  }
  updateCounts();
}

function updateCounts() {
  for (const c of CORNERS) {
    const el = document.querySelector(`.tri-corner[data-corner="${c}"] .tri-count`);
    const chip = document.querySelector(`.tri-chip[data-corner="${c}"] b`);
    const total = data.counts[c];
    if (filter) {
      const m = dots.filter((d) => d.sig.triangle === c && matches(d)).length;
      if (el) el.textContent = `${m}/${total}`;
      if (chip) chip.textContent = `${m}/${total}`;
    } else {
      if (el) countUpText(el, total);
      if (chip) chip.textContent = total;
    }
  }
}

// count-up on the SVG numerals
function countUpText(el, target) {
  const from = parseInt(el.dataset.v, 10) || 0;
  el.dataset.v = target;
  if (reduced || from === target) { el.textContent = target; return; }
  const t0n = performance.now(), dur = 900;
  const step = (t) => {
    const p = Math.min(1, (t - t0n) / dur);
    el.textContent = Math.round(from + (target - from) * (1 - Math.pow(1 - p, 4)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- render ----------
const canvas = $("triCanvas");
const ctx = canvas.getContext("2d");
const svg = $("triSvg");

function fitCanvas() {
  const r = svg.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform((r.width / W) * dpr, 0, 0, (r.width / W) * dpr, 0, 0);
}
addEventListener("resize", fitCanvas, { passive: true });

function drawFrame() {
  for (const c of CORNERS) {
    const g = svg.querySelector(`.tri-corner[data-corner="${c}"]`);
    const [x, y] = verts[c];
    const above = c === "pull";
    // the hit circle covers the label block, not the dot cloud
    const hit = g.querySelector(".tri-hit");
    hit.setAttribute("cx", x);
    hit.setAttribute("cy", above ? y - 44 : y + 62);
    hit.setAttribute("r", 52);
    const count = g.querySelector(".tri-count");
    const name = g.querySelector(".tri-name");
    count.setAttribute("x", x); name.setAttribute("x", x);
    count.setAttribute("y", above ? y - 52 : y + 66);
    name.setAttribute("y", above ? y - 16 : y + 90);
  }
}

function paintBody() {
  // soft colour pools ground each cohort; no frame, no marker
  const total = Math.max(1, data ? data.counts.pull + data.counts.push + data.counts.weight : 1);
  for (const c of CORNERS) {
    const share = (data ? data.counts[c] : 0) / total;
    const R = 130 + share * 400;
    const g = ctx.createRadialGradient(verts[c][0], verts[c][1], 0, verts[c][0], verts[c][1], R);
    g.addColorStop(0, `rgba(${COLORS[c]},0.13)`);
    g.addColorStop(1, `rgba(${COLORS[c]},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawDot(d) {
  if (d.a < 0.01) return;
  ctx.beginPath();
  ctx.arc(d.x, d.y, d.r + 2.2, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${d.color},${0.22 * d.a})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${d.color},${0.9 * d.a})`;
  ctx.fill();
  if (d.ring) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r + 3.4, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(19,19,9,${0.45 * d.a})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

const t0 = performance.now();
function tick(now) {
  const t = (now - t0) / 1000;
  for (const c of CORNERS) {
    verts[c][0] += (targets[c][0] - verts[c][0]) * 0.06;
    verts[c][1] += (targets[c][1] - verts[c][1]) * 0.06;
  }
  drawFrame();
  ctx.clearRect(0, 0, W, H + 60);
  paintBody();
  pointer.sp *= 0.9;                                      // stopping kills the force fast
  const force = Math.min(1, pointer.sp / 5);
  for (const d of dots) {
    if (d.born && now < d.born) continue;              // staggered arrival
    const [hx, hy] = home(d);
    const tx = hx + Math.cos(t * d.f1 + d.p1) * d.amp + Math.sin(t * d.f2 + d.p2) * d.amp * 0.6;
    const ty = hy + Math.sin(t * d.f1 * 0.9 + d.p2) * d.amp + Math.cos(t * d.f2 + d.p1) * d.amp * 0.6;
    d.vx = (d.vx + (tx - d.x) * 0.02) * 0.9;
    d.vy = (d.vy + (ty - d.y) * 0.02) * 0.9;
    if (pointer.on && force > 0.02 && d.id !== hoverId) {   // parting only while the pointer sweeps
      const dx = d.x - pointer.x, dy = d.y - pointer.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < POINTER_R2 && d2 > 0.01) {
        const dist = Math.sqrt(d2);
        const f = (1 - dist / POINTER_R) * POINTER_S * force;
        d.vx += (dx / dist) * f;
        d.vy += (dy / dist) * f;
      }
    }
    if (d.id === hoverId) { d.vx *= 0.6; d.vy *= 0.6; } // the hovered dot holds still to be caught
    d.x += d.vx; d.y += d.vy;
    d.a += (d.ta - d.a) * 0.12;
    drawDot(d);
  }
  requestAnimationFrame(tick);
}

function staticDraw() {
  for (const c of CORNERS) verts[c] = [...targets[c]];
  drawFrame();
  ctx.clearRect(0, 0, W, H + 60);
  paintBody();
  for (const d of dots) {
    const [hx, hy] = home(d);
    d.x = hx; d.y = hy; d.a = d.ta;
    drawDot(d);
  }
}

// ---------- pointer: tooltip + dot click ----------
const tip = $("triTip");
const wrap = $("triWrap");
const tipPos = { x: 0, y: 0, tx: 0, ty: 0 };

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
  const [mx, my, r] = toView(e);
  const dxp = mx - pointer.x, dyp = my - pointer.y;
  if (pointer.x > -9000) pointer.sp = pointer.sp * 0.7 + Math.min(40, Math.hypot(dxp, dyp)) * 0.3;
  pointer.x = mx; pointer.y = my; pointer.on = !reduced;
  if (!dots.length) return;
  const best = nearest(mx, my, 400);
  hoverId = best ? best.id : null;
  wrap.style.cursor = best ? "pointer" : "default";
  if (!best) { tip.classList.remove("on"); return; }
  tip.innerHTML = `<i style="background:rgb(${best.color})"></i><div><b>${esc(best.sig.title)}</b><span>${esc(best.sig.cluster)} · ${esc(NAMES[best.sig.triangle])} · click to read</span></div>`;
  tip.classList.add("on");
  tip.hidden = false;
  tipPos.tx = Math.min(e.clientX - r.left + 16, r.width - 330);
  tipPos.ty = e.clientY - r.top + 16;
});
wrap.addEventListener("pointerleave", () => { pointer.on = false; pointer.x = -9999; hoverId = null; tip.classList.remove("on"); });

// tooltip glides
(function glide() {
  tipPos.x += (tipPos.tx - tipPos.x) * 0.3;
  tipPos.y += (tipPos.ty - tipPos.y) * 0.3;
  tip.style.left = tipPos.x + "px";
  tip.style.top = tipPos.y + "px";
  requestAnimationFrame(glide);
})();

wrap.addEventListener("click", (e) => {
  if (e.target.closest(".tri-corner")) return;         // corner clicks open cohorts
  const [mx, my] = toView(e);
  const best = nearest(mx, my, 676);      // ~26px reach — dots are catchable
  if (best) openSignal(best.sig.id, best.sig);
});

// ---------- drawers ----------
function closeDrawer() { document.body.classList.remove("drawer-open"); }
$("backdrop").addEventListener("click", closeDrawer);

async function openSignal(id, sig) {
  let s = sig;
  try { s = { ...sig, ...(await api(`/api/signals/${id}`)) }; } catch {}
  $("drawer").innerHTML = `
    <button class="drawer-close" id="drawerClose" aria-label="Close">&times;</button>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <span class="tag tag-olive">${esc(s.cluster || "")}</span>
      ${s.horizon ? `<span class="tag tag-dim">${esc(s.horizon)}</span>` : ""}
      <span class="tag tag-mustard" style="background:rgba(${COLORS[sig.triangle]},0.14);border:1px solid rgba(${COLORS[sig.triangle]},0.4);color:#131309">${esc(NAMES[sig.triangle])}</span>
    </div>
    <h3 class="mt-2" style="font-size:21px">${esc(s.title)}</h3>
    ${s.summary ? `<p class="mt-2">${esc(s.summary)}</p>` : ""}
    <h4 class="mt-4">Why this force</h4>
    <p class="caption" style="line-height:1.7">${esc(sig.triangle_reasoning || "")}</p>
    ${s.url ? `<p class="mt-4"><a href="${esc(s.url)}" target="_blank" rel="noopener">Read the source →</a></p>` : ""}
    ${s.source || s.date ? `<p class="caption mt-2">${esc(s.source || "")}${s.date ? " · " + esc(fmtDate(s.date)) : ""}</p>` : ""}
    ${noteCard(s)}`;
  wireNoteCard($("drawer"));
  document.body.classList.add("drawer-open");
  $("drawerClose").onclick = closeDrawer;
}

function openCorner(corner) {
  const list = data.corners[corner];
  $("drawer").innerHTML = `
    <button class="drawer-close" id="drawerClose" aria-label="Close">&times;</button>
    <span class="tag tag-mustard" style="background:rgba(${COLORS[corner]},0.14);color:#131309;border:1px solid rgba(${COLORS[corner]},0.4)">${esc(NAMES[corner])}</span>
    <h3 class="mt-2" style="font-size:22px">${list.length} signals</h3>
    <div class="mt-4">
      ${list.map((s) => `
        <div class="tri-item" data-id="${s.id}" role="button" tabindex="0">
          <b>${esc(s.title)}</b>
          <span class="caption">${esc(s.cluster)}${s.horizon ? " · " + esc(s.horizon) : ""}</span>
          <p>${esc(s.triangle_reasoning)}</p>
        </div>`).join("")}
    </div>`;
  document.body.classList.add("drawer-open");
  $("drawerClose").onclick = closeDrawer;
  $("drawer").querySelectorAll(".tri-item").forEach((el) => {
    el.addEventListener("click", () => {
      const s = list.find((x) => x.id === Number(el.dataset.id));
      if (s) openSignal(s.id, s);
    });
  });
}

// corner + legend chip interactions
for (const g of document.querySelectorAll(".tri-corner, .tri-chip")) {
  const corner = g.dataset.corner;
  g.addEventListener("click", (e) => { e.stopPropagation(); data && openCorner(corner); });
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); data && openCorner(corner); } });
  g.addEventListener("mouseenter", () => { highlight = corner; applyDimming(); showPanel(corner); if (reduced) staticDraw(); });
  g.addEventListener("mouseleave", () => { highlight = null; applyDimming(); hidePanel(); if (reduced) staticDraw(); });
}

// ---------- the write-up peek panel ----------
const panel = $("triPanel");
let panelTimer = null;
function showPanel(corner) {
  const w = data?.writeup;
  if (!w || !w[corner]) return;
  clearTimeout(panelTimer);
  panel.innerHTML = `
    <div class="tp-bar" style="background:rgb(${COLORS[corner]})"></div>
    <h4>${esc(NAMES[corner])} <span class="tp-n">${data.counts[corner]} signals</span></h4>
    <p>${esc(w[corner])}</p>`;
  panel.classList.add("on");
}
function hidePanel() {
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => panel.classList.remove("on"), 220);
}

// ---------- filters ----------
function buildFilters() {
  const bar = $("triFilters");
  const active = bar.querySelector(".pill.active");
  const keep = active ? { kind: active.dataset.kind, value: active.dataset.value } : null;
  const clusters = {};
  for (const c of CORNERS) for (const s of data.corners[c]) clusters[s.cluster] = (clusters[s.cluster] || 0) + 1;
  const top = Object.entries(clusters).sort((a, b) => b[1] - a[1]).slice(0, 6);
  bar.innerHTML =
    `<button class="pill" data-kind="" data-value="">All signals</button>` +
    ["H1", "H2", "H3"].map((h) => `<button class="pill" data-kind="horizon" data-value="${h}">${h}</button>`).join("") +
    top.map(([k]) => `<button class="pill" data-kind="cluster" data-value="${esc(k)}">${esc(k)}</button>`).join("");
  const match = keep && [...bar.querySelectorAll(".pill")].find((p) => p.dataset.kind === keep.kind && p.dataset.value === keep.value);
  (match || bar.querySelector(".pill")).classList.add("active");
  bar.onclick = (e) => {
    const b = e.target.closest(".pill");
    if (!b) return;
    bar.querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === b));
    filter = b.dataset.kind ? { kind: b.dataset.kind, value: b.dataset.value } : null;
    applyDimming();
    if (reduced) staticDraw();
  };
}

// ---------- data + liveness ----------
function applyData() {
  retarget();
  rebuildDots();
  buildFilters();
  const st = $("triStatus");
  if (data.classifying || data.unclassified > 0) {
    st.hidden = false;
    st.textContent = `Classifying new signals · ${data.total - data.unclassified} / ${data.total} judged`;
  } else st.hidden = true;
  if (reduced) staticDraw();
}

function drawWriteup() {
  const w = data.writeup;
  if (!w) {
    $("wuMeta").textContent = data.writing ? "synthesizing from the classified library…" : "awaiting first classification";
    return;
  }
  const sentences = (w.tension || "").split(/(?<=\.)\s+/);
  $("wuLede").textContent = sentences[0] || "";
  $("wuRest").textContent = sentences.slice(1).join(" ");
  // the scoreboard: numerals scaled by mass share
  const total = Math.max(1, data.counts.pull + data.counts.push + data.counts.weight);
  const order = [...CORNERS].sort((a, b) => data.counts[b] - data.counts[a]);
  $("ttForces").innerHTML = order.map((c) => {
    const share = data.counts[c] / total;
    const size = Math.round(44 + share * 130);
    return `<div class="tf-row"><i style="background:rgb(${COLORS[c]})"></i><b style="font-size:${size}px">${data.counts[c]}</b><span>${esc(NAMES[c])}</span></div>`;
  }).join("");
  $("ttRatio").textContent = `the balance of forces · ${order.map((c) => `${c} ${Math.round(data.counts[c] / total * 100)}%`).join(" · ")}`;
  const t = new Date(w.updated_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("wuMeta").textContent = `synthesized from ${w.signal_count} classified signals · ${t}`;
  $("wuState").textContent = data.writing ? "a fresh synthesis is generating — this text updates when it lands" : "";
}

$("resynth").addEventListener("click", async () => {
  $("wuState").textContent = "re-synthesizing…";
  try { await api("/api/triangle/writeup", { method: "POST" }); } catch {}
  poll(true);
});

let timer = null;
async function load() {
  data = await api("/api/triangle");
  applyData();
  drawWriteup();
  if (data.classifying || data.writing || data.unclassified > 0) {
    clearTimeout(timer);
    timer = setTimeout(load, 2500);
  }
}
function poll(force) { clearTimeout(timer); timer = setTimeout(load, force ? 800 : 2500); }

renderNav("/triangle");
fitCanvas();
if (!reduced) requestAnimationFrame(tick);
load();
