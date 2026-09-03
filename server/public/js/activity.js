// Activity — the audit log as a first-class page. Newest first; click a
// row for the full field diff, request body and provenance.
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const whenLong = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

// action codes -> plain words
const ACTION_LABELS = {
  "quotes.drain": "Source text", "quotes.backfill": "Source text", "report.author": "Report authored",
  "report.revert": "Report reverted", "report.critique": "Report critique", "report.keep-mine": "Report kept",
  "report.regenerate": "Report redrafted",
  "signal.note": "Field note", "triangle.reclassify": "Triangle move", "triangle.classify-all": "Triangle re-audit",
  "triangle.writeup": "Synthesis refresh", "review.approve": "Approval", "review.reject": "Rejection",
  "review.edit": "Review edit", "review.approve-all": "Bulk approval", "horizons.judge": "Horizon audit",
  "scan.trigger": "Manual scan", "scan.run-delete": "Run record removed", "scan.settings": "Scan settings",
  "source.add": "Source added", "source.edit": "Source edited", "source.delete": "Source removed",
  "theme.add": "Theme added", "theme.edit": "Theme edited", "theme.delete": "Theme removed",
  "scenario.draft": "Scenario drafted", "scenario.edit": "Scenario edited", "scenario.publish": "Scenario published",
  "scenario.archive": "Scenario archived", "scenario.restore": "Scenario restored",
  "driver.add": "Driver added", "driver.edit": "Driver edited", "driver.delete": "Driver removed",
  "simulation.run": "Simulation run",
};
const actionLabel = (a) => ACTION_LABELS[a] || a.replace(/\./g, " ");

// field names -> plain words
const FIELD_LABELS = {
  note: "Field note", triangle: "Force", triangle_reasoning: "Why it sits there", cluster: "Cluster",
  signal_type: "Signal type", urgency: "Urgency", horizon: "Horizon", horizon_reasoning: "Horizon reasoning",
  title: "Title", summary: "Summary", status: "Status", litany: "Litany layer", systemic: "Systemic layer",
  worldview: "Worldview layer", myth: "Myth layer", narrative: "Narrative", driver_conditions: "Driver conditions",
  signal_ids: "Cited signals", params_json: "Distribution parameters", dist_type: "Distribution shape",
  rationale: "Rationale", cluster_json: "Evidence clusters", enabled: "Enabled", url: "Address",
  query: "Query text", name: "Name", crawl_limit: "Crawl limit", kind: "Fetch mode",
};
const fieldLabel = (k) => FIELD_LABELS[k] || k.replace(/_/g, " ");
const showVal = (v) => {
  const x = (v === null || v === undefined || String(v).trim() === "") ? "" : String(v);
  return x ? esc(x) : "<em>empty</em>";
};

let entries = [];

function render() {
  $("activityBody").innerHTML = entries.length
    ? `<p class="caption mb-4">Newest first — showing the last ${entries.length}; the log keeps the most recent 5,000. Machine work the platform does on its own — the source-text fetcher above, and the nightly scan's own run history — is recorded here too.</p>
       <table class="data"><thead><tr><th>When</th><th>Action</th><th>What changed</th></tr></thead>
       <tbody>${entries.map((a) => `
         <tr class="audit-row" data-aid="${a.id}" style="cursor:pointer">
           <td class="caption" style="white-space:nowrap">${when(a.at)}</td>
           <td><span class="tag ${a.status < 400 ? "tag-olive" : "tag-dim"}" title="${esc(a.action)}">${esc(actionLabel(a.action))}</span></td>
           <td style="font-size:12.5px">${esc(a.summary)}</td>
         </tr>`).join("")}</tbody></table>`
    : `<div class="empty-note">No changes recorded yet — approvals, edits, moves and publishes will appear here as they happen.</div>`;
}

$("activityBody").addEventListener("click", (e) => {
  const r = e.target.closest(".audit-row");
  if (!r) return;
  const a = entries.find((x) => x.id === Number(r.dataset.aid));
  let detail = {};
  try { detail = JSON.parse(a.detail_json); } catch {}
  $("drawer").innerHTML = `
    <button class="drawer-close" id="dclose" aria-label="Close">&times;</button>
    <span class="tag ${a.status < 400 ? "tag-olive" : "tag-dim"}">${esc(actionLabel(a.action))}</span>
    <h3 class="mt-2" style="font-size:19px;line-height:1.4">${esc(a.summary)}</h3>
    <p class="caption mt-2">${esc(whenLong(a.at))} · by a visitor at ${esc(a.ip || "an unknown address")}${a.status >= 400 ? " · <strong>this attempt did not go through</strong>" : ""}</p>
    ${detail.diff ? `<h4 class="mt-4">What changed</h4>${Object.entries(detail.diff).map(([k, v]) => `
      <div class="citation mt-2"><div class="quote">
        <strong>${esc(fieldLabel(k))}</strong><br>
        <span class="caption">Before:</span> <s style="opacity:0.65">${showVal(v.from)}</s><br>
        <span class="caption">Now:</span> ${showVal(v.to)}
      </div></div>`).join("")}` : `<p class="caption mt-4">Nothing was altered by this action${a.status < 400 ? " — it started a process or repeated an existing state." : "."}</p>`}
    <details class="mt-4">
      <summary class="caption" style="cursor:pointer">Technical detail</summary>
      <p class="caption mt-2" style="font-family:var(--font-mono);overflow-wrap:anywhere">${esc(a.method)} ${esc(a.path)} · status ${a.status} · action ${esc(a.action)}${detail.body ? `<br>body: ${esc(detail.body)}` : ""}</p>
    </details>`;
  document.body.classList.add("drawer-open");
  $("dclose").onclick = () => document.body.classList.remove("drawer-open");
});
$("backdrop").addEventListener("click", () => document.body.classList.remove("drawer-open"));

// The source-text corpus fills itself in the background with nothing to press,
// so the only honest thing to do is say where it has got to.
async function renderCorpus() {
  try {
    const c = await api("/api/quotes/coverage");
    const s = c.status || {};
    const pct = c.total ? Math.round((c.retained / c.total) * 100) : 0;
    const running = !!s.running;
    $("corpusStrip").hidden = false;
    $("corpusStrip").innerHTML = `
      <div class="corpus-bar"><span style="width:${pct}%"></span></div>
      <p class="corpus-line">
        <strong>${c.retained}</strong> of ${c.total} signals have retained source text (${pct}%) ·
        ${c.missing ? `${c.missing} still to fetch` : "complete"}
        ${running
          ? ` · <span class="corpus-live">fetching now — ${s.done ?? 0}/${s.target ?? 0} this batch, ${s.stored ?? 0} kept</span>`
          : c.missing ? " · next batch within ten minutes" : ""}
      </p>`;
  } catch { $("corpusStrip").hidden = true; }
}

async function load() {
  entries = (await api("/api/audit?limit=200")).entries;
  render();
  renderCorpus();
}

renderNav("/activity");
load();
setInterval(load, 30000);   // the record stays current while you watch
setInterval(renderCorpus, 8000);   // the corpus moves faster than the log
