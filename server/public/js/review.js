import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";

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
  return `<tr>
    <td>#${r.id}</td><td>${esc(r.trigger)}</td>
    <td>${esc(r.status)}${errs.length ? ` <span class="tag tag-red" title="${esc(errs.map((e) => `${e.step}${e.source ? ":" + e.source : ""} — ${e.message}`).join("\n"))}">${errs.length} errors</span>` : ""}</td>
    <td>${r.perplexity_candidates + r.firecrawl_candidates}</td>
    <td>${r.new_pending}</td>
    <td>${r.dup_url + r.dup_embedding}</td>
    <td>${fmtDate(r.finished_at || r.started_at)}</td>
  </tr>`;
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
  $("tab-drafts").innerHTML = queue.scenario_drafts.length
    ? queue.scenario_drafts.map(draftCard).join("")
    : `<div class="empty-note">No scenario drafts waiting. Draft one from the Scenarios page.</div>`;

  const runs = await api("/api/scan/runs");
  $("tab-runs").innerHTML = runs.runs.length
    ? `<table class="data"><thead><tr><th>Run</th><th>Trigger</th><th>Status</th><th>Candidates</th><th>New pending</th><th>Duplicates</th><th>Finished</th></tr></thead>
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

$("runScan").addEventListener("click", async () => {
  $("runScan").disabled = true;
  $("runScan").textContent = "Scanning…";
  try {
    await api("/api/scan/run", { method: "POST" });
    // Poll until the run finishes, then refresh the queue.
    const poll = setInterval(async () => {
      const h = await api("/api/health");
      if (!h.scanRunning) {
        clearInterval(poll);
        $("runScan").disabled = false;
        $("runScan").textContent = "Run scan now";
        location.reload();
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
