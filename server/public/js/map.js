// Signal map — the library as one relational field. Nodes are approved
// signals, edges are embedding nearest-neighbour pairs; a d3 force layout
// lets the cluster structure emerge from the connections. Canvas-rendered
// for ~1k nodes. Three view modes: whole / bridges (cross-cluster) /
// kinship (within-cluster).
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// horizon trio from the validated dark palette; identity also carried by
// legend labels and tooltips, never color alone
const HCOLOR = { H1: "#7E9440", H2: "#C08430", H3: "#3D9ED4" };
const HLABEL = { H1: "H1 · now–2029", H2: "H2 · 2030–2035", H3: "H3 · 2036–2040+" };

const canvas = $("mapCanvas");
const ctx = canvas.getContext("2d");
const tip = $("tip");
const panel = $("panel");

let nodes = [], edges = [], byId = new Map();
let mode = "all", highlightCluster = "", query = "";
let transform = d3.zoomIdentity;
let hoverNode = null, selected = null;
let degree = new Map();

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

function draw() {
  const w = canvas.width, h = canvas.height;
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const anyFocus = !!(query || highlightCluster);
  ctx.lineWidth = 0.5 / transform.k;
  for (const e of edges) {
    if (!edgeVisible(e)) continue;
    const lit = nodeLit(e.source) && nodeLit(e.target);
    ctx.strokeStyle = lit && anyFocus ? "rgba(225,184,59,0.35)" : `rgba(185,191,173,${anyFocus ? 0.04 : 0.10})`;
    ctx.beginPath();
    ctx.moveTo(e.source.x, e.source.y);
    ctx.lineTo(e.target.x, e.target.y);
    ctx.stroke();
  }

  for (const n of nodes) {
    const lit = nodeLit(n);
    const r = (2 + Math.min(4, (degree.get(n.id) || 1) * 0.5)) / Math.sqrt(transform.k);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = lit ? HCOLOR[n.h] || HCOLOR.H1 : "rgba(120,128,107,0.25)";
    ctx.fill();
    if (n === hoverNode || n === selected) {
      ctx.lineWidth = 2 / transform.k;
      ctx.strokeStyle = "#F5F6F0";
      ctx.stroke();
    }
  }
  ctx.restore();
}

function nodeAt(px, py) {
  const [x, y] = transform.invert([px, py]);
  let best = null, bd = 100;
  for (const n of nodes) {
    const d2 = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d2 < bd) { bd = d2; best = n; }
  }
  return bd < (10 / transform.k) ** 2 ? best : null;
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
  draw();
}
panel.addEventListener("click", (e) => {
  if (e.target.closest(".close")) { panel.style.display = "none"; selected = null; draw(); return; }
  const j = e.target.closest("[data-jump]");
  if (j) {
    const n = byId.get(+j.dataset.jump);
    if (n) { openPanel(n); centerOn(n); }
  }
});

function centerOn(n) {
  const r = canvas.parentElement.getBoundingClientRect();
  const k = Math.max(transform.k, 1.6);
  const t = d3.zoomIdentity.translate(r.width / 2 - n.x * k, r.height / 2 - n.y * k).scale(k);
  d3.select(canvas).transition().duration(reduced ? 0 : 500).call(zoom.transform, t);
}

const zoom = d3.zoom()
  .scaleExtent([0.25, 8])
  .on("zoom", (ev) => { transform = ev.transform; draw(); });

async function boot() {
  const [g, facets] = await Promise.all([api("/api/signals/graph"), api("/api/signals/facets?status=approved")]);
  nodes = g.nodes;
  byId = new Map(nodes.map((n) => [n.id, n]));
  edges = g.edges
    .filter((e) => byId.has(e.a) && byId.has(e.b))
    .map((e) => ({ source: byId.get(e.a), target: byId.get(e.b), w: e.w }));
  for (const e of edges) {
    degree.set(e.source.id, (degree.get(e.source.id) || 0) + 1);
    degree.set(e.target.id, (degree.get(e.target.id) || 0) + 1);
  }
  $("mapStats").textContent = `${nodes.length} signals · ${edges.length} connections`;
  $("clusterSel").insertAdjacentHTML("beforeend",
    facets.cluster.map((c) => `<option value="${esc(c.v)}">${esc(c.v)} (${c.n})</option>`).join(""));
  const counts = { H1: 0, H2: 0, H3: 0 };
  for (const n of nodes) counts[n.h] = (counts[n.h] || 0) + 1;
  $("legend").innerHTML = Object.entries(HLABEL).map(([k, label]) =>
    `<span><span class="dot" style="background:${HCOLOR[k]}"></span>${label} · ${counts[k] || 0}</span>`).join("");

  fit();
  const r = canvas.parentElement.getBoundingClientRect();
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(edges).id((n) => n.id).distance((e) => 26 + (1 - e.w) * 60).strength((e) => 0.3 + e.w * 0.5))
    .force("charge", d3.forceManyBody().strength(-14).theta(0.9))
    .force("center", d3.forceCenter(r.width / 2, r.height / 2))
    .force("collide", d3.forceCollide(4));
  if (reduced) {
    sim.stop();
    for (let i = 0; i < 250; i++) sim.tick();
    draw();
  } else {
    sim.on("tick", draw);
  }

  d3.select(canvas).call(zoom);
  canvas.addEventListener("pointermove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n !== hoverNode) { hoverNode = n; draw(); }
    if (n) {
      tip.style.display = "block";
      tip.style.left = (ev.clientX - rect.left + 14) + "px";
      tip.style.top = (ev.clientY - rect.top + 10) + "px";
      tip.innerHTML = `<strong>${esc(n.t)}</strong><br><span style="color:var(--textDim)">${esc(n.c)} · ${esc(HLABEL[n.h] || n.h)}</span>`;
    } else {
      tip.style.display = "none";
    }
  });
  canvas.addEventListener("pointerleave", () => { hoverNode = null; tip.style.display = "none"; draw(); });
  canvas.addEventListener("click", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const n = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
    if (n) openPanel(n);
  });

  $("mode").addEventListener("change", (e) => { mode = e.target.value; draw(); });
  $("clusterSel").addEventListener("change", (e) => { highlightCluster = e.target.value; draw(); });
  let deb;
  $("q").addEventListener("input", (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => { query = e.target.value.trim().toLowerCase(); draw(); }, 200);
  });
  addEventListener("resize", () => { fit(); draw(); }, { passive: true });
}

renderNav("/map");
boot();
