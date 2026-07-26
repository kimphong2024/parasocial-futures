import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";

const $ = (id) => document.getElementById(id);
const TYPES = ["discourse", "research", "market", "regulatory", "behavioral", "crisis/legal"];
const URGENCIES = ["critical", "high", "medium", "low"];
const HORIZONS = ["H1", "H2", "H3"];
let clusters = [];

const sel = (name, options, value) =>
  `<div><label class="field-label">${name}</label>
   <select data-field="${name === "type" ? "signal_type" : name}" style="width:100%">
     ${options.map((o) => `<option ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}
   </select></div>`;

function pendingCard(s) {
  return `<div class="card review-card" data-id="${s.id}">
    <div class="flex-between">
      <span class="tag ${s.provenance === "scan:perplexity" ? "tag-blue" : "tag-brown"}">${esc(s.provenance.replace("scan:", ""))}</span>
      <span class="caption">${fmtDate(s.created_at)}</span>
    </div>
    <h4 class="mt-2">${esc(s.title)}</h4>
    <textarea data-field="summary" rows="2" class="mt-2">${esc(s.summary)}</textarea>
    <div class="edit-row">
      <div><label class="field-label">cluster</label>
        <input data-field="cluster" list="clusterList" value="${esc(s.cluster)}" style="width:100%"></div>
      ${sel("type", TYPES, s.signal_type)}
      ${sel("urgency", URGENCIES, s.urgency)}
      ${sel("horizon", HORIZONS, s.horizon)}
    </div>
    <div class="citation">
      <div class="quote"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>
      <div class="source">${esc(s.source || "unknown source")}</div>
    </div>
    ${s.nearest ? `<p class="caption mt-2">Nearest existing signal (cosine ${s.nearest.score}): &ldquo;${esc(s.nearest.title)}&rdquo; — approve only if this adds something new.</p>` : ""}
    ${noteCard(s)}
    <div class="review-actions">
      <button class="btn btn-sm" data-act="approve">Approve</button>
      <button class="btn-danger btn btn-sm" data-act="reject">Reject</button>
      <span class="caption" data-status></span>
    </div>
  </div>`;
}

function draftCard(sc) {
  return `<div class="card review-card">
    <div class="flex-between">
      <span class="tag tag-mustard">${esc(sc.archetype)}</span>
      <span class="status-chip status-draft">draft</span>
    </div>
    <h4 class="mt-2">${esc(sc.title)}</h4>
    <p class="mt-2">${esc(sc.summary)}</p>
    <div class="review-actions">
      <a class="btn btn-secondary btn-sm" href="/scenario?id=${sc.id}">Open, edit and publish</a>
    </div>
  </div>`;
}

function runRow(r) {
  const errs = JSON.parse(r.errors_json || "[]");
  return `<tr data-run="${r.id}" style="cursor:pointer" title="Click for the full breakdown">
    <td>▸ #${r.id}</td><td>${esc(r.trigger)}</td>
    <td>${esc(r.status)}${errs.length ? ` <span class="tag tag-red">${errs.length} errors</span>` : ""}</td>
    <td>${r.perplexity_candidates + r.firecrawl_candidates}</td>
    <td>${r.new_pending}</td>
    <td>${r.dup_url + r.dup_embedding}</td>
    <td>${r.rejected_relevance ?? 0}</td>
    <td>${fmtDate(r.finished_at || r.started_at)}</td>
  </tr>`;
}

// Expandable per-run breakdown: what each theme and source yielded, what the
// gate rejected, and the exact settings + gate text the run actually used.
function runDetail(r) {
  const d = JSON.parse(r.detail_json || "{}");
  const errs = JSON.parse(r.errors_json || "[]");
  const val = (v) => (v === "error" ? -1 : Number(v) || 0);
  const chips = (obj, tag) => Object.entries(obj || {})
    .sort((a, b) => val(b[1]) - val(a[1]))
    .map(([k, v]) => `<span class="tag ${v === "error" ? "tag-red" : val(v) > 0 ? tag : "tag-dim"}">${esc(k)} · ${esc(String(v))}</span>`)
    .join(" ") || `<span class="caption">no data recorded</span>`;
  const rejected = (d.rejected || []).map((x) =>
    `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.source ? ` <span class="caption">— ${esc(x.source)}</span>` : ""}</li>`).join("");
  const s = d.settings;
  return `<tr class="run-detail"><td colspan="8" style="padding:16px 22px">
    ${s ? `<p class="caption">Ran with: ${esc(s.recency)} window · follow-through ${s.follow_limit}/source · duplicate threshold ${s.dedup_threshold}${d.gate_modified ? ` · <span class="tag tag-mustard">modified gate</span>` : ""}</p>` : `<p class="caption">This run predates per-run detail recording.</p>`}
    ${d.themes ? `<p class="caption mt-2"><strong>Sweep themes</strong> (candidates found)</p><p class="mt-2">${chips(d.themes, "tag-olive")}</p>` : ""}
    ${d.sources ? `<p class="caption mt-2"><strong>Sources</strong> (signals extracted)</p><p class="mt-2">${chips(d.sources, "tag-blue")}</p>` : ""}
    ${rejected ? `<details class="mt-2"><summary class="caption">Rejected as off-topic by the relevance gate (${d.rejected.length}) — audit the gate's judgment</summary><ul class="mt-2">${rejected}</ul></details>` : ""}
    ${d.gate ? `<details class="mt-2"><summary class="caption">Relevance gate text this run used${d.gate_modified ? " (modified from default)" : " (default)"}</summary><p class="caption mt-2" style="white-space:pre-wrap">${esc(d.gate)}</p></details>` : ""}
    ${errs.length ? `<p class="caption mt-2"><strong>Errors</strong></p><ul class="mt-2">${errs.map((e) => `<li class="caption">${esc(e.step)}${e.source ? ":" + esc(e.source) : ""} — ${esc(e.message)}</li>`).join("")}</ul>` : ""}
  </td></tr>`;
}

async function load() {
  const [queue, facets] = await Promise.all([api("/api/review/queue"), api("/api/signals/facets?status=all")]);
  clusters = facets.cluster.map((c) => c.v);
  document.body.insertAdjacentHTML("beforeend",
    `<datalist id="clusterList">${clusters.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>`);

  $("nSignals").textContent = `(${queue.signals.length})`;
  $("nDrafts").textContent = `(${queue.scenario_drafts.length})`;
  $("tab-signals").innerHTML = queue.signals.length
    ? queue.signals.map(pendingCard).join("")
    : `<div class="empty-note">No scan hits waiting. Run a scan, or rest easy — the library is current.</div>`;
  $("tab-signals").querySelectorAll(".review-card").forEach(wireNoteCard);
  $("tab-drafts").innerHTML = queue.scenario_drafts.length
    ? queue.scenario_drafts.map(draftCard).join("")
    : `<div class="empty-note">No scenario drafts waiting. Draft one from the Scenarios page.</div>`;

  const runs = await api("/api/scan/runs");
  $("tab-runs").innerHTML = runs.runs.length
    ? `<table class="data"><thead><tr><th>Run</th><th>Trigger</th><th>Status</th><th>Candidates</th><th>New pending</th><th>Duplicates</th><th>Off-topic</th><th>Finished</th></tr></thead>
       <tbody>${runs.runs.map(runRow).join("")}</tbody></table>`
    : `<div class="empty-note">No scan runs yet.</div>`;
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    ["signals", "drafts", "runs"].forEach((k) => $("tab-" + k).style.display = t.dataset.tab === k ? "" : "none");
  }));

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const card = btn.closest(".review-card");
  const id = card.dataset.id;
  const status = card.querySelector("[data-status]");
  if (btn.dataset.act === "approve") {
    // Persist any edits made in the card before approving.
    const patch = {};
    card.querySelectorAll("[data-field]").forEach((el) => patch[el.dataset.field] = el.value);
    await api(`/api/review/signals/${id}`, { method: "PATCH", body: patch });
    await api(`/api/review/signals/${id}/approve`, { method: "POST" });
    status.textContent = "approved";
  } else {
    await api(`/api/review/signals/${id}/reject`, { method: "POST" });
    status.textContent = "rejected";
  }
  card.style.opacity = "0.45";
  card.querySelectorAll("button, input, select, textarea").forEach((el) => el.disabled = true);
});

// Run-row drill-down: click toggles the breakdown row beneath.
$("tab-runs").addEventListener("click", async (e) => {
  const tr = e.target.closest("tr[data-run]");
  if (!tr || e.target.closest("a")) return;
  const open = tr.nextElementSibling?.classList.contains("run-detail");
  if (open) { tr.nextElementSibling.remove(); tr.firstElementChild.textContent = `▸ #${tr.dataset.run}`; return; }
  const r = await api("/api/scan/runs/" + tr.dataset.run);
  tr.insertAdjacentHTML("afterend", runDetail(r));
  tr.firstElementChild.textContent = `▾ #${tr.dataset.run}`;
});

$("approveAll").addEventListener("click", async () => {
  if (!confirm("Approve every pending scan hit into the library?")) return;
  const r = await api("/api/review/approve-all", { method: "POST" });
  alert(`Approved ${r.approved} signals into the library.`);
  location.reload();
});

$("runScan").addEventListener("click", async () => {
  $("runScan").disabled = true;
  $("runScan").textContent = "Scanning…";
  try {
    await api("/api/scan/run", { method: "POST" });
    // Poll until the run finishes, showing the live pipeline step meanwhile.
    const poll = setInterval(async () => {
      const h = await api("/api/health");
      if (!h.scanRunning) {
        clearInterval(poll);
        $("runScan").disabled = false;
        $("runScan").textContent = "Run scan now";
        location.reload();
      } else {
        $("runScan").textContent = h.scanStep ? `Scanning: ${h.scanStep}…` : "Scanning…";
      }
    }, 4000);
  } catch (err) {
    $("runScan").disabled = false;
    $("runScan").textContent = "Run scan now";
    $("tab-signals").insertAdjacentHTML("afterbegin", `<div class="error-note">${esc(err.message)}</div>`);
  }
});

renderNav("/review");
load();
