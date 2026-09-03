import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";
import { sourceText, wireSourceText } from "./signal-text.js";
import { hbar } from "./charts.js";

const state = { q: "", semantic: false, cluster: "", type: "", horizon: "", provenance: "", sort: "newest", page: 1 };
const $ = (id) => document.getElementById(id);

const TYPE_TAG = { research: "tag-olive", market: "tag-brown", regulatory: "tag-blue", discourse: "tag-mustard", behavioral: "tag-olive", "crisis/legal": "tag-red" };

function signalCard(s) {
  return `<article class="card signal-card" data-id="${s.id}">
    <div class="tags">
      ${s.cluster ? `<span class="tag tag-olive">${esc(s.cluster)}</span>` : ""}
      ${s.signal_type ? `<span class="tag ${TYPE_TAG[s.signal_type] || "tag-dim"}">${esc(s.signal_type)}</span>` : ""}
      ${s.horizon ? `<span class="tag tag-dim">${esc(s.horizon)}</span>` : ""}
    </div>
    <h4>${esc(s.title)}</h4>
    <div class="summary">${esc(s.summary)}</div>
    <div class="signal-meta">
      <span><span class="urgency-dot urgency-${esc(s.urgency || "low")}"></span>${esc(s.urgency || "")}</span>
      <span>${esc(s.source || "")}${s.year ? " · " + s.year : ""}</span>
    </div>
  </article>`;
}

async function loadStats(health) {
  const h = health || await api("/api/health");
  $("stats").innerHTML = `
    <div class="card stat-tile"><div class="stat-number">${h.approved}</div><div class="stat-desc">approved signals in the library</div></div>
    <div class="card stat-tile"><div class="stat-number mustard">${h.pending}</div><div class="stat-desc">scan hits awaiting review</div></div>
    <div class="card stat-tile"><div class="stat-number brown">${h.scenarios}</div><div class="stat-desc">published scenarios</div></div>
    <div class="card stat-tile"><div class="stat-number" style="font-size:clamp(18px,1.6vw,24px);margin-top:10px">${h.lastScan ? fmtDate(h.lastScan.finished_at) : "not yet run"}</div><div class="stat-desc">last scan${h.lastScan ? ` · ${h.lastScan.new_pending} new pending` : ""}</div></div>`;
}

async function loadFacets() {
  const f = await api("/api/signals/facets");
  const fill = (id, rows) => {
    const sel = $(id);
    rows.forEach((r) => sel.insertAdjacentHTML("beforeend", `<option value="${esc(r.v)}">${esc(r.v)} (${r.n})</option>`));
  };
  fill("type", f.signal_type);
  fill("horizon", f.horizon);
  fill("provenance", f.provenance);
  $("clusters").innerHTML = `<button class="pill active" data-cluster="">All clusters</button>` +
    f.cluster.map((c) => `<button class="pill" data-cluster="${esc(c.v)}">${esc(c.v)}<span class="count">${c.n}</span></button>`).join("");
  $("clusters").addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (!b) return;
    state.cluster = b.dataset.cluster;
    state.page = 1;
    document.querySelectorAll(".pill").forEach((p) => p.classList.toggle("active", p === b));
    load();
  });
}

// "Where the library comes from" — magnitude charts (single hue each,
// direct-labeled thin bars). Cluster bars filter the library on click.
// hbar() lives in charts.js now; the report draws the same composition.

