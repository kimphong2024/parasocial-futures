// Signal map — the library as one relational field in three dimensions.
// Nodes are approved signals, edges are embedding nearest-neighbour pairs;
// d3-force-3d settles them as a physical particle system. A perspective
// camera orbits the field (drag to orbit, wheel to zoom), the field keeps
// a slow idle rotation, and every particle breathes with a small drift.
// Canvas-rendered, painter-sorted by depth. Modes: whole / bridges / kinship.
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// horizon trio from the validated dark palette; identity also carried by
// legend labels and tooltips, never color alone
const HCOLOR = { H1: [126, 148, 64], H2: [192, 132, 48], H3: [61, 158, 212] };
const HLABEL = { H1: "H1 · now–2029", H2: "H2 · 2030–2035", H3: "H3 · 2036–2040+" };

const canvas = $("mapCanvas");
const ctx = canvas.getContext("2d");
const tip = $("tip");
const panel = $("panel");

let nodes = [], edges = [], byId = new Map();
let mode = "all", highlightCluster = "", query = "";
let hoverNode = null, selected = null;
const degree = new Map();

// ---- camera ----
const cam = { yaw: 0.4, pitch: 0.25, zoom: 1, fov: 900 };
let dragging = false, settled = false;

function fit() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width * devicePixelRatio;
  canvas.height = r.height * devicePixelRatio;
}

const edgeVisible = (e) =>
  mode === "all" ? true
  : mode === "bridge" ? e.source.c !== e.target.c
  : e.source.c === e.target.c;

const nodeLit = (n) => {
  if (query) return n.t.toLowerCase().includes(query) || n.c.toLowerCase().includes(query);
  if (highlightCluster) return n.c === highlightCluster;
  return true;
};

// Rotate world position by camera yaw/pitch, add breathing drift, project.
function project(n, t, cw, ch) {
  // per-particle drift: tiny circular float so the field never dies
  const dx = reduced ? 0 : Math.sin(t * 0.00037 + n.phase) * 2.2;
  const dy = reduced ? 0 : Math.cos(t * 0.00031 + n.phase * 1.7) * 2.2;
  const x = n.x + dx, y = n.y + dy, z = n.z || 0;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  let rx = x * cy + z * sy;
  let rz = -x * sy + z * cy;
  let ry = y * cp - rz * sp;
  rz = y * sp + rz * cp;
  const s = cam.fov / (cam.fov + rz);
  n.sx = cw / 2 + rx * s * cam.zoom;
  n.sy = ch / 2 + ry * s * cam.zoom;
  n.ss = s;      // perspective scale (depth cue)
  n.sz = rz;     // camera-space depth for sorting
}

