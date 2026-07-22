import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";
import { probabilityBars, tornado, densityPreview, ARCH_COLOR } from "./charts.js";

const $ = (id) => document.getElementById(id);

function driverCard(d) {
  const p = JSON.parse(d.params_json);
  const isRange = ["pert", "triangular"].includes(d.dist_type);
  return `<div class="card driver-card" data-id="${d.id}">
    <div class="flex-between">
      <h4 style="font-size:14px">${esc(d.name)}</h4>
      <label class="toggle"><input type="checkbox" data-p="enabled" ${d.enabled ? "checked" : ""}> on</label>
    </div>
    <p class="caption">${esc(d.description)} <em>(${esc(d.unit)})</em></p>
    <div class="params">
      <select data-p="dist_type" aria-label="Distribution type for ${esc(d.name)}">
        ${["pert", "triangular", "uniform"].map((t) => `<option ${t === d.dist_type ? "selected" : ""}>${t}</option>`).join("")}
      </select>
      <input type="number" step="any" data-p="min" value="${p.min}" title="min" aria-label="${esc(d.name)} minimum">
      <input type="number" step="any" data-p="mode" value="${p.mode ?? ""}" aria-label="${esc(d.name)} mode" title="mode" ${d.dist_type === "uniform" ? "disabled" : ""}>
      <input type="number" step="any" data-p="max" value="${p.max}" title="max" aria-label="${esc(d.name)} maximum">
    </div>
    <div class="preview" data-preview></div>
    <p class="caption mt-2" style="font-size:11px">${esc(d.rationale)}</p>
    <p class="caption" data-err style="color:var(--urgentRed)"></p>
  </div>`;
}

async function loadDrivers() {
  const j = await api("/api/drivers");
  $("drivers").innerHTML = j.drivers.map(driverCard).join("");
  for (const d of j.drivers) refreshPreview(document.querySelector(`[data-id="${d.id}"]`));
}

async function refreshPreview(card) {
  const id = card.dataset.id;
  const dist = card.querySelector('[data-p="dist_type"]').value;
  const params = collectParams(card);
  try {
    const j = await api(`/api/drivers/${id}/preview?dist_type=${dist}&params=${encodeURIComponent(JSON.stringify(params))}`);
    densityPreview(card.querySelector("[data-preview]"), j.histogram);
    card.querySelector("[data-err]").textContent = "";
  } catch (e) {
    card.querySelector("[data-err]").textContent = e.message;
  }
}

const collectParams = (card) => {
  const v = (k) => Number(card.querySelector(`[data-p="${k}"]`).value);
  const dist = card.querySelector('[data-p="dist_type"]').value;
  return dist === "uniform" ? { min: v("min"), max: v("max") } : { min: v("min"), mode: v("mode"), max: v("max") };
};

let saveTimer;
$("drivers").addEventListener("input", (e) => {
  const card = e.target.closest(".driver-card");
  if (!card) return;
  card.querySelector('[data-p="mode"]').disabled = card.querySelector('[data-p="dist_type"]').value === "uniform";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const patch = {
      dist_type: card.querySelector('[data-p="dist_type"]').value,
      params_json: collectParams(card),
      enabled: card.querySelector('[data-p="enabled"]').checked,
    };
    try {
      await api("/api/drivers/" + card.dataset.id, { method: "PATCH", body: patch });
      card.querySelector("[data-err]").textContent = "";
      refreshPreview(card);
    } catch (err) {
      card.querySelector("[data-err]").textContent = err.message;
    }
  }, 500);
});

function renderResults(r) {
  const items = r.scenarios.map((s) => ({ label: s.title, sublabel: s.archetype, value: s.probability, color: ARCH_COLOR[s.archetype] || "#6B7264" }));
  $("results").innerHTML = `
    <div class="card chart-block">
      <h4>Scenario probabilities</h4>
      <p class="caption mb-4">${r.n.toLocaleString()} sampled futures · seed ${r.seed} · ${r.duration_ms}ms${r.run_id ? ` · run #${r.run_id}` : ""}</p>
      <div id="probBars"></div>
      <p class="caption mt-4">${(r.residual * 100).toFixed(1)}% of sampled futures sit outside all published scenario conditions — the space the archetypes do not cover.</p>
    </div>
    <div class="card chart-block">
      <div class="flex-between mb-4">
        <h4>Driver sensitivity</h4>
        <select id="tornadoPick" aria-label="Scenario for sensitivity chart">${r.scenarios.map((s) => `<option value="${esc(s.slug)}">${esc(s.title)}</option>`).join("")}</select>
      </div>
      <p class="caption mb-4">How the scenario's probability shifts between the bottom and top third of each driver's sampled range.</p>
      <div id="tornadoChart"></div>
    </div>
    <div class="card chart-block">
      <h4>Sampled driver outcomes</h4>
      <table class="data"><thead><tr><th>Driver</th><th>P10</th><th>Median</th><th>Mean</th><th>P90</th></tr></thead>
        <tbody>${r.drivers.map((d) => `<tr><td>${esc(d.name)} <span class="caption">(${esc(d.unit)})</span></td><td>${d.p10}</td><td>${d.p50}</td><td>${d.mean}</td><td>${d.p90}</td></tr>`).join("")}</tbody></table>
    </div>`;
  probabilityBars($("probBars"), items);
  const drawTornado = () => tornado($("tornadoChart"), r.tornado[$("tornadoPick").value] || []);
  $("tornadoPick").addEventListener("change", drawTornado);
  drawTornado();
}

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  $("runErr").innerHTML = "";
  try {
    const body = { n: Number($("n").value) || 10000 };
    if ($("seed").value !== "") body.seed = Number($("seed").value);
    const r = await api("/api/simulation/run", { method: "POST", body });
    renderResults(r);
    loadHistory();
  } catch (e) {
    $("runErr").innerHTML = `<div class="error-note">${esc(e.message)}</div>`;
  }
  $("run").disabled = false;
});

async function loadHistory() {
  const j = await api("/api/simulation/runs");
  if (!j.runs.length) return;
  $("historyBlock").style.display = "";
  $("history").innerHTML = `<table class="data"><thead><tr><th>Run</th><th>When</th><th>Samples</th><th>Seed</th><th></th></tr></thead>
    <tbody>${j.runs.map((r) => `<tr><td>#${r.id}</td><td>${fmtDate(r.created_at)}</td><td>${r.n_samples.toLocaleString()}</td><td>${r.seed}</td>
      <td><button class="btn btn-secondary btn-sm" data-load="${r.id}">View</button></td></tr>`).join("")}</tbody></table>`;
  $("history").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-load]");
    if (!b) return;
    const r = await api("/api/simulation/runs/" + b.dataset.load);
    renderResults(r);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, { once: true });
}

renderNav("/simulation");
loadDrivers();
api("/api/simulation/latest").then((j) => { if (j.latest) renderResults(j.latest); });
loadHistory();
