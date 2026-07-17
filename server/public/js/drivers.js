// Drivers — the readable write-up of the current driver model. No inputs
// here: definitions are edited on /driver-config, ranges on /simulation.
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);

const DIST = { pert: "PERT", triangular: "Triangular", uniform: "Uniform", discrete: "Discrete" };

function entry(d, i, clusters) {
  const p = JSON.parse(d.params_json || "{}");
  const mine = JSON.parse(d.cluster_json || "[]");
  const evidence = mine.reduce((s, c) => s + (clusters.find((x) => x.v === c)?.n || 0), 0);
  const range = d.dist_type === "uniform"
    ? `${p.min} – ${p.max}`
    : `${p.min} – ${p.max}, most likely ${p.mode}`;
  return `<section class="card chart-block">
    <div class="flex-between" style="flex-wrap:wrap;gap:10px">
      <div>
        <span class="caption" style="font-family:var(--font-mono)">Driver ${i + 1} · ${esc(d.key)}${d.enabled ? "" : " · <strong>disabled</strong>"}</span>
        <h3 style="margin-top:6px">${esc(d.name)}</h3>
      </div>
      <div style="text-align:right">
        <span class="tag tag-mustard">${DIST[d.dist_type] || esc(d.dist_type)} · ${esc(range)}</span>
        ${d.unit ? `<div class="caption mt-2">${esc(d.unit)}</div>` : ""}
      </div>
    </div>
    <p class="mt-4" style="max-width:70ch">${esc(d.description)}</p>
    ${d.rationale ? `<p class="caption mt-2" style="max-width:75ch"><strong>Why this range:</strong> ${esc(d.rationale)}</p>` : ""}
    <p class="caption mt-4"><strong>Evidence</strong> — ${evidence} signals across ${mine.length} cluster${mine.length === 1 ? "" : "s"}:</p>
    <div class="mt-2" style="display:flex;gap:6px;flex-wrap:wrap">
      ${mine.map((c) => {
        const n = clusters.find((x) => x.v === c)?.n || 0;
        return `<a class="tag tag-olive" href="/signals?cluster=${encodeURIComponent(c)}" title="Open in the signal library">${esc(c)} · ${n}</a>`;
      }).join("") || `<span class="caption">No clusters grouped yet — assign them on the <a href="/driver-config">configure page</a>.</span>`}
    </div>
  </section>`;
}

async function load() {
  const [dj, fj] = await Promise.all([api("/api/drivers"), api("/api/signals/facets?status=approved")]);
  $("list").innerHTML = dj.drivers.map((d, i) => entry(d, i, fj.cluster)).join("");
}

renderNav("/drivers");
load();
