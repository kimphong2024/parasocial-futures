import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const id = new URLSearchParams(location.search).get("id");
const $ = (id) => document.getElementById(id);
let sc = null, editing = false;

const LAYERS = [
  ["litany", "Layer 1 — Litany", "cla-litany", "The visible surface of 2040: headlines, statistics, everyday observations."],
  ["systemic", "Layer 2 — Systemic Causes", "cla-systemic", "The structures producing the surface: economics, technology, regulation, demography."],
  ["worldview", "Layer 3 — Worldview", "cla-worldview", "The shared beliefs that make this world coherent to the people living in it."],
  ["myth", "Layer 4 — Myth and Metaphor", "cla-myth", "The deep story underneath."],
];

const condText = (c) => {
  if (c.op === "lte") return `${c.driver_key} ≤ ${c.value}`;
  if (c.op === "gte") return `${c.driver_key} ≥ ${c.value}`;
  if (c.op === "between") return `${c.driver_key} in [${c.lo}, ${c.hi}]`;
  return `${c.driver_key} ${c.op}`;
};

function render() {
  const conds = JSON.parse(sc.driver_conditions || "[]");
  $("main").innerHTML = `
    <div class="page-head flex-between">
      <div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="tag tag-olive">${esc(sc.archetype)}</span>
          <span class="status-chip status-${esc(sc.status)}">${esc(sc.status)}</span>
          <span class="caption">horizon ${sc.horizon_year}</span>
        </div>
        ${editing
          ? `<input id="e-title" value="${esc(sc.title)}" style="font-size:26px;font-weight:800;width:100%;margin-top:12px">`
          : `<h2 class="mt-2">${esc(sc.title)}</h2>`}
        ${editing
          ? `<textarea id="e-summary" rows="3" class="mt-2">${esc(sc.summary)}</textarea>`
          : `<p class="subtitle mt-2">${esc(sc.summary)}</p>`}
        <div class="divider mt-4"></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${editing
          ? `<button class="btn" id="save">Save changes</button><button class="btn btn-secondary" id="cancel">Cancel</button>`
          : `<button class="btn btn-secondary" id="edit">Edit</button>
             ${sc.status === "draft" ? `<button class="btn" id="publish">Publish</button>` : ""}
             ${sc.status !== "archived" ? `<button class="btn-danger btn" id="archive">Archive</button>` : ""}`}
      </div>
    </div>
    <div id="err"></div>

    ${LAYERS.map(([key, name, cls, hint]) => `
      <section class="cla-band ${cls}">
        <span class="label">${name}</span>
        ${editing
          ? `<textarea id="e-${key}" rows="5">${esc(sc[key])}</textarea>`
          : `<p>${esc(sc[key])}</p>`}
        <p class="caption mt-2">${hint}</p>
      </section>`).join("")}

    <section class="card chart-block mt-6">
      <h4>Narrative — a day in this 2040</h4>
      ${editing
        ? `<textarea id="e-narrative" rows="14">${esc(sc.narrative)}</textarea>`
        : `<p style="white-space:pre-wrap">${esc(sc.narrative)}</p>`}
    </section>

    <section class="card chart-block">
      <h4>Where this scenario lives in the driver space</h4>
      <p class="caption mb-4">The simulation counts a sampled future as belonging to this scenario when all conditions hold.</p>
      ${editing
        ? `<textarea id="e-conditions" rows="6">${esc(JSON.stringify(conds, null, 2))}</textarea>
           <p class="caption mt-2">JSON: [{"driver_key", "op": "lte" | "gte" | "between", "value" | "lo" + "hi"}]</p>`
        : (conds.length
            ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${conds.map((c) => `<span class="tag tag-mustard">${esc(condText(c))}</span>`).join("")}</div>`
            : `<p class="caption">No conditions set — this scenario will not appear in simulations.</p>`)}
    </section>

    <section class="card chart-block">
      <h4>Evidence — cited signals (${sc.cited.length})</h4>
      <p class="caption mb-4">Signals from the approved library that anchored this draft.</p>
      ${sc.cited.map((s) => `
        <div class="citation mt-2" style="cursor:pointer" data-sig="${s.id}">
          <div class="quote">${esc(s.title)} — ${esc(s.summary).slice(0, 160)}${s.summary.length > 160 ? "…" : ""}</div>
          <div class="source">S${s.id} · ${esc(s.cluster)} · ${esc(s.source || "")}</div>
        </div>`).join("") || `<p class="caption">No citations recorded.</p>`}
    </section>`;

  wire();
}

function wire() {
  $("edit")?.addEventListener("click", () => { editing = true; render(); });
  $("cancel")?.addEventListener("click", () => { editing = false; render(); });
  $("save")?.addEventListener("click", async () => {
    let conds;
    try { conds = JSON.parse($("e-conditions").value); }
    catch { $("err").innerHTML = `<div class="error-note">Driver conditions are not valid JSON.</div>`; return; }
    const patch = {
      title: $("e-title").value, summary: $("e-summary").value,
      litany: $("e-litany").value, systemic: $("e-systemic").value,
      worldview: $("e-worldview").value, myth: $("e-myth").value,
      narrative: $("e-narrative").value, driver_conditions: conds,
    };
    await api("/api/scenarios/" + sc.id, { method: "PATCH", body: patch });
    editing = false;
    await load();
  });
  $("publish")?.addEventListener("click", async () => {
    await api(`/api/scenarios/${sc.id}/publish`, { method: "POST" });
    await load();
  });
  $("archive")?.addEventListener("click", async () => {
    await api(`/api/scenarios/${sc.id}/archive`, { method: "POST" });
    location.href = "/scenarios";
  });
  document.querySelectorAll("[data-sig]").forEach((el) =>
    el.addEventListener("click", async () => {
      const s = await api("/api/signals/" + el.dataset.sig);
      $("drawer").innerHTML = `
        <button class="drawer-close" id="dclose" aria-label="Close">&times;</button>
        <span class="tag tag-olive">${esc(s.cluster)}</span>
        <h3 style="font-size:20px" class="mt-4">${esc(s.title)}</h3>
        <p class="mt-2">${esc(s.summary)}</p>
        <div class="citation mt-4">
          <div class="quote">${esc(s.source || "")} · ${s.year || ""}</div>
          <div class="source"><a href="${esc(s.url)}" target="_blank" rel="noopener">source link</a></div>
        </div>`;
      document.body.classList.add("drawer-open");
      $("dclose").addEventListener("click", () => document.body.classList.remove("drawer-open"));
    }));
}

async function load() {
  sc = await api("/api/scenarios/" + id);
  document.title = `${sc.title} — Futures of Parasocial AI`;
  render();
}

$("backdrop").addEventListener("click", () => document.body.classList.remove("drawer-open"));
renderNav("/scenarios");
load();