async function loadOverview() {
  const o = await api("/api/signals/overview");
  const cMax = Math.max(...o.clusters.map((c) => c.n));
  $("clusterChart").innerHTML = o.clusters.map((c) =>
    hbar(c.v, c.n, cMax, { cls: "clickable", data: `data-gocluster="${esc(c.v)}"` })).join("");
  const sMax = Math.max(...o.sources.top.map((s) => s.n));
  $("sourceChart").innerHTML =
    o.sources.top.map((s) => hbar(s.v, s.n, sMax, { cls: "alt" })).join("") +
    `<p class="caption hbar-note">…plus ${o.sources.other} signals from ${o.sources.distinct - o.sources.top.length} sources cited only a handful of times each — the long tail is most of the library, by design.</p>`;
  $("overviewNote").textContent = `${o.total} signals · ${o.clusters.length} clusters · ${o.sources.distinct} distinct sources`;
  $("overview").style.display = "";
  $("clusterChart").addEventListener("click", (e) => {
    const bar = e.target.closest("[data-gocluster]");
    if (!bar) return;
    state.cluster = bar.dataset.gocluster;
    state.page = 1;
    document.querySelectorAll("#clusters .pill").forEach((p) =>
      p.classList.toggle("active", p.dataset.cluster === state.cluster));
    load();
    $("grid").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function load() {
  const grid = $("grid");
  if (state.semantic && state.q) {
    try {
      const j = await api(`/api/search?q=${encodeURIComponent(state.q)}`);
      grid.innerHTML = j.signals.length ? j.signals.map(signalCard).join("") : `<div class="empty-note">No semantic matches.</div>`;
      $("pager").innerHTML = `<span class="caption">${j.signals.length} semantic matches</span>`;
    } catch (e) {
      grid.innerHTML = `<div class="error-note">${esc(e.message)}</div>`;
    }
    return;
  }
  const params = new URLSearchParams({ q: state.q, cluster: state.cluster, type: state.type, horizon: state.horizon, provenance: state.provenance, sort: state.sort, page: state.page, limit: 30 });
  const j = await api("/api/signals?" + params);
  grid.innerHTML = j.signals.length ? j.signals.map(signalCard).join("") : `<div class="empty-note">No signals match these filters.</div>`;
  const pages = Math.max(1, Math.ceil(j.total / j.limit));
  $("pager").innerHTML = `
    <button class="btn btn-secondary btn-sm" id="prev" ${state.page <= 1 ? "disabled" : ""}>Previous</button>
    <span class="caption">${j.total} signals · page ${state.page} of ${pages}</span>
    <button class="btn btn-secondary btn-sm" id="next" ${state.page >= pages ? "disabled" : ""}>Next</button>`;
  $("prev")?.addEventListener("click", () => { state.page--; load(); window.scrollTo({ top: 0 }); });
  $("next")?.addEventListener("click", () => { state.page++; load(); window.scrollTo({ top: 0 }); });
}

async function openDrawer(id) {
  const s = await api("/api/signals/" + id);
  $("drawer").innerHTML = `
    <button class="drawer-close" id="dclose" aria-label="Close">&times;</button>
    <div class="tags mb-4" style="display:flex;gap:6px;flex-wrap:wrap">
      ${s.cluster ? `<span class="tag tag-olive">${esc(s.cluster)}</span>` : ""}
      ${s.signal_type ? `<span class="tag ${TYPE_TAG[s.signal_type] || "tag-dim"}">${esc(s.signal_type)}</span>` : ""}
      ${s.horizon ? `<span class="tag tag-dim">${esc(s.horizon)}</span>` : ""}
    </div>
    <h3 style="font-size:22px">${esc(s.title)}</h3>
    <p class="mt-4">${esc(s.summary)}</p>
    <div class="meta-grid">
      <div><span class="label" style="color:var(--textDim)">Urgency</span><p><span class="urgency-dot urgency-${esc(s.urgency || "low")}"></span>${esc(s.urgency || "—")}</p></div>
      <div><span class="label" style="color:var(--textDim)">Year</span><p>${s.year || "—"}</p></div>
      <div><span class="label" style="color:var(--textDim)">Provenance</span><p>${esc(s.provenance || "—")}</p></div>
      <div><span class="label" style="color:var(--textDim)">Status</span><p>${esc(s.status)}</p></div>
    </div>
    ${s.topic_tags ? `<p class="caption">${esc(s.topic_tags.split(";").join(" · "))}</p>` : ""}
    ${noteCard(s)}
      ${sourceText(s)}
    ${s.horizon_reasoning ? `
      <h4 class="mt-4">Horizon ${esc(s.horizon)} — judged with reasoning</h4>
      <p class="caption" style="line-height:1.7">${esc(s.horizon_reasoning)}</p>
      ${s.horizon_judged_at ? `<p class="caption mt-2" style="color:var(--textDim)">Judged ${esc(s.horizon_judged_at.slice(0, 10))}</p>` : ""}` : ""}
    <div class="citation mt-4">
      <div class="quote">${esc(s.summary)}</div>
      <div class="source"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source || s.url)}</a></div>
    </div>
    ${s.similar?.length ? `<h4 class="mt-6">Similar signals</h4>` + s.similar.map((x) =>
      `<div class="card signal-card mt-2" data-id="${x.id}" style="padding:14px">
        <h4 style="font-size:13px">${esc(x.title)}</h4>
        <div class="signal-meta"><span>${esc(x.cluster)}</span><span>cos ${x.score}</span></div>
      </div>`).join("") : ""}`;
  wireNoteCard($("drawer")); wireSourceText($("drawer"));
  document.body.classList.add("drawer-open");
  $("dclose").addEventListener("click", closeDrawer);
}
const closeDrawer = () => document.body.classList.remove("drawer-open");

// wiring
let debounce;
$("q").addEventListener("input", (e) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; load(); }, 300);
});
$("semantic").addEventListener("change", (e) => { state.semantic = e.target.checked; load(); });
["type", "horizon", "provenance", "sort"].forEach((k) =>
  $(k).addEventListener("change", (e) => { state[k === "type" ? "type" : k] = e.target.value; state.page = 1; load(); }));
$("backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
document.addEventListener("click", (e) => {
  const card = e.target.closest(".signal-card");
  if (card) openDrawer(card.dataset.id);
});

const health = await renderNav("/signals");
loadStats(health);
loadFacets();
loadOverview();
load();
