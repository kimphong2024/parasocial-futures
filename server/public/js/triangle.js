// Futures Triangle — live physics view. Every dot drifts in fluid motion
// near the force it exerts; each vertex's reach from the centre scales with
// the mass of evidence behind it, so the triangle itself deforms as the
// library's composition shifts. The API self-heals on read, and the page
// polls while classification or synthesis are in flight.
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const CORNERS = ["pull", "push", "weight"];
const COLORS = { pull: "225,184,59", push: "78,90,43", weight: "172,114,34" };
const NAMES = { pull: "Pull of the future", push: "Push of the present", weight: "Weight of history" };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// stage geometry (SVG viewBox space)
const W = 900, H = 660;
const CENTER = [450, 350];
const DIRS = { pull: [0, -1], push: [-Math.sin(Math.PI / 3), 0.5], weight: [Math.sin(Math.PI / 3), 0.5] };
const BASE_R = 280;

let data = null;
let dots = [];                          // physics particles
const verts = {};                       // current animated vertices
const targets = {};                     // mass-driven target vertices
for (const c of CORNERS) { verts[c] = [CENTER[0] + DIRS[c][0] * BASE_R, CENTER[1] + DIRS[c][1] * BASE_R]; targets[c] = [...verts[c]]; }

const rand = (seed) => { let x = Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B); x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); return ((x ^= x >>> 16) >>> 0) / 4294967296; };

// ---------- mass -> vertex targets ----------
function retarget() {
  const total = Math.max(1, data.counts.pull + data.counts.push + data.counts.weight);
  for (const c of CORNERS) {
    const share = data.counts[c] / total;               // equal thirds -> 1.0
    const scale = Math.min(1.3, Math.max(0.62, 0.66 + share * 1.02));
    const r = BASE_R * scale;
    targets[c] = [CENTER[0] + DIRS[c][0] * r, CENTER[1] + DIRS[c][1] * r];
  }
}

// ---------- particles ----------
function rebuildDots() {
  const all = [...data.corners.pull, ...data.corners.push, ...data.corners.weight];
  const known = new Map(dots.map((d) => [d.id, d]));
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
      r: s.urgency === "critical" ? 5.5 : 3.8,
      color: COLORS[s.triangle],
      // fluid drift: two incommensurate oscillators per axis + slow orbit
      p1: rand(s.id * 3) * Math.PI * 2, p2: rand(s.id * 5) * Math.PI * 2,
      f1: 0.25 + rand(s.id * 11) * 0.35, f2: 0.11 + rand(s.id * 13) * 0.2,
      amp: 7 + rand(s.id * 17) * 11,
      // spring state starts at home so new dots swim in from their corner
      x: prev?.x, y: prev?.y, vx: prev?.vx || 0, vy: prev?.vy || 0,
    };
  });
}

const home = (d) => [
  d.w.pull * verts.pull[0] + d.w.push * verts.push[0] + d.w.weight * verts.weight[0],
  d.w.pull * verts.pull[1] + d.w.push * verts.push[1] + d.w.weight * verts.weight[1],
];

// ---------- render loop ----------
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

let t0 = performance.now();
function tick(now) {
  const t = (now - t0) / 1000;
  // vertices ease toward their mass targets
  for (const c of CORNERS) {
    verts[c][0] += (targets[c][0] - verts[c][0]) * 0.06;
    verts[c][1] += (targets[c][1] - verts[c][1]) * 0.06;
  }
  drawFrame();
  ctx.clearRect(0, 0, W, H + 60);
  for (const d of dots) {
    const [hx, hy] = home(d);
    // fluid target: home plus layered drift
    const tx = hx + Math.cos(t * d.f1 + d.p1) * d.amp + Math.sin(t * d.f2 + d.p2) * d.amp * 0.6;
    const ty = hy + Math.sin(t * d.f1 * 0.9 + d.p2) * d.amp + Math.cos(t * d.f2 + d.p1) * d.amp * 0.6;
    if (d.x === undefined) { d.x = tx; d.y = ty; }
    // soft spring toward the drifting target — reads as water, not jitter
    d.vx = (d.vx + (tx - d.x) * 0.02) * 0.9;
    d.vy = (d.vy + (ty - d.y) * 0.02) * 0.9;
    d.x += d.vx; d.y += d.vy;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${d.color},0.85)`;
    ctx.fill();
  }
  if (!reduced) requestAnimationFrame(tick);
}

function staticDraw() {
  // reduced motion: one settled frame
  for (const c of CORNERS) verts[c] = [...targets[c]];
  drawFrame();
  ctx.clearRect(0, 0, W, H + 60);
  for (const d of dots) {
    const [hx, hy] = home(d);
    ctx.beginPath();
    ctx.arc(hx, hy, d.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${d.color},0.85)`;
    ctx.fill();
  }
}

// ---------- tooltip (nearest-dot hit test) ----------
const tip = $("triTip");
const wrap = $("triWrap");
wrap.addEventListener("mousemove", (e) => {
  if (!dots.length) return;
  const r = svg.getBoundingClientRect();
  const sx = W / r.width;
  const mx = (e.clientX - r.left) * sx, my = (e.clientY - r.top) * sx;
  let best = null, bd = 144; // 12px^2 in viewBox units
  for (const d of dots) {
    const dx = (d.x ?? 0) - mx, dy = (d.y ?? 0) - my;
    const dist = dx * dx + dy * dy;
    if (dist < bd) { bd = dist; best = d; }
  }
  if (!best) { tip.hidden = true; return; }
  tip.innerHTML = `<b>${esc(best.sig.title)}</b><span>${esc(best.sig.cluster)} · ${esc(NAMES[best.sig.triangle])}</span>`;
  tip.hidden = false;
  tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 320) + "px";
  tip.style.top = (e.clientY - r.top + 14) + "px";
});
wrap.addEventListener("mouseleave", () => { tip.hidden = true; });

// ---------- corner drawers ----------
function openCorner(corner) {
  const list = data.corners[corner];
  $("drawer").innerHTML = `
    <button class="drawer-close" id="drawerClose" aria-label="Close">&times;</button>
    <span class="tag tag-mustard" style="background:rgba(${COLORS[corner]},0.14);color:#131309;border:1px solid rgba(${COLORS[corner]},0.4)">${esc(NAMES[corner])}</span>
    <h3 class="mt-2" style="font-size:22px">${list.length} signals</h3>
    <div class="mt-4">
      ${list.map((s) => `
        <div class="tri-item">
          <b>${esc(s.title)}</b>
          <span class="caption">${esc(s.cluster)}${s.horizon ? " · " + esc(s.horizon) : ""}</span>
          <p>${esc(s.triangle_reasoning)}</p>
        </div>`).join("")}
    </div>`;
  document.body.classList.add("drawer-open");
  $("drawerClose").onclick = close;
  $("backdrop").onclick = close;
  function close() { document.body.classList.remove("drawer-open"); }
}
document.querySelectorAll(".tri-corner").forEach((g) => {
  const open = () => data && openCorner(g.dataset.corner);
  g.addEventListener("click", open);
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
});

// ---------- data + liveness ----------
function applyData() {
  retarget();
  rebuildDots();
  for (const c of CORNERS) {
    const el = svg.querySelector(`.tri-corner[data-corner="${c}"] .tri-count`);
    if (el) el.textContent = data.counts[c];
  }
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
