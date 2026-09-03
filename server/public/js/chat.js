import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";
import { sourceText, wireSourceText } from "./signal-text.js";

const $ = (id) => document.getElementById(id);
const messages = []; // client-side history, sent with each request

// Render assistant text: escape, then swap [S123] / [SC:slug] into pills.
function renderAssistant(text) {
  return esc(text)
    .replace(/\[S(\d+)\]/g, `<span class="cite-pill" data-sig="$1">S$1</span>`)
    .replace(/\[SC:([a-z0-9-]+)\]/g, `<span class="cite-pill" data-scenario="$1">$1</span>`)
    .replace(/^#{1,4} (.+)$/gm, "<strong>$1</strong>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function addMsg(role, html) {
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  div.innerHTML = html;
  $("thread").appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
  return div;
}

let scenarioBySlug = {};
api("/api/scenarios?status=published").then((j) => {
  scenarioBySlug = Object.fromEntries(j.scenarios.map((s) => [s.slug, s.id]));
});

async function send(text) {
  if (!text.trim()) return;
  $("input").value = "";
  $("send").disabled = true;
  $("chatErr").innerHTML = "";
  addMsg("user", esc(text));
  messages.push({ role: "user", content: text });
  const el = addMsg("assistant", `<span class="caption">consulting the signal library…</span>`);

  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `chat failed (${r.status})`);
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const ev of events) {
        const type = (ev.match(/^event: (.+)$/m) || [])[1];
        const data = (ev.match(/^data: (.+)$/m) || [])[1];
        if (!type || !data) continue;
        const j = JSON.parse(data);
        if (type === "sources") showSources(j);
        else if (type === "delta") { full += j.text; el.innerHTML = renderAssistant(full); }
        else if (type === "error") throw new Error(j.message);
      }
    }
    messages.push({ role: "assistant", content: full });
  } catch (e) {
    el.remove();
    messages.pop();
    $("chatErr").innerHTML = `<div class="error-note">${esc(e.message)}</div>`;
  }
  $("send").disabled = false;
  $("input").focus();
}

function showSources({ signals, scenarios }) {
  $("sourcesPanel").style.display = "";
  $("sourcesList").innerHTML =
    scenarios.map((s) => `<li><span class="cite-pill" data-scenario="${esc(s.slug)}">${esc(s.slug)}</span> ${esc(s.title)} <span class="caption">(${esc(s.archetype)})</span></li>`).join("") +
    signals.map((s) => `<li><span class="cite-pill" data-sig="${s.id}">S${s.id}</span> ${esc(s.title)} <span class="caption">${esc(s.cluster)}</span></li>`).join("");
}

document.addEventListener("click", async (e) => {
  const sig = e.target.closest("[data-sig]");
  if (sig) {
    const s = await api("/api/signals/" + sig.dataset.sig);
    $("drawer").innerHTML = `
      <button class="drawer-close" id="dclose" aria-label="Close">&times;</button>
      <span class="tag tag-olive">${esc(s.cluster)}</span>
      <h3 style="font-size:20px" class="mt-4">${esc(s.title)}</h3>
      <p class="mt-2">${esc(s.summary)}</p>
      <div class="citation mt-4">
        <div class="quote">${esc(s.source || "")} · ${s.year || s.date || ""}</div>
        <div class="source"><a href="${esc(s.url)}" target="_blank" rel="noopener">source link</a></div>
      </div>
      ${noteCard(s)}
      ${sourceText(s)}`;
    wireNoteCard($("drawer")); wireSourceText($("drawer"));
    document.body.classList.add("drawer-open");
    $("dclose").addEventListener("click", () => document.body.classList.remove("drawer-open"));
    return;
  }
  const sc = e.target.closest("[data-scenario]");
  if (sc && scenarioBySlug[sc.dataset.scenario]) location.href = "/scenario?id=" + scenarioBySlug[sc.dataset.scenario];
  const starter = e.target.closest(".starter");
  if (starter) send(starter.textContent);
});

$("form").addEventListener("submit", (e) => { e.preventDefault(); send($("input").value); });
$("backdrop").addEventListener("click", () => document.body.classList.remove("drawer-open"));

renderNav("/chat");
