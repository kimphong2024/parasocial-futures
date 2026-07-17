// Scenario configuration — every scenario in every status, with lifecycle
// actions and a structured editor for driver conditions (no raw JSON).
import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const ORDER = ["growth", "collapse", "discipline", "transformation"];
let scenarios = [], archetypes = {}, drivers = [];

const conds = (sc) => JSON.parse(sc.driver_conditions || "[]");
const cited = (sc) => JSON.parse(sc.signal_ids || "[]").length;

function condRow(c = { driver_key: "", op: "gte" }) {
  const opts = drivers.map((dr) =>
    `<option value="${esc(dr.key)}" ${dr.key === c.driver_key ? "selected" : ""}>${esc(dr.name)}${dr.enabled ? "" : " (disabled)"}</option>`).join("");
  const known = drivers.some((dr) => dr.key === c.driver_key);
  return `<div class="filter-bar cond-row" style="align-items:center">
    <select data-c="driver_key" style="flex:0 1 260px">
      ${known || !c.driver_key ? "" : `<option value="${esc(c.driver_key)}" selected>${esc(c.driver_key)} (missing driver!)</option>`}
      ${opts}
    </select>
    <select data-c="op" style="width:110px">
      <option value="gte" ${c.op === "gte" ? "selected" : ""}>≥</option>
      <option value="lte" ${c.op === "lte" ? "selected" : ""}>≤</option>
      <option value="between" ${c.op === "between" ? "selected" : ""}>between</option>
    </select>
    <input type="number" data-c="value" step="any" value="${c.op === "between" ? "" : (c.value ?? "")}" placeholder="value" style="width:100px;${c.op === "between" ? "display:none" : ""}">
    <input type="number" data-c="lo" step="any" value="${c.lo ?? ""}" placeholder="low" style="width:90px;${c.op === "between" ? "" : "display:none"}">
    <input type="number" data-c="hi" step="any" value="${c.hi ?? ""}" placeholder="high" style="width:90px;${c.op === "between" ? "" : "display:none"}">
    <button class="btn btn-sm btn-secondary" data-rmcond title="Remove condition">×</button>
  </div>`;
}

function row(sc) {
  const cs = conds(sc);
  const missing = cs.filter((c) => !drivers.some((dr) => dr.key === c.driver_key)).length;
  return `<tr data-id="${sc.id}" style="cursor:pointer" title="Click to edit conditions">
    <td>▸ ${esc(sc.title)}</td>
    <td><span class="status-chip status-${esc(sc.status)}">${esc(sc.status)}</span></td>
    <td>${sc.horizon_year}</td>
    <td>${cs.length}${missing ? ` <span class="tag tag-red" title="references a driver that no longer exists">${missing} missing driver</span>` : ""}</td>
    <td>${cited(sc)}</td>
    <td class="caption">${fmtDate(sc.updated_at || sc.created_at)}</td>
    <td style="white-space:nowrap">
      <a class="btn btn-sm btn-secondary" href="/scenario?id=${sc.id}">Open</a>
      ${sc.status === "draft" ? `<button class="btn btn-sm" data-act="publish">Publish</button>` : ""}
      ${sc.status !== "archived" ? `<button class="btn btn-sm btn-danger" data-act="archive">Archive</button>` : `<button class="btn btn-sm" data-act="restore">Restore to draft</button>`}
    </td>
  </tr>`;
}

function editor(sc) {
  const cs = conds(sc);
  return `<tr class="cond-editor" data-editor="${sc.id}"><td colspan="7" style="padding:16px 22px">
    <p class="caption"><strong>Driver conditions</strong> — the region of driver space where this scenario holds. A sampled future belongs here only when every condition is true. Prefer one or two broad conditions; tight boxes collapse the scenario's probability.</p>
    <div class="mt-2" data-rows>${cs.map(condRow).join("") || ""}</div>
    <div class="filter-bar mt-2">
      <button class="btn btn-sm btn-secondary" data-addcond>Add condition</button>
      <button class="btn btn-sm" data-savecond>Save conditions</button>
      <span class="caption" data-condmsg></span>
    </div>
  </td></tr>`;
}

