import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";
import { probabilityBars, tornado, ARCH_COLOR } from "./charts.js";
import { evidenceFigure, triangleFigure, scenarioLedger } from "./report-figures.js";

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

// The model returns each section as a single block, which lands as a 150-word
// wall. Split on sentence boundaries into roughly even paragraphs — words are
// never touched, only where the breaks fall.
//
// The boundary needs all three of: terminal punctuation, whitespace, and a
// capital or opening quote after it. An earlier version matched any period and
// rewrote "8.8%" as "8. 8%" — corrupting figures is far worse than a long
// paragraph, so the lookahead is load-bearing, not defensive styling.
const SENTENCE_BREAK = /(?<=[.!?]["\u201d\u2019]?)\s+(?=["\u201c(\[]?[A-Z])/;

function breakUp(block, target = 55) {
  const count = (t) => t.split(/\s+/).filter(Boolean).length;
  if (count(block) <= 80) return [block];
  const sentences = block.split(SENTENCE_BREAK);
  if (sentences.length < 2) return [block];

  const words = count(block);
  const per = Math.ceil(words / Math.max(2, Math.round(words / target)));
  const out = [];
  let buf = [], n = 0;
  for (const sent of sentences) {
    buf.push(sent);
    n += count(sent);
    if (n >= per) { out.push(buf.join(" ")); buf = []; n = 0; }
  }
  if (buf.length) {
    const tail = buf.join(" ");
    if (out.length && count(tail) < 18) out[out.length - 1] += " " + tail;
    else out.push(tail);
  }
  return out;
}

const paras = (s) => (s || "")
  .split(/\n{2,}/)
  .flatMap((block) => breakUp(block.trim()))
  .filter(Boolean)
  .map((p) => `<p>${pills(p)}</p>`).join("");

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

  const fig = {
    state_of_evidence: evidenceFigure(ctx),
    triangle_reading: triangleFigure(ctx.triangle),
    scenario_space: scenarioLedger(ctx.scenarios, ctx.sim),
    odds: ctx.sim ? `<figure class="report-figure"><div class="fig-head"><h4>How the odds fall</h4><p class="fig-sub">${ctx.sim.n.toLocaleString()} sampled futures, seed ${ctx.sim.seed}</p></div><div id="repOdds"></div></figure>` : "",
    sensitivity: ctx.sim ? `<figure class="report-figure"><div class="fig-head"><h4>What actually moves them</h4><p class="fig-sub" id="repTornadoCap"></p></div><div id="repTornado"></div></figure>` : "",
  };

  $("repBody").innerHTML = SECTIONS.map(([key, title]) => `
    <section class="report-section${fig[key] ? " has-figure" : ""}" data-section="${key}">
      <h3>${esc(title)}</h3>
      <div class="report-prose">${paras(r[key])}</div>
      ${fig[key] || ""}
    </section>`).join("");

  drawCharts(ctx);
}

// Everything the figures draw is fetched live rather than taken from the
// model's prose, so a picture can never disagree with the platform. When the
// report itself is stale the banner already says so; the figures stay current
// on purpose, and the method note explains why.
let ctx = { facets: null, overview: null, triangle: null, scenarios: null, sim: null };

async function loadContext() {
  const get = (p) => api(p).catch(() => null);
  const [facets, overview, triangle, scenarios, simRes] = await Promise.all([
    get("/api/signals/facets?status=approved"),
    get("/api/signals/overview"),
    get("/api/triangle"),
    get("/api/scenarios?status=published"),
    get("/api/simulation/latest"),
  ]);
  ctx = {
    facets, overview,
    triangle: triangle?.counts || null,
    scenarios: scenarios?.scenarios || null,
    sim: simRes?.latest || null,
  };
}

function drawCharts(c) {
  if (!c.sim) return;
  const odds = $("repOdds");
  if (odds) {
    probabilityBars(odds, (c.sim.scenarios || []).map((s) => ({
      label: s.title, sublabel: s.archetype, value: s.probability, color: ARCH_COLOR[s.archetype] || "#6B7264",
    })).concat([{ label: "No scenario fits", sublabel: "residual", value: c.sim.residual, color: "#8A8778" }]));
  }
  const tor = $("repTornado");
  if (tor) {
    const first = Object.keys(c.sim.tornado || {})[0];
    if (first) {
      tornado(tor, c.sim.tornado[first]);
      const cap = $("repTornadoCap");
      if (cap) cap.innerHTML = `Driver sensitivity for <strong>${esc(first)}</strong> — each driver's top third against its bottom third. Full set on the <a href="/simulation">simulation</a> page.`;
    }
  }
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
  const [rep] = await Promise.all([api("/api/report"), loadContext()]);
  data = rep;
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
