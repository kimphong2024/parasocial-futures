import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";
import { probabilityBars, tornado, ARCH_COLOR } from "./charts.js";

const $ = (id) => document.getElementById(id);

// Section order is the argument's order: what the evidence is, how it reads,
// where the futures fork, what the odds are, what moves them, what would
// break the reading, and what follows.
const SECTIONS = [
  ["state_of_evidence", "The state of the evidence"],
  ["triangle_reading", "The triangle reading"],
  ["scenario_space", "The scenario space"],
  ["odds", "The odds"],
  ["sensitivity", "What moves them"],
  ["what_would_change_our_mind", "What would change our mind"],
  ["so_what", "So what"],
];

const INPUT_LABEL = {
  signals: "the approved library",
  triangle: "the triangle classification",
  scenarios: "the published scenarios",
  simulation: "the latest simulation run",
  drivers: "the driver settings",
};

let data = null;
let timer = null;

// Same citation affordance as the chat page, but rendered as real buttons:
// these are the primary control on the page, and a span with a click handler
// is unreachable by keyboard and announced as nothing.
const pills = (s) => esc(s)
  .replace(/\[S(\d+)\]/g, `<button type="button" class="cite-pill" data-sig="$1" aria-label="Open signal $1">S$1</button>`)
  .replace(/\[SC:([a-z0-9-]+)\]/gi, (_m, slug) =>
    `<button type="button" class="cite-pill" data-scenario="${slug}" aria-label="Open scenario ${slug}">${slug}</button>`);

const paras = (s) => (s || "").split(/\n{2,}/).map((p) => `<p>${pills(p.trim())}</p>`).join("");

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function drawStatus() {
  const st = $("repStatus");
  const r = data.report;
  if (data.generating) {
    st.hidden = false;
    st.classList.remove("is-error");
    st.textContent = "A fresh synthesis is generating — this page updates when it lands.";
    return;
  }
  if (!r) {
    st.hidden = false;
    st.classList.toggle("is-error", !data.available);
    st.textContent = data.available
      ? "No report has been written yet. Generating one reads the approved library, the triangle synthesis, the published scenarios and the latest simulation."
      : "No report has been written yet, and no model key is configured — generation is unavailable.";
    return;
  }
  if (data.stale) {
    const what = (data.changed || []).map((k) => INPUT_LABEL[k] || k);
    const list = what.length > 1 ? what.slice(0, -1).join(", ") + " and " + what[what.length - 1] : what[0] || "its inputs";
    st.hidden = false;
    st.classList.remove("is-error");
    st.textContent = `This report describes an earlier state of the instrument — ${list} ${what.length > 1 ? "have" : "has"} moved since it was written. Regenerate to bring it current.`;
    return;
  }
  st.hidden = true;
}

function drawReport() {
  const r = data.report;
  $("regenerate").textContent = r ? "Regenerate the report" : "Write the report";
  $("regenerate").disabled = !data.available || data.generating;
  if (!r) {
    $("repHeadline").textContent = "";
    $("repMeta").textContent = "";
    $("repBody").innerHTML = "";
    $("repMethod").hidden = true;
    return;
  }

  $("repMethod").hidden = false;
  $("repHeadline").innerHTML = pills(r.headline || "");
  $("repMeta").textContent =
    `Written from ${r.signal_count} human-approved signals · ${fmtWhen(r.updated_at)}` +
    (r.citations_dropped ? ` · ${r.citations_dropped} unverifiable citation${r.citations_dropped === 1 ? "" : "s"} removed` : "");

  $("repBody").innerHTML = SECTIONS.map(([key, title]) => `
    <section class="report-section" data-section="${key}">
      <h3>${esc(title)}</h3>
      <div class="report-prose">${paras(r[key])}</div>
      ${key === "odds" ? `<figure class="report-figure"><div id="repOdds"></div><figcaption id="repOddsCap">Scenario probabilities from the latest simulation run, with the residual — the share of sampled futures matching no scenario.</figcaption></figure>` : ""}
      ${key === "sensitivity" ? `<figure class="report-figure"><div id="repTornado"></div><figcaption id="repTornadoCap"></figcaption></figure>` : ""}
    </section>`).join("");

  drawFigures();
}

