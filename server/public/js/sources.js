import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);

function row(s) {
  return `<tr data-id="${s.id}">
    <td><strong style="font-weight:600;color:var(--charcoal)">${esc(s.name)}</strong><br><a href="${esc(s.url)}" target="_blank" rel="noopener" class="caption">${esc(s.url)}</a></td>
    <td><select data-p="kind" aria-label="Fetch mode for ${esc(s.url)}"><option ${s.kind === "scrape" ? "selected" : ""}>scrape</option><option ${s.kind === "crawl" ? "selected" : ""}>crawl</option></select></td>
    <td><input type="number" data-p="crawl_limit" value="${s.crawl_limit}" aria-label="Crawl page limit" min="1" max="20" style="width:60px;padding:6px"></td>
    <td><label class="toggle"><input type="checkbox" data-p="enabled" ${s.enabled ? "checked" : ""} aria-label="Source enabled"></label></td>
    <td class="caption">${s.last_run_at ? fmtDate(s.last_run_at) + "<br>" + esc(s.last_status || "") : "never run"}</td>
    <td><button class="btn-danger btn btn-sm" data-del>Remove</button></td>
  </tr>`;
}

function themeRow(t) {
  return `<tr data-tid="${t.id}">
    <td class="caption" style="white-space:nowrap">${esc(t.key)}</td>
    <td><textarea data-p="query" rows="3" aria-label="Theme query: ${esc(t.name)}" style="width:100%;font-size:13px;line-height:1.5;resize:vertical">${esc(t.query)}</textarea></td>
    <td><label class="toggle"><input type="checkbox" data-p="enabled" ${t.enabled ? "checked" : ""} aria-label="Theme enabled"></label></td>
    <td><button class="btn-danger btn btn-sm" data-tdel>Remove</button></td>
  </tr>`;
}

let gateDefault = "";
function paintSettings(s) {
  $("setRecency").value = s.recency;
  $("setFollow").value = s.follow_limit;
  $("setDedup").value = s.dedup_threshold;
  $("setGate").value = s.relevance_gate;
  gateDefault = s.gate_default ?? gateDefault;
  $("gateModified").style.display = s.relevance_gate === gateDefault ? "none" : "";
  const sch = s.schedule;
  if (sch) $("scheduleLine").textContent = sch.enabled
    ? `Nightly scan at ${sch.hour}:00 ${sch.tz}${sch.next_run_at ? ` · next run ${new Date(sch.next_run_at).toLocaleString()}` : ""}`
    : "Automatic scanning is off in this environment — scans run manually from the Review page.";
}

async function load() {
  const [j, h, t, s] = await Promise.all([api("/api/sources"), api("/api/health"), api("/api/themes"), api("/api/scan/settings")]);
  paintSettings(s);
  $("themeList").innerHTML = t.themes.length
    ? `<table class="data"><thead><tr><th>Key</th><th>Query</th><th>On</th><th></th></tr></thead><tbody>${t.themes.map(themeRow).join("")}</tbody></table>`
    : `<div class="empty-note">No themes — the shipped defaults will be used until you add one.</div>`;
  const dot = (on) => `<span class="urgency-dot ${on ? "urgency-medium" : "urgency-critical"}" style="background:${on ? "var(--olive)" : "var(--urgentRed)"}"></span>`;
  $("integrations").innerHTML = `
    <div class="card stat-tile"><p>${dot(h.integrations.perplexity)} Perplexity — undirected sweep</p><p class="caption mt-2">${h.integrations.perplexity ? "key configured" : "PERPLEXITY_API_KEY not set"}</p></div>
    <div class="card stat-tile"><p>${dot(h.integrations.firecrawl)} Firecrawl — directed crawls</p><p class="caption mt-2">${h.integrations.firecrawl ? "key configured" : "FIRECRAWL_API_KEY not set"}</p></div>
    <div class="card stat-tile"><p>${dot(h.integrations.llm)} Claude — classification, drafting, chat</p><p class="caption mt-2">${h.integrations.llm ? "key configured" : "ANTHROPIC_API_KEY not set"}</p></div>
    <div class="card stat-tile"><p>${dot(h.integrations.voyage)} Voyage — embeddings, dedup, retrieval</p><p class="caption mt-2">${h.integrations.voyage ? `${h.embedded} signals embedded` : "VOYAGE_API_KEY not set"}</p></div>`;
  $("list").innerHTML = j.sources.length
    ? `<table class="data"><thead><tr><th>Source</th><th>Kind</th><th>Limit</th><th>On</th><th>Last run</th><th></th></tr></thead><tbody>${j.sources.map(row).join("")}</tbody></table>`
    : `<div class="empty-note">No sources configured.</div>`;
}

