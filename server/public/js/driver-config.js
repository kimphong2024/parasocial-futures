// Driver workshop — the human-in-the-loop definition surface: name and
// describe each driver, and group signal clusters under the drivers they
// justify. Distribution tuning stays on the Simulation page.
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
let drivers = [], clusters = []; // clusters: [{v, n}]

const assigned = (d) => JSON.parse(d.cluster_json || "[]");
const evidenceCount = (d) => assigned(d).reduce((sum, c) => sum + (clusters.find((x) => x.v === c)?.n || 0), 0);

function chip(c, on) {
  return `<button class="tag ${on ? "tag-mustard" : "tag-dim"}" data-cluster="${esc(c.v)}" title="${on ? "Remove from" : "Assign to"} this driver — ${c.n} signals">
    ${esc(c.v)} · ${c.n}
  </button>`;
}

function card(d) {
  const mine = assigned(d);
  const params = JSON.parse(d.params_json || "{}");
  return `<div class="card chart-block" data-id="${d.id}">
    <div class="flex-between" style="gap:14px;flex-wrap:wrap">
      <div style="flex:1 1 320px">
        <span class="caption" style="font-family:var(--font-mono)">${esc(d.key)}</span>
        <input data-p="name" value="${esc(d.name)}" style="display:block;width:100%;font-size:19px;font-weight:700;margin-top:6px">
        <div class="filter-bar mt-2">
          <label class="caption">Unit <input data-p="unit" value="${esc(d.unit)}" style="width:160px"></label>
          <span class="caption">${esc(d.dist_type)} · ${params.min ?? "?"} / ${params.mode ?? "–"} / ${params.max ?? "?"} — <a href="/simulation">tune on Simulation</a></span>
        </div>
      </div>
      <div style="display:flex;gap:12px;align-items:center">
        <span class="tag tag-olive">${evidenceCount(d)} evidence signals</span>
        <label class="toggle caption">on <input type="checkbox" data-p="enabled" ${d.enabled ? "checked" : ""}></label>
        <button class="btn-danger btn btn-sm" data-del>Delete</button>
      </div>
    </div>
    <label class="caption mt-4" style="display:block">Description
      <textarea data-p="description" rows="2" style="width:100%;margin-top:4px">${esc(d.description)}</textarea>
    </label>
    <label class="caption mt-2" style="display:block">Rationale — why this range, in whose evidence
      <textarea data-p="rationale" rows="2" style="width:100%;margin-top:4px">${esc(d.rationale)}</textarea>
    </label>
    <p class="caption mt-4"><strong>Evidence clusters</strong> — click to assign or remove; a cluster may inform several drivers. <a data-inspect style="cursor:pointer">Inspect assigned in the library →</a></p>
    <div class="mt-2" style="display:flex;gap:6px;flex-wrap:wrap">
      ${clusters.map((c) => chip(c, mine.includes(c.v))).join("")}
    </div>
    <div data-msg class="caption mt-2"></div>
  </div>`;
}

function render() {
  $("driverList").innerHTML = drivers.map(card).join("");
  const claimed = new Set(drivers.flatMap(assigned));
  const orphans = clusters.filter((c) => !claimed.has(c.v));
  $("unclaimed").innerHTML = orphans.length
    ? orphans.map((c) => `<a class="tag tag-brown" href="/signals?cluster=${encodeURIComponent(c.v)}" target="_blank" rel="noopener" title="Open in the signal library">${esc(c.v)} · ${c.n}</a>`).join(" ")
    : `<p class="caption">Every cluster is grouped under at least one driver.</p>`;
}

async function load() {
  const [dj, fj] = await Promise.all([api("/api/drivers"), api("/api/signals/facets?status=approved")]);
  drivers = dj.drivers;
  clusters = fj.cluster;
  render();
}

let saveTimer = null;
$("driverList").addEventListener("input", (e) => {
  const cardEl = e.target.closest("[data-id]");
  const p = e.target.dataset.p;
  if (!cardEl || !p || p === "enabled") return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await api("/api/drivers/" + cardEl.dataset.id, { method: "PATCH", body: { [p]: e.target.value } });
    cardEl.querySelector("[data-msg]").textContent = "Saved.";
    const dr = drivers.find((x) => x.id === +cardEl.dataset.id);
    if (dr) dr[p] = e.target.value;
  }, 500);
});

$("driverList").addEventListener("change", async (e) => {
  const cardEl = e.target.closest("[data-id]");
  if (!cardEl || e.target.dataset.p !== "enabled") return;
  await api("/api/drivers/" + cardEl.dataset.id, { method: "PATCH", body: { enabled: e.target.checked } });
});

$("driverList").addEventListener("click", async (e) => {
  const cardEl = e.target.closest("[data-id]");
  if (!cardEl) return;
  const dr = drivers.find((x) => x.id === +cardEl.dataset.id);

  const chipBtn = e.target.closest("[data-cluster]");
  if (chipBtn && dr) {
    const c = chipBtn.dataset.cluster;
    const mine = assigned(dr);
    const next = mine.includes(c) ? mine.filter((x) => x !== c) : [...mine, c];
    dr.cluster_json = JSON.stringify(next);
    await api("/api/drivers/" + dr.id, { method: "PATCH", body: { cluster_json: next } });
    render();
    return;
  }
  if (e.target.closest("[data-inspect]") && dr) {
    const first = assigned(dr)[0];
    if (first) open("/signals?cluster=" + encodeURIComponent(first), "_blank");
    return;
  }
  if (e.target.closest("[data-del]") && dr) {
    try {
      await api("/api/drivers/" + dr.id, { method: "DELETE" });
      drivers = drivers.filter((x) => x.id !== dr.id);
      render();
    } catch (err) {
      cardEl.querySelector("[data-msg]").innerHTML = `<span class="error-note" style="display:inline-block;padding:6px 10px">${esc(err.message)}</span>`;
    }
  }
});

$("addDriver").addEventListener("click", async () => {
  $("addErr").innerHTML = "";
  try {
    await api("/api/drivers", { method: "POST", body: { key: $("newKey").value.trim(), name: $("newName").value.trim(), unit: $("newUnit").value.trim() } });
    $("newKey").value = ""; $("newName").value = ""; $("newUnit").value = "";
    load();
  } catch (e) {
    $("addErr").innerHTML = `<div class="error-note">${esc(e.message)}</div>`;
  }
});

renderNav("/driver-config");
load();