// The figures come from the simulation endpoint directly rather than from the
// model's prose, so the numbers on the page are the platform's numbers.
async function drawFigures() {
  try {
    const { latest } = await api("/api/simulation/latest");
    // No run yet: drop the figures rather than leaving empty frames with
    // captions describing numbers that do not exist.
    if (!latest) {
      document.querySelectorAll(".report-figure").forEach((f) => f.remove());
      return;
    }
    const odds = $("repOdds");
    if (odds) {
      probabilityBars(odds, (latest.scenarios || []).map((s) => ({
        label: s.title, sublabel: s.archetype, value: s.probability, color: ARCH_COLOR[s.archetype] || "#6B7264",
      })).concat([{ label: "No scenario fits", sublabel: "residual", value: latest.residual, color: "#9A9A8A" }]));
    }
    const tor = $("repTornado");
    if (tor) {
      const first = Object.keys(latest.tornado || {})[0];
      if (first) {
        tornado(tor, latest.tornado[first]);
        const cap = $("repTornadoCap");
        if (cap) cap.innerHTML = `How far each driver moves the odds for <strong>${esc(first)}</strong>, comparing its top third against its bottom third. The full set is on the <a href="/simulation">simulation</a> page.`;
      }
    }
  } catch { /* figures are an enhancement; the prose stands without them */ }
}

// ---------------- drawer (citation follow-through) ----------------

function closeDrawer() { document.body.classList.remove("drawer-open"); }

async function openSignal(id) {
  const dr = $("drawer");
  dr.innerHTML = `<p class="caption">Loading signal ${esc(id)}…</p>`;
  document.body.classList.add("drawer-open");
  try {
    const s = await api(`/api/signals/${id}`);
    dr.innerHTML = `
      <button class="drawer-close" aria-label="Close">×</button>
      <span class="label">Signal ${s.id}</span>
      <h3 class="mt-2">${esc(s.title)}</h3>
      <p class="mt-2">${esc(s.summary)}</p>
      <div class="mt-4">
        <span class="tag tag-olive">${esc(s.cluster || "")}</span>
        <span class="tag tag-dim">${esc(s.signal_type || "")}</span>
        <span class="tag tag-mustard">${esc(s.urgency || "")}</span>
        <span class="tag tag-blue">${esc(s.horizon || "")}</span>
      </div>
      <div class="citation mt-4">
        <div class="quote"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></div>
        <div class="source">${esc(s.source || "unknown source")}</div>
      </div>
      ${noteCard(s)}`;
    wireNoteCard(dr);
    dr.querySelector(".drawer-close")?.addEventListener("click", closeDrawer);
  } catch (e) {
    dr.innerHTML = `<button class="drawer-close" aria-label="Close">×</button><div class="error-note">${esc(e.message)}</div>`;
    dr.querySelector(".drawer-close")?.addEventListener("click", closeDrawer);
  }
}

document.addEventListener("click", (e) => {
  const pill = e.target.closest(".cite-pill");
  if (!pill) return;
  if (pill.dataset.sig) openSignal(pill.dataset.sig);
  else if (pill.dataset.scenario) location.href = `/scenarios#${pill.dataset.scenario}`;
});

// ---------------- load / regenerate ----------------

async function load() {
  data = await api("/api/report");
  drawStatus();
  drawReport();
  clearTimeout(timer);
  if (data.generating) timer = setTimeout(load, 3000);
}

$("regenerate").addEventListener("click", async () => {
  const btn = $("regenerate");
  btn.disabled = true;
  $("repState").textContent = "requesting…";
  try {
    await api("/api/report/regenerate", { method: "POST" });
    $("repState").textContent = "generating — this takes a minute or two";
    clearTimeout(timer);
    timer = setTimeout(load, 2000);
  } catch (e) {
    $("repState").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

renderNav("/report");
$("backdrop")?.addEventListener("click", closeDrawer);
load();
