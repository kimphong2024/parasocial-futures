// Activity — the audit log as a first-class page. Newest first; click a
// row for the full field diff, request body and provenance.
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

let entries = [];

function render() {
  $("activityBody").innerHTML = entries.length
    ? `<p class="caption mb-4">Newest first — showing the last ${entries.length}; the log keeps the most recent 5,000. Machine work (the nightly scan, classifiers) acts in-process and is recorded in its own run histories; this page is the human trail.</p>
       <table class="data"><thead><tr><th>When</th><th>Action</th><th>What changed</th></tr></thead>
       <tbody>${entries.map((a) => `
         <tr class="audit-row" data-aid="${a.id}" style="cursor:pointer">
           <td class="caption" style="white-space:nowrap">${when(a.at)}</td>
           <td><span class="tag ${a.status < 400 ? "tag-olive" : "tag-dim"}">${esc(a.action)}</span></td>
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
    <span class="tag tag-olive">${esc(a.action)}</span>
    <h3 class="mt-2" style="font-size:19px">${esc(a.summary)}</h3>
    <p class="caption mt-2">${esc(a.method)} ${esc(a.path)} · status ${a.status} · from ${esc(a.ip || "unknown")}<br>${esc(new Date(a.at).toLocaleString("en-GB"))}</p>
    ${detail.diff ? `<h4 class="mt-4">Field changes</h4>${Object.entries(detail.diff).map(([k, v]) => `
      <div class="citation mt-2"><div class="quote"><strong>${esc(k)}</strong><br><s style="opacity:0.6">${esc(String(v.from ?? "—"))}</s><br>${esc(String(v.to ?? "—"))}</div></div>`).join("")}` : ""}
    ${detail.body ? `<h4 class="mt-4">Request body</h4><p class="caption" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(detail.body)}</p>` : ""}`;
  document.body.classList.add("drawer-open");
  $("dclose").onclick = () => document.body.classList.remove("drawer-open");
});
$("backdrop").addEventListener("click", () => document.body.classList.remove("drawer-open"));

async function load() {
  entries = (await api("/api/audit?limit=200")).entries;
  render();
}

renderNav("/activity");
load();
setInterval(load, 30000);   // the record stays current while you watch
