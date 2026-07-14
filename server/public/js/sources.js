import { api, esc, fmtDate } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);

function row(s) {
  return `<tr data-id="${s.id}">
    <td><strong style="font-weight:600;color:var(--charcoal)">${esc(s.name)}</strong><br><a href="${esc(s.url)}" target="_blank" rel="noopener" class="caption">${esc(s.url)}</a></td>
    <td><select data-p="kind"><option ${s.kind === "scrape" ? "selected" : ""}>scrape</option><option ${s.kind === "crawl" ? "selected" : ""}>crawl</option></select></td>
    <td><input type="number" data-p="crawl_limit" value="${s.crawl_limit}" min="1" max="20" style="width:60px;padding:6px"></td>
    <td><label class="toggle"><input type="checkbox" data-p="enabled" ${s.enabled ? "checked" : ""}></label></td>
    <td class="caption">${s.last_run_at ? fmtDate(s.last_run_at) + "<br>" + esc(s.last_status || "") : "never run"}</td>
    <td><button class="btn-danger btn btn-sm" data-del>Remove</button></td>
  </tr>`;
}

async function load() {
  const [j, h] = await Promise.all([api("/api/sources"), api("/api/health")]);
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

renderNav("/sources");
load();