function render() {
  $("groups").innerHTML = ORDER.map((arch) => {
    const rows = scenarios.filter((s) => s.archetype === arch);
    return `<div class="card chart-block">
      <h4>${esc(archetypes[arch]?.name || arch)}</h4>
      ${rows.length
        ? `<table class="data mt-4"><thead><tr><th>Scenario</th><th>Status</th><th>Horizon</th><th>Conditions</th><th>Cited</th><th>Updated</th><th></th></tr></thead>
           <tbody>${rows.map(row).join("")}</tbody></table>`
        : `<p class="caption mt-2">Nothing drafted for this archetype yet — draft one from the <a href="/scenarios">Scenarios page</a>.</p>`}
    </div>`;
  }).join("");
}

function readConditions(editorEl) {
  const out = [];
  for (const rowEl of editorEl.querySelectorAll(".cond-row")) {
    const g = (k) => rowEl.querySelector(`[data-c="${k}"]`);
    const c = { driver_key: g("driver_key").value, op: g("op").value };
    if (!c.driver_key) continue;
    if (c.op === "between") {
      c.lo = Number(g("lo").value); c.hi = Number(g("hi").value);
      if (!Number.isFinite(c.lo) || !Number.isFinite(c.hi) || c.lo > c.hi) throw new Error(`${c.driver_key}: between needs low ≤ high`);
    } else {
      c.value = Number(g("value").value);
      if (!Number.isFinite(c.value)) throw new Error(`${c.driver_key}: value required`);
    }
    out.push(c);
  }
  return out;
}

$("groups").addEventListener("click", async (e) => {
  // lifecycle actions
  const act = e.target.closest("[data-act]");
  if (act) {
    e.stopPropagation();
    const id = act.closest("tr[data-id]").dataset.id;
    try {
      await api(`/api/scenarios/${id}/${act.dataset.act}`, { method: "POST" });
      await load();
    } catch (err) {
      $("err").innerHTML = `<div class="error-note">${esc(err.message)}</div>`;
    }
    return;
  }
  if (e.target.closest("a")) return;

  // condition editor toggling / actions
  const editorEl = e.target.closest("[data-editor]");
  if (editorEl) {
    const sc = scenarios.find((s) => s.id === +editorEl.dataset.editor);
    if (e.target.closest("[data-addcond]")) {
      editorEl.querySelector("[data-rows]").insertAdjacentHTML("beforeend", condRow());
    } else if (e.target.closest("[data-rmcond]")) {
      e.target.closest(".cond-row").remove();
    } else if (e.target.closest("[data-savecond]")) {
      const msg = editorEl.querySelector("[data-condmsg]");
      try {
        const cs = readConditions(editorEl);
        await api("/api/scenarios/" + sc.id, { method: "PATCH", body: { driver_conditions: cs } });
        sc.driver_conditions = JSON.stringify(cs);
        msg.textContent = "Saved — the next simulation run uses these.";
        render();
      } catch (err) {
        msg.textContent = err.message;
      }
    }
    return;
  }

  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  const open = tr.nextElementSibling?.classList.contains("cond-editor");
  document.querySelectorAll(".cond-editor").forEach((el) => el.remove());
  if (!open) {
    const sc = scenarios.find((s) => s.id === +tr.dataset.id);
    tr.insertAdjacentHTML("afterend", editor(sc));
  }
});

// op select swaps value/lo-hi inputs
$("groups").addEventListener("change", (e) => {
  if (e.target.dataset.c !== "op") return;
  const rowEl = e.target.closest(".cond-row");
  const between = e.target.value === "between";
  rowEl.querySelector('[data-c="value"]').style.display = between ? "none" : "";
  rowEl.querySelector('[data-c="lo"]').style.display = between ? "" : "none";
  rowEl.querySelector('[data-c="hi"]').style.display = between ? "" : "none";
});

async function load() {
  const [sj, dj] = await Promise.all([api("/api/scenarios"), api("/api/drivers")]);
  scenarios = sj.scenarios;
  archetypes = sj.archetypes;
  drivers = dj.drivers;
  render();
}

renderNav("/scenario-config");
load();