let lastDraw = 0;
function draw(t = 0) {
  const cw = canvas.width / devicePixelRatio, ch = canvas.height / devicePixelRatio;
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(devicePixelRatio, devicePixelRatio);

  for (const n of nodes) project(n, t, cw, ch);

  const anyFocus = !!(query || highlightCluster);
  // edges first, depth-faded
  for (const e of edges) {
    if (!edgeVisible(e)) continue;
    const lit = nodeLit(e.source) && nodeLit(e.target);
    const depth = Math.min(e.source.ss, e.target.ss);           // 0..1-ish
    const base = anyFocus ? (lit ? 0.34 : 0.03) : 0.1;
    ctx.strokeStyle = lit && anyFocus
      ? `rgba(225,184,59,${(base * depth).toFixed(3)})`
      : `rgba(185,191,173,${(base * depth).toFixed(3)})`;
    ctx.lineWidth = 0.6 * depth;
    ctx.beginPath();
    ctx.moveTo(e.source.sx, e.source.sy);
    ctx.lineTo(e.target.sx, e.target.sy);
    ctx.stroke();
  }

  // nodes back-to-front (painter's algorithm)
  const order = [...nodes].sort((a, b) => b.sz - a.sz);
  for (const n of order) {
    const lit = nodeLit(n);
    const [r, g, b] = HCOLOR[n.h] || HCOLOR.H1;
    const size = (2 + Math.min(4, (degree.get(n.id) || 1) * 0.5)) * n.ss * Math.sqrt(cam.zoom);
    const alpha = lit ? 0.35 + 0.65 * Math.max(0, Math.min(1, n.ss)) : 0.12;
    // soft particle glow for near nodes
    if (lit && n.ss > 0.9) {
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, size * 2.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.1 * (n.ss - 0.9) * 10).toFixed(3)})`;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, Math.max(0.6, size), 0, Math.PI * 2);
    ctx.fillStyle = lit ? `rgba(${r},${g},${b},${alpha.toFixed(3)})` : "rgba(120,128,107,0.18)";
    ctx.fill();
    if (n === hoverNode || n === selected) {
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "#F5F6F0";
      ctx.stroke();
    }
  }
  ctx.restore();
  lastDraw = t;
}

function nodeAt(px, py) {
  let best = null, bd = 144;
  for (const n of nodes) {
    const d2 = (n.sx - px) ** 2 + (n.sy - py) ** 2;
    if (d2 < bd) { bd = d2; best = n; }
  }
  return best;
}

async function openPanel(n) {
  selected = n;
  const s = await api("/api/signals/" + n.id);
  panel.innerHTML = `
    <button class="close" aria-label="Close">&times;</button>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
      <span class="tag tag-olive">${esc(s.cluster)}</span>
      <span class="tag tag-dim" title="${esc(HLABEL[s.horizon] || "")}">${esc(s.horizon || "")}</span>
    </div>
    <h4>${esc(s.title)}</h4>
    <p class="caption" style="line-height:1.6">${esc(s.summary)}</p>
    ${s.horizon_reasoning ? `<p class="caption mt-2" style="color:var(--textDim)">${esc(s.horizon_reasoning)}</p>` : ""}
    <p class="mt-2"><a href="${esc(s.url)}" target="_blank" rel="noopener" class="caption">${esc(s.source || "source")} ↗</a></p>
    ${s.similar?.length ? `<p class="caption mt-4"><strong>Nearest in the field</strong></p>` +
      s.similar.map((x) => `<p class="caption" style="margin-top:6px"><a data-jump="${x.id}" style="cursor:pointer">${esc(x.title)}</a> <span style="color:var(--textDim)">cos ${x.score}</span></p>`).join("") : ""}`;
  panel.style.display = "block";
}
panel.addEventListener("click", (e) => {
  if (e.target.closest(".close")) { panel.style.display = "none"; selected = null; return; }
  const j = e.target.closest("[data-jump]");
  if (j) {
    const n = byId.get(+j.dataset.jump);
    if (n) openPanel(n);
  }
});

async function boot() {
  const [g, facets] = await Promise.all([api("/api/signals/graph"), api("/api/signals/facets?status=approved")]);
  nodes = g.nodes;
  for (const n of nodes) n.phase = (n.id * 2654435761 % 1000) / 159.2; // stable pseudo-random phase
  byId = new Map(nodes.map((n) => [n.id, n]));
  edges = g.edges
    .filter((e) => byId.has(e.a) && byId.has(e.b))
    .map((e) => ({ source: byId.get(e.a), target: byId.get(e.b), w: e.w }));
  for (const e of edges) {
    degree.set(e.source.id, (degree.get(e.source.id) || 0) + 1);
    degree.set(e.target.id, (degree.get(e.target.id) || 0) + 1);
  }
  $("mapStats").textContent = `${nodes.length} signals · ${edges.length} connections · 3D`;
  $("clusterSel").insertAdjacentHTML("beforeend",
    facets.cluster.map((c) => `<option value="${esc(c.v)}">${esc(c.v)} (${c.n})</option>`).join(""));
  const counts = { H1: 0, H2: 0, H3: 0 };
  for (const n of nodes) counts[n.h] = (counts[n.h] || 0) + 1;
  $("legend").innerHTML = Object.entries(HLABEL).map(([k, label]) => {
    const [r, gr, b] = HCOLOR[k];
    return `<span><span class="dot" style="background:rgb(${r},${gr},${b})"></span>${label} · ${counts[k] || 0}</span>`;
  }).join("");

  fit();

  // 3-dimensional physics: link springs + n-body repulsion in x/y/z
  const sim = d3.forceSimulation(nodes, 3)
    .force("link", d3.forceLink(edges).id((n) => n.id).distance((e) => 30 + (1 - e.w) * 70).strength((e) => 0.25 + e.w * 0.5))
    .force("charge", d3.forceManyBody().strength(-16).theta(0.9))
    .force("center", d3.forceCenter(0, 0, 0))
    .force("collide", d3.forceCollide(5));
  if (reduced) {
    sim.stop();
    for (let i = 0; i < 250; i++) sim.tick();
    settled = true;
    draw(0);
  } else {
    sim.on("end", () => { settled = true; });
    // continuous render loop: physics + idle orbit + particle drift
    const loop = (t) => {
      if (!dragging && settled) cam.yaw += 0.0009;   // slow idle orbit
      draw(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---- orbit + zoom controls ----
  let px = 0, py = 0;
  canvas.addEventListener("pointerdown", (ev) => {
    dragging = true; px = ev.clientX; py = ev.clientY;
    canvas.classList.add("dragging");
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener("pointerup", (ev) => {
    dragging = false;
    canvas.classList.remove("dragging");
    canvas.releasePointerCapture(ev.pointerId);
  });
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    cam.zoom = Math.max(0.35, Math.min(6, cam.zoom * Math.exp(-ev.deltaY * 0.0012)));
    if (reduced) draw(lastDraw);
  }, { passive: false });

  canvas.addEventListener("pointermove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    if (dragging) {
      cam.yaw += (ev.clientX - px) * 0.005;
      cam.pitch = Math.max(-1.35, Math.min(1.35, cam.pitch + (ev.clientY - py) * 0.005));
      px = ev.clientX; py = ev.clientY;
      if (reduced) draw(lastDraw);
      return;
    }
    const n = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n !== hoverNode) { hoverNode = n; if (reduced) draw(lastDraw); }
    if (n) {
      tip.style.display = "block";
      tip.style.left = (ev.clientX - rect.left + 14) + "px";
      tip.style.top = (ev.clientY - rect.top + 10) + "px";
      tip.innerHTML = `<strong>${esc(n.t)}</strong><br><span style="color:var(--textDim)">${esc(n.c)} · ${esc(HLABEL[n.h] || n.h)}</span>`;
    } else {
      tip.style.display = "none";
    }
  });
  canvas.addEventListener("pointerleave", () => { hoverNode = null; tip.style.display = "none"; });

  // click = select (suppressed after a real drag)
  let downAt = null;
  canvas.addEventListener("pointerdown", (ev) => { downAt = [ev.clientX, ev.clientY]; });
  canvas.addEventListener("click", (ev) => {
    if (downAt && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 6) return;
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n) openPanel(n);
  });

  $("mode").addEventListener("change", (e) => { mode = e.target.value; if (reduced) draw(lastDraw); });
  $("clusterSel").addEventListener("change", (e) => { highlightCluster = e.target.value; if (reduced) draw(lastDraw); });
  let deb;
  $("q").addEventListener("input", (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => { query = e.target.value.trim().toLowerCase(); if (reduced) draw(lastDraw); }, 200);
  });
  addEventListener("resize", () => { fit(); if (reduced) draw(lastDraw); }, { passive: true });
}

renderNav("/map");
boot();
