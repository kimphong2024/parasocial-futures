// Futures Triangle — live physics view. Dots drift in fluid motion near the
// force they exert; vertices reach with mass; the pointer parts the field;
// hover a corner or chip to feel a cohort; click a dot for the signal itself.
// The API self-heals on read and the page polls while work is in flight.
import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";

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
let filter = null;             // { kind: "cluster"|"horizon", value } or null
const pointer = { x: -9999, y: -9999, on: false };
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
    const own = 0.6 + rand(s.id) * 0.32;
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
const frame = $("triFrame");

function fitCanvas() {
  const r = svg.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform((r.width / W) * dpr, 0, 0, (r.width / W) * dpr, 0, 0);
}
addEventListener("resize", fitCanvas, { passive: true });

function drawFrame() {
  frame.setAttribute("points", CORNERS.map((c) => `${verts[c][0].toFixed(1)},${verts[c][1].toFixed(1)}`).join(" "));
  for (const c of CORNERS) {
    const g = svg.querySelector(`.tri-corner[data-corner="${c}"]`);
    const [x, y] = verts[c];
    const above = c === "pull";
    g.querySelector(".tri-hit").setAttribute("cx", x);
    g.querySelector(".tri-hit").setAttribute("cy", y);
    const count = g.querySelector(".tri-count");
    const name = g.querySelector(".tri-name");
    count.setAttribute("x", x); name.setAttribute("x", x);
    count.setAttribute("y", above ? y - 20 : y + 46);
    name.setAttribute("y", above ? y + 24 : y + 70);
  }
}

function paintBody(t) {
  ctx.beginPath();
  ctx.moveTo(verts.pull[0], verts.pull[1]);
  ctx.lineTo(verts.push[0], verts.push[1]);
  ctx.lineTo(verts.weight[0], verts.weight[1]);
  ctx.closePath();
  ctx.fillStyle = "#FFFEF9";
  ctx.fill();
  const total = Math.max(1, data ? data.counts.pull + data.counts.push + data.counts.weight : 1);
  // colour pooling toward each vertex, radius with mass — clipped to the body
  ctx.save();
  ctx.clip();
  for (const c of CORNERS) {
    const share = (data ? data.counts[c] : 0) / total;
    const R = 120 + share * 420;
    const g = ctx.createRadialGradient(verts[c][0], verts[c][1], 0, verts[c][0], verts[c][1], R);
    g.addColorStop(0, `rgba(${COLORS[c]},0.16)`);
    g.addColorStop(1, `rgba(${COLORS[c]},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
  // centre of gravity: signal-weighted barycentre
  if (data) {
    const gx = CORNERS.reduce((s, c) => s + verts[c][0] * data.counts[c], 0) / total;
    const gy = CORNERS.reduce((s, c) => s + verts[c][1] * data.counts[c], 0) / total;
    ctx.strokeStyle = "rgba(19,19,9,0.10)";
    ctx.lineWidth = 1;
    for (const c of CORNERS) {
      ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(verts[c][0], verts[c][1]); ctx.stroke();
    }
    const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.2);
    ctx.beginPath(); ctx.arc(gx, gy, 7 + pulse * 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(225,184,59,0.9)"; ctx.fill();
    ctx.beginPath(); ctx.arc(gx, gy, 11 + pulse * 4, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(225,184,59,${0.5 - pulse * 0.3})`; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "rgba(107,104,82,0.9)";
    ctx.font = "10px 'Fragment Mono', monospace";
    ctx.textAlign = "center";
    ctx.fillText("CENTRE OF GRAVITY", gx, gy + 28);
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
  paintBody(t);
  for (const d of dots) {
    if (d.born && now < d.born) continue;              // staggered arrival
    const [hx, hy] = home(d);
    const tx = hx + Math.cos(t * d.f1 + d.p1) * d.amp + Math.sin(t * d.f2 + d.p2) * d.amp * 0.6;
    const ty = hy + Math.sin(t * d.f1 * 0.9 + d.p2) * d.amp + Math.cos(t * d.f2 + d.p1) * d.amp * 0.6;
    d.vx = (d.vx + (tx - d.x) * 0.02) * 0.9;
    d.vy = (d.vy + (ty - d.y) * 0.02) * 0.9;
    if (pointer.on) {                                   // the pointer parts the field
      const dx = d.x - pointer.x, dy = d.y - pointer.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < POINTER_R2 && d2 > 0.01) {
        const dist = Math.sqrt(d2);
        const f = (1 - dist / POINTER_R) * POINTER_S;
        d.vx += (dx / dist) * f;
        d.vy += (dy / dist) * f;
      }
    }
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
  paintBody(0);
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
  pointer.x = mx; pointer.y = my; pointer.on = !reduced;
  if (!dots.length) return;
  const best = nearest(mx, my, 196);
  if (!best) { tip.classList.remove("on"); return; }
  tip.innerHTML = `<i style="background:rgb(${best.color})"></i><div><b>${esc(best.sig.title)}</b><span>${esc(best.sig.cluster)} · ${esc(NAMES[best.sig.triangle])} · click to read</span></div>`;
  tip.classList.add("on");
  tip.hidden = false;
  tipPos.tx = Math.min(e.clientX - r.left + 16, r.width - 330);
  tipPos.ty = e.clientY - r.top + 16;
});
wrap.addEventListener("pointerleave", () => { pointer.on = false; pointer.x = -9999; tip.classList.remove("on"); });

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
  const best = nearest(mx, my, 256);
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
    ${s.source || s.date ? `<p class="caption mt-2">${esc(s.source || "")}${s.date ? " · " + esc(fmtDate(s.date)) : ""}</p>` : ""}`;
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
  g.addEventListener("mouseenter", () => { highlight = corner; applyDimming(); if (reduced) staticDraw(); });
  g.addEventListener("mouseleave", () => { highlight = null; applyDimming(); if (reduced) staticDraw(); });
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
  $("wuPull").textContent = w.pull;
  $("wuPush").textContent = w.push;
  $("wuWeight").textContent = w.weight;
  $("wuTension").textContent = w.tension;
  for (const c of CORNERS) {
    const chip = document.querySelector(`.tri-card[data-corner="${c}"] .tri-card-n`);
    if (chip && data.counts[c]) chip.textContent = `${data.counts[c]} signals`;
  }
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
