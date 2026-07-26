// Futures Triangle — live view. Dots settle barycentric-near their judged
// corner; the write-up and counts refresh while classification or synthesis
// run in the background (the API self-heals on read).
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const VERTS = { pull: [450, 60], push: [90, 560], weight: [810, 560] };
const COLORS = { pull: "#E1B83B", push: "#4E5A2B", weight: "#AC7222" };
const NAMES = { pull: "Pull of the future", push: "Push of the present", weight: "Weight of history" };
let data = null;

// deterministic per-id jitter so dots keep their seats between refreshes
const rand = (seed) => { let x = Math.imul(seed ^ 0x9E3779B9, 0x85EBCA6B); x ^= x >>> 13; x = Math.imul(x, 0xC2B2AE35); return ((x ^= x >>> 16) >>> 0) / 4294967296; };

function place(sig) {
  // barycentric: heavy weight on the signal's own corner, small on the others
  const corners = ["pull", "push", "weight"];
  const own = 0.62 + rand(sig.id) * 0.3;
  const rest = 1 - own;
  const split = rand(sig.id * 7 + 1);
  const w = {};
  for (const c of corners) w[c] = c === sig.triangle ? own : 0;
  const others = corners.filter((c) => c !== sig.triangle);
  w[others[0]] = rest * split;
  w[others[1]] = rest * (1 - split);
  const x = corners.reduce((s, c) => s + w[c] * VERTS[c][0], 0);
  const y = corners.reduce((s, c) => s + w[c] * VERTS[c][1], 0);
  return [x, y];
}

function draw() {
  const dots = $("triDots");
  const all = [...data.corners.pull, ...data.corners.push, ...data.corners.weight];
  dots.innerHTML = all.map((s) => {
    const [x, y] = place(s);
    return `<circle class="tri-dot" data-id="${s.id}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.urgency === "critical" ? 6 : 4}" fill="${COLORS[s.triangle]}"/>`;
  }).join("");
  for (const c of ["pull", "push", "weight"]) {
    const g = document.querySelector(`.tri-corner[data-corner="${c}"] .tri-count`);
    if (g) g.textContent = data.counts[c];
  }
  const st = $("triStatus");
  if (data.classifying || data.unclassified > 0) {
    st.hidden = false;
    st.textContent = `Classifying new signals · ${data.total - data.unclassified} / ${data.total} judged`;
  } else st.hidden = true;

  const byId = new Map(all.map((s) => [s.id, s]));
  const tip = $("triTip");
  const svg = $("triSvg");
  svg.onmousemove = (e) => {
    const t = e.target.closest(".tri-dot");
    if (!t) { tip.hidden = true; return; }
    const s = byId.get(Number(t.dataset.id));
    const r = svg.getBoundingClientRect();
    tip.innerHTML = `<b>${esc(s.title)}</b><span>${esc(s.cluster)} · ${esc(NAMES[s.triangle])}</span>`;
    tip.hidden = false;
    tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 320) + "px";
    tip.style.top = (e.clientY - r.top + 14) + "px";
  };
  svg.onmouseleave = () => { tip.hidden = true; };
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

// corner drawers
function openCorner(corner) {
  const list = data.corners[corner];
  $("drawer").innerHTML = `
    <button class="drawer-close" id="drawerClose" aria-label="Close">&times;</button>
    <span class="tag tag-mustard" style="background:${COLORS[corner]}22;color:#131309;border:1px solid ${COLORS[corner]}66">${esc(NAMES[corner])}</span>
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

$("resynth").addEventListener("click", async () => {
  $("wuState").textContent = "re-synthesizing…";
  try { await api("/api/triangle/writeup", { method: "POST" }); } catch {}
  poll(true);
});

let timer = null;
async function load() {
  data = await api("/api/triangle");
  draw();
  drawWriteup();
  // keep polling while anything is in flight, so dots and text land live
  if (data.classifying || data.writing || data.unclassified > 0) {
    clearTimeout(timer);
    timer = setTimeout(load, 2500);
  }
}
function poll(force) { clearTimeout(timer); timer = setTimeout(load, force ? 800 : 2500); }

renderNav("/triangle");
load();
