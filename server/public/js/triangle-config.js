// Triangle configure — the human-override board. Three columns, one per
// force; drag a signal into another column (or use its arrows) to
// reclassify it. Moves persist immediately and re-anchor the synthesis.
import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const CORNERS = ["pull", "push", "weight"];
const COLORS = { pull: "225,184,59", push: "78,90,43", weight: "172,114,34" };
const NAMES = { pull: "Pull of the future", push: "Push of the present", weight: "Weight of history" };

let signals = new Map();   // id -> signal (with .triangle kept current)

function row(s) {
  const others = CORNERS.filter((c) => c !== s.triangle);
  return `
    <div class="tcfg-row" draggable="true" data-id="${s.id}" title="${esc(s.triangle_reasoning || "")}">
      <div class="tcfg-row-main">
        <b>${esc(s.title)}</b>
        <span class="caption">${esc(s.cluster)}${s.horizon ? " · " + esc(s.horizon) : ""}</span>
      </div>
      <div class="tcfg-move">
        ${others.map((c) => `<button data-to="${c}" title="Move to ${esc(NAMES[c])}" aria-label="Move to ${esc(NAMES[c])}"><i style="background:rgb(${COLORS[c]})"></i></button>`).join("")}
      </div>
    </div>`;
}

function renderColumn(corner) {
  const col = document.querySelector(`.tcfg-col[data-corner="${corner}"]`);
  const q = (col.querySelector("input").value || "").toLowerCase();
  const list = [...signals.values()]
    .filter((s) => s.triangle === corner)
    .filter((s) => !q || s.title.toLowerCase().includes(q) || (s.cluster || "").toLowerCase().includes(q));
  col.querySelector(".tcfg-body").innerHTML = list.map(row).join("") || `<p class="caption tcfg-empty">No signals${q ? " match" : ""}.</p>`;
  col.querySelector(".tcfg-n").textContent = [...signals.values()].filter((s) => s.triangle === corner).length;
  updateEndCue(col);
}
const renderAll = () => CORNERS.forEach(renderColumn);

// ---------- moving ----------
let inflight = 0;
async function move(id, to) {
  const s = signals.get(id);
  if (!s || s.triangle === to) return;
  const from = s.triangle;
  s.triangle = to;
  s.triangle_reasoning = `Reclassified ${from} → ${to} by the reviewer.`;
  renderColumn(from); renderColumn(to);
  flash(to, id);
  inflight++;
  $("tcfgState").textContent = "Saving…";
  try {
    await api(`/api/triangle/signals/${id}`, { method: "PATCH", body: { triangle: to } });
    if (--inflight === 0) $("tcfgState").textContent = `Saved — the triangle and its synthesis update from your move.`;
  } catch (e) {
    s.triangle = from;                               // snap back on failure
    renderColumn(from); renderColumn(to);
    inflight--;
    $("tcfgState").textContent = `Could not save that move (${e.message}) — reverted.`;
  }
}

function flash(corner, id) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`.tcfg-col[data-corner="${corner}"] .tcfg-row[data-id="${id}"]`);
    if (el) { el.classList.add("just-moved"); setTimeout(() => el.classList.remove("just-moved"), 900); }
  });
}

// ---------- drag and drop ----------
let dragId = null;
document.addEventListener("dragstart", (e) => {
  const r = e.target.closest?.(".tcfg-row");
  if (!r) return;
  dragId = Number(r.dataset.id);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", r.dataset.id);
  r.classList.add("dragging");
});
document.addEventListener("dragend", (e) => {
  e.target.closest?.(".tcfg-row")?.classList.remove("dragging");
  document.querySelectorAll(".tcfg-col.dropping").forEach((c) => c.classList.remove("dropping"));
  dragId = null;
});
for (const col of document.querySelectorAll(".tcfg-col")) {
  col.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("dropping"); });
  col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("dropping"); });
  col.addEventListener("drop", (e) => {
    e.preventDefault();
    col.classList.remove("dropping");
    const id = dragId ?? Number(e.dataTransfer.getData("text/plain"));
    if (id) move(id, col.dataset.corner);
  });
}

// ---------- clicks: arrows move, rows open the drawer ----------
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".tcfg-move button");
  if (btn) {
    const id = Number(btn.closest(".tcfg-row").dataset.id);
    move(id, btn.dataset.to);
    return;
  }
  const r = e.target.closest(".tcfg-row");
  if (r) openSignal(Number(r.dataset.id));
});

function closeDrawer() { document.body.classList.remove("drawer-open"); }
$("backdrop").addEventListener("click", closeDrawer);

async function openSignal(id) {
  const sig = signals.get(id);
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

// column filters + scroll-end cue
function updateEndCue(col) {
  const b = col.querySelector(".tcfg-body");
  col.classList.toggle("at-end", b.scrollTop + b.clientHeight >= b.scrollHeight - 6);
}
for (const col of document.querySelectorAll(".tcfg-col")) {
  col.querySelector("input").addEventListener("input", () => renderColumn(col.dataset.corner));
  col.querySelector(".tcfg-body").addEventListener("scroll", () => updateEndCue(col), { passive: true });
}

// ---------- load ----------
let loadTimer = null;
async function load() {
  const data = await api("/api/triangle");
  signals = new Map();
  for (const c of CORNERS) for (const s of data.corners[c]) signals.set(s.id, s);
  renderAll();
  if (data.unclassified > 0 || data.classifying) {
    $("tcfgState").textContent = `${signals.size} of ${signals.size + data.unclassified} approved signals classified and listed — ${data.unclassified} still being judged; they appear here automatically.`;
    clearTimeout(loadTimer);
    loadTimer = setTimeout(load, 3000);
  } else if (!$("tcfgState").textContent.startsWith("Saved")) {
    $("tcfgState").textContent = `All ${signals.size} approved signals are listed across the three sections.`;
  }
}

renderNav("/triangle-config");
load();
