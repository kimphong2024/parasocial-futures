import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";

const $ = (id) => document.getElementById(id);
const TYPES = ["discourse", "research", "market", "regulatory", "behavioral", "crisis/legal"];
const URGENCIES = ["critical", "high", "medium", "low"];
const HORIZONS = ["H1", "H2", "H3"];
let clusters = [];

// Queue state. The queue is paged and cluster-filterable because at 1352
// pending the old all-at-once render left only two options: read everything,
// or approve everything unread.
const state = { page: 1, limit: 40, cluster: "", total: 0, picked: new Set() };

const sel = (name, options, value) =>
  `<div><label class="field-label">${name}</label>
   <select data-field="${name === "type" ? "signal_type" : name}" style="width:100%">
     ${options.map((o) => `<option ${o === value ? "selected" : ""}>${esc(o)}</option>`).join("")}
   </select></div>`;

function pendingCard(s) {
  return `<div class="card review-card${state.picked.has(s.id) ? " picked" : ""}" data-id="${s.id}">
    <div class="flex-between">
      <label class="pick"><input type="checkbox" data-pick="${s.id}"${state.picked.has(s.id) ? " checked" : ""}> select</label>
      <span class="caption">${fmtDate(s.created_at)}</span>
    </div>
    <div class="flex-between mt-2">
      <span class="tag ${s.provenance === "scan:perplexity" ? "tag-blue" : "tag-brown"}">${esc((s.provenance || "").replace("scan:", ""))}</span>
      <span class="tag tag-dim">${esc(s.cluster || "unclustered")}</span>
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

// ---------------- the queue ----------------

function drawRail(facets) {
  const rows = (facets.cluster || []);
  const all = rows.reduce((n, c) => n + c.n, 0);
  $("clusterRail").innerHTML =
    `<div class="rail-head">Pending by cluster</div>` +
    `<button data-cluster="" class="${state.cluster === "" ? "active" : ""}">Everything <span class="n">${all}</span></button>` +
    rows.map((c) => `<button data-cluster="${esc(c.v)}" class="${state.cluster === c.v ? "active" : ""}">${esc(c.v)} <span class="n">${c.n}</span></button>`).join("");
}

function drawPager() {
  const pages = Math.max(1, Math.ceil(state.total / state.limit));
  if (state.total === 0) { $("queuePager").innerHTML = ""; return; }
  $("queuePager").innerHTML =
    `<button class="btn btn-sm btn-secondary" id="prevPage" ${state.page <= 1 ? "disabled" : ""}>Previous</button>
     <span class="caption">${state.total} pending${state.cluster ? ` in “${esc(state.cluster)}”` : ""} · page ${state.page} of ${pages}</span>
     <button class="btn btn-sm btn-secondary" id="nextPage" ${state.page >= pages ? "disabled" : ""}>Next</button>`;
}

function drawBatchBar() {
  const n = state.picked.size;
  $("batchCount").innerHTML = n ? `<strong>${n}</strong> selected` : "Nothing selected";
  $("batchApprove").disabled = !n;
  $("batchReject").disabled = !n;
  $("batchApprove").textContent = n ? `Approve ${n}` : "Approve";
  $("batchReject").textContent = n ? `Reject ${n}` : "Reject";
}

async function loadQueue() {
  const q = new URLSearchParams({ page: state.page, limit: state.limit });
  if (state.cluster) q.set("cluster", state.cluster);
  const queue = await api("/api/review/queue?" + q);
  state.total = queue.total;
  $("nSignals").textContent = `(${queue.total})`;
  $("nDrafts").textContent = `(${queue.scenario_drafts.length})`;
  drawRail(queue.facets);
  $("queueCards").innerHTML = queue.signals.length
    ? queue.signals.map(pendingCard).join("")
    : `<div class="empty-note">No scan hits waiting${state.cluster ? ` in “${esc(state.cluster)}”` : ""}. Run a scan, or rest easy — the library is current.</div>`;
  $("queueCards").querySelectorAll(".review-card").forEach(wireNoteCard);
  $("tab-drafts").innerHTML = queue.scenario_drafts.length
    ? queue.scenario_drafts.map(draftCard).join("")
    : `<div class="empty-note">No scenario drafts waiting. Draft one from the Scenarios page.</div>`;
  drawPager();
  drawBatchBar();
}

async function load() {
  const facets = await api("/api/signals/facets?status=all");
  clusters = facets.cluster.map((c) => c.v);
  document.body.insertAdjacentHTML("beforeend",
    `<datalist id="clusterList">${clusters.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>`);

  await loadQueue();

  const runs = await api("/api/scan/runs");
  $("tab-runs").innerHTML = runs.runs.length
    ? `<table class="data"><thead><tr><th>Run</th><th>Trigger</th><th>Status</th><th>Candidates</th><th>New pending</th><th>Duplicates</th><th>Off-topic</th><th>Finished</th></tr></thead>
       <tbody>${runs.runs.map(runRow).join("")}</tbody></table>`
    : `<div class="empty-note">No scan runs yet.</div>`;
}

// ---------------- groups (embedding clustering) ----------------

function groupCard(g) {
  return `<div class="card review-card group-card" data-group="${esc(g.id)}">
    <div class="flex-between">
      <span class="tag tag-olive">${g.size} signal${g.size === 1 ? "" : "s"}</span>
      <span class="caption cohesion">cohesion ${g.cohesion}</span>
    </div>
    <h4 class="mt-2">${esc(g.label)}</h4>
    <p class="caption mt-2">${esc(g.rationale || "")}</p>
    <ul class="group-members">
      ${g.members.slice(0, 8).map((m) => `<li>${esc(m.title)}</li>`).join("")}
      ${g.size > 8 ? `<li class="caption">…and ${g.size - 8} more</li>` : ""}
    </ul>
    <div class="review-actions">
      <button class="btn btn-sm" data-group-act="approve">Approve all ${g.size}</button>
      <button class="btn btn-danger btn-sm" data-group-act="reject">Reject all ${g.size}</button>
      <span class="caption" data-status></span>
    </div>
  </div>`;
}

let groupsLoaded = false;
async function loadGroups(force) {
  if (groupsLoaded && !force) return;
  $("tab-groups").innerHTML = `<div class="empty-note">Grouping the queue by meaning — this reads every pending embedding and may take a moment.</div>`;
  try {
    const r = await api("/api/review/groups");
    groupsLoaded = true;
    $("nGroups").textContent = `(${r.groups.length})`;
    $("tab-groups").innerHTML = r.groups.length
      ? `<p class="caption mb-4">${r.groups.length} groups over ${r.grouped} pending signals, plus ${r.singletons} that resemble nothing else in the queue. Singletons are left alone — they are the ones worth reading individually.</p>`
        + r.groups.map(groupCard).join("")
      : `<div class="empty-note">Nothing in the queue clusters at the current threshold.</div>`;
  } catch (e) {
    $("tab-groups").innerHTML = `<div class="error-note">${esc(e.message)}</div>`;
  }
}

// ---------------- wiring ----------------

const TABS = ["signals", "groups", "drafts", "runs"];
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    TABS.forEach((k) => $("tab-" + k).style.display = t.dataset.tab === k ? "" : "none");
    if (t.dataset.tab === "groups") loadGroups(false);
  }));

// Cluster rail
$("clusterRail").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cluster]");
  if (!b) return;
  state.cluster = b.dataset.cluster;
  state.page = 1;
  state.picked.clear();
  $("pickPage").checked = false;
  loadQueue();
});

// Pagination
$("queuePager").addEventListener("click", (e) => {
  if (e.target.id === "prevPage") state.page--;
  else if (e.target.id === "nextPage") state.page++;
  else return;
  $("pickPage").checked = false;
  loadQueue().then(() => window.scrollTo({ top: 0, behavior: "instant" }));
});

// Selection
$("queueCards").addEventListener("change", (e) => {
  const cb = e.target.closest("[data-pick]");
  if (!cb) return;
  const id = +cb.dataset.pick;
  cb.checked ? state.picked.add(id) : state.picked.delete(id);
  cb.closest(".review-card").classList.toggle("picked", cb.checked);
  drawBatchBar();
});

$("pickPage").addEventListener("change", () => {
  const on = $("pickPage").checked;
  $("queueCards").querySelectorAll("[data-pick]").forEach((cb) => {
    cb.checked = on;
    const id = +cb.dataset.pick;
    on ? state.picked.add(id) : state.picked.delete(id);
    cb.closest(".review-card").classList.toggle("picked", on);
  });
  drawBatchBar();
});

// "Select all in filter" reaches past the current page — the whole point of
// cluster triage is deciding about a cluster, not about a page of one.
$("pickCluster").addEventListener("click", async () => {
  const q = new URLSearchParams({ page: 1, limit: 200 });
  if (state.cluster) q.set("cluster", state.cluster);
  const all = await api("/api/review/queue?" + q);
  all.signals.forEach((s) => state.picked.add(s.id));
  $("queueCards").querySelectorAll("[data-pick]").forEach((cb) => {
    cb.checked = state.picked.has(+cb.dataset.pick);
    cb.closest(".review-card").classList.toggle("picked", cb.checked);
  });
  drawBatchBar();
  if (all.total > all.signals.length) {
    $("batchCount").innerHTML += ` <span class="caption">(capped at ${all.signals.length} of ${all.total})</span>`;
  }
});

async function runBatch(action) {
  const ids = [...state.picked];
  if (!ids.length) return;
  const basis = state.cluster || "selection";
  const verb = action === "approve" ? "Approve" : "Reject";
  if (!confirm(`${verb} ${ids.length} pending signal${ids.length === 1 ? "" : "s"} as one decision${state.cluster ? ` on the “${state.cluster}” cluster` : ""}?`)) return;
  $("batchApprove").disabled = $("batchReject").disabled = true;
  try {
    await api("/api/review/batch", { method: "POST", body: { ids, action, basis } });
    state.picked.clear();
    $("pickPage").checked = false;
    groupsLoaded = false;
    await loadQueue();
  } catch (e) {
    $("queueCards").insertAdjacentHTML("afterbegin", `<div class="error-note">${esc(e.message)}</div>`);
    drawBatchBar();
  }
}
$("batchApprove").addEventListener("click", () => runBatch("approve"));
$("batchReject").addEventListener("click", () => runBatch("reject"));

// Per-card approve/reject — unchanged; batch is an addition, not a replacement.
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
  state.picked.delete(+id);
  groupsLoaded = false;
  drawBatchBar();
  card.style.opacity = "0.45";
  card.querySelectorAll("button, input, select, textarea").forEach((el) => el.disabled = true);
});

// Whole-group decisions run through the same batch endpoint, so the audit
// trail records the group as the basis.
$("tab-groups").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-group-act]");
  if (!btn) return;
  const card = btn.closest(".group-card");
  const label = card.querySelector("h4").textContent;
  const action = btn.dataset.groupAct;
  const r = await api("/api/review/groups");
  const g = r.groups.find((x) => String(x.id) === card.dataset.group);
  if (!g) return;
  if (!confirm(`${action === "approve" ? "Approve" : "Reject"} all ${g.size} signals in “${label}” as one decision?`)) return;
  card.querySelector("[data-status]").textContent = "working…";
  await api("/api/review/batch", { method: "POST", body: { ids: g.member_ids, action, basis: label } });
  card.querySelector("[data-status]").textContent = action === "approve" ? "approved" : "rejected";
  card.style.opacity = "0.45";
  card.querySelectorAll("button").forEach((el) => el.disabled = true);
  loadQueue();
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
    $("queueCards").insertAdjacentHTML("afterbegin", `<div class="error-note">${esc(err.message)}</div>`);
  }
});

renderNav("/review");
document.getElementById("backdrop")?.addEventListener("click", () => document.body.classList.remove("drawer-open"));
load();