$("add").addEventListener("click", async () => {
  $("addErr").innerHTML = "";
  try {
    await api("/api/sources", { method: "POST", body: { name: $("newName").value.trim(), url: $("newUrl").value.trim(), kind: $("newKind").value, crawl_limit: Number($("newLimit").value) } });
    $("newName").value = ""; $("newUrl").value = "";
    load();
  } catch (e) {
    $("addErr").innerHTML = `<div class="error-note">${esc(e.message)}</div>`;
  }
});

$("list").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (!tr) return;
  await api("/api/sources/" + tr.dataset.id, { method: "PATCH", body: {
    kind: tr.querySelector('[data-p="kind"]').value,
    crawl_limit: Number(tr.querySelector('[data-p="crawl_limit"]').value),
    enabled: tr.querySelector('[data-p="enabled"]').checked,
  }});
});

$("list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del]");
  if (!btn) return;
  const tr = btn.closest("tr[data-id]");
  await api("/api/sources/" + tr.dataset.id, { method: "DELETE" });
  tr.remove();
});

// ---- scan settings ----
$("saveSettings").addEventListener("click", async () => {
  $("settingsMsg").textContent = "";
  try {
    const s = await api("/api/scan/settings", { method: "PUT", body: {
      recency: $("setRecency").value,
      follow_limit: Number($("setFollow").value),
      dedup_threshold: Number($("setDedup").value),
      relevance_gate: $("setGate").value,
    }});
    paintSettings({ ...s, gate_default: gateDefault });
    $("settingsMsg").textContent = "Saved — applies to the next run.";
  } catch (e) {
    $("settingsMsg").textContent = e.message;
  }
});
$("resetGate").addEventListener("click", () => {
  $("setGate").value = gateDefault;
  $("gateModified").style.display = "none";
});
$("setGate").addEventListener("input", () => {
  $("gateModified").style.display = $("setGate").value === gateDefault ? "none" : "";
});

// ---- sweep themes ----
$("addTheme").addEventListener("click", async () => {
  $("themeErr").innerHTML = "";
  try {
    await api("/api/themes", { method: "POST", body: { key: $("newThemeKey").value.trim(), query: $("newThemeQuery").value.trim() } });
    $("newThemeKey").value = ""; $("newThemeQuery").value = "";
    load();
  } catch (e) {
    $("themeErr").innerHTML = `<div class="error-note">${esc(e.message)}</div>`;
  }
});
$("themeList").addEventListener("change", async (e) => {
  const tr = e.target.closest("tr[data-tid]");
  if (!tr) return;
  await api("/api/themes/" + tr.dataset.tid, { method: "PATCH", body: {
    query: tr.querySelector('[data-p="query"]').value,
    enabled: tr.querySelector('[data-p="enabled"]').checked,
  }});
});
$("themeList").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-tdel]");
  if (!btn) return;
  const tr = btn.closest("tr[data-tid]");
  await api("/api/themes/" + tr.dataset.tid, { method: "DELETE" });
  tr.remove();
});

// ---- horizon audit ----
$("judgeHorizons").addEventListener("click", async () => {
  $("horizonMsg").textContent = "";
  try {
    await api("/api/horizons/judge", { method: "POST" });
    $("judgeHorizons").disabled = true;
    const poll = setInterval(async () => {
      const s = await api("/api/horizons/status");
      $("horizonMsg").textContent = s.running
        ? `Judging… ${s.done}/${s.total} (${s.changed} re-assigned)`
        : `Done — ${s.done} judged, ${s.changed} horizons re-assigned${s.errors ? `, ${s.errors} batch errors` : ""}.`;
      if (!s.running) { clearInterval(poll); $("judgeHorizons").disabled = false; }
    }, 3000);
  } catch (e) {
    $("horizonMsg").textContent = e.message;
  }
});

renderNav("/sources");
load();
