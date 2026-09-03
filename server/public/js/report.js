import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";
import { sourceText, wireSourceText } from "./signal-text.js";
import { probabilityBars, tornado, ARCH_COLOR } from "./charts.js";
import { evidenceFigure, triangleFigure, triangleBridge, scenarioLedger } from "./report-figures.js";

const $ = (id) => document.getElementById(id);

// Section order is the argument's order: what the evidence is, how it reads,
// where the futures fork, what the odds are, what moves them, what would
// break the reading, and what follows.
// signals → drivers → triangle → scenario + odds → so what.
// "What moves them" and "What would change our mind" read as the same
// section; they are not. One names which dial in the model carries the
// outcome, the other names what would have to happen in the world for the
// reading to be wrong. Renamed so the difference is on the page, and the
// watch-list moved to the close, where a forward-looking list belongs.
const SECTIONS = [
  ["state_of_evidence", "The state of the evidence"],
  ["sensitivity", "Which levers decide it"],
  ["triangle_reading", "The triangle reading"],
  ["scenario_space", "The scenario space and the odds"],
  ["so_what", "So what"],
  ["what_would_change_our_mind", "What we're watching for"],
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
let editing = null;    // section key currently open in the editor
let comparing = null;  // section key currently showing draft-vs-yours
let tick = null;       // local 1s clock so elapsed time moves between polls

const mmss = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

// An authored section wins over the machine draft. `draft_moved` means the
// evidence has shifted since it was written — surfaced, never auto-applied.
const authoredOf = (key) => data?.authored?.[key];
const valueOf = (key) => {
  const a = authoredOf(key);
  return a ? a.value : data.report[key];
};

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

// Falsifiers as a watch-list rather than a paragraph: the observable, which
// way it cuts, and what it would mean. Falls back to prose for reports cached
// before the section was structured.
function falsifierList(v) {
  if (typeof v === "string" || !Array.isArray(v)) return `<div class="report-prose">${paras(v)}</div>`;
  return `<ul class="watchlist">${v.map((f) => `
    <li class="watch" data-dir="${f.direction === "weakens" ? "weakens" : "strengthens"}">
      <span class="watch-dir">${f.direction === "weakens" ? "weakens" : "strengthens"}</span>
      <p class="watch-obs">${pills(f.watch || "")}</p>
      <p class="watch-mean">${pills(f.meaning || "")}</p>
    </li>`).join("")}</ul>`;
}

// Two audiences, kept apart. Blending them into one paragraph was the reason
// this section read as undifferentiated advice.
function audienceSplit(r) {
  const policy = r.so_what_policy, industry = r.so_what_industry;
  // Reports cached before the split keep their single prose block; never
  // fabricate a division the model did not make.
  if (!policy && !industry) return `<div class="report-prose">${paras(r.so_what)}</div>`;
  const col = (label, who, text) => `
    <div class="aud">
      <h4 class="aud-label">${esc(label)}</h4>
      <p class="aud-who">${esc(who)}</p>
      <div class="report-prose">${paras(text)}</div>
    </div>`;
  return `<div class="aud-split">
    ${col("For policy", "Public-policy makers working on AI governance", policy)}
    ${col("For industry", "Strategy and trust teams inside AI companies", industry)}
  </div>`;
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


// ---------------- authoring toolbar, editor, critiques ----------------

// `so_what` is two stored fields behind one heading, so the editor works on
// whichever key the author is actually touching.
const EDIT_KEYS = {
  so_what: ["so_what_policy", "so_what_industry"],
};
const editKeysFor = (key) => EDIT_KEYS[key] || [key];

function toolbar(key) {
  const a = authoredOf(key) || (EDIT_KEYS[key] || []).map(authoredOf).find(Boolean);
  const list = (data.critiques?.[key] || []);
  const open = list.filter((c) => !c.addressed_at).length;
  return `<div class="sec-tools">
    ${a ? `<span class="sec-badge${a.draft_moved ? " moved" : ""}" title="${a.draft_moved ? "The evidence has moved since you wrote this" : "Your text, not the machine draft"}">${a.draft_moved ? "authored · draft moved" : "authored"}</span>` : ""}
    ${open ? `<span class="sec-badge open">${open} open</span>` : ""}
    ${a ? `<button type="button" class="sec-btn" data-compare="${key}">${comparing === key ? "Hide draft" : "Compare draft"}</button>` : ""}
    <button type="button" class="sec-btn" data-edit="${key}">Edit</button>
    <div class="sec-menu">
      <button type="button" class="sec-btn" data-menu="${key}">Critique</button>
      <div class="sec-modes" id="modes-${key}" hidden>
        ${Object.entries(data.modes || {}).map(([m, label]) =>
          `<button type="button" class="sec-mode" data-critique="${key}" data-mode="${m}">${esc(label)}</button>`).join("")}
      </div>
    </div>
  </div>`;
}


// Yours beside the machine's. No diff algorithm: these are two pieces of
// written argument, not two versions of a config file, and a word-level diff
// of rewritten prose is noise. The reader compares them by reading them.
function comparePanel(key) {
  const a = authoredOf(key) || (EDIT_KEYS[key] || []).map(authoredOf).find(Boolean);
  if (!a) return "";
  const keys = editKeysFor(key);
  const asText = (v) => (typeof v === "string" ? v
    : Array.isArray(v) ? v.map((f) => `${(f.direction || "").toUpperCase()} — ${f.watch}\n${f.meaning}`).join("\n\n")
    : JSON.stringify(v, null, 2));
  const col = (label, note, body, cls) => `
    <div class="cmp-col ${cls}">
      <div class="cmp-head"><span class="cmp-label">${esc(label)}</span><span class="cmp-note">${esc(note)}</span></div>
      <div class="report-prose">${body}</div>
    </div>`;
  const yours = keys.map((k) => paras(asText(authoredOf(k)?.value ?? valueOf(k)))).join("");
  const draft = keys.map((k) => paras(asText(data.report[k]))).join("");
  return `<div class="cmp" data-compare-for="${key}">
    ${col("Your version", `edited ${fmtWhen(a.updated_at)}`, yours, "mine")}
    ${col("Current machine draft", a.draft_moved ? "regenerated since you wrote yours" : "unchanged since you wrote yours", draft, "draft")}
    <div class="cmp-actions">
      ${a.draft_moved ? `<button type="button" class="btn btn-sm" data-keep="${key}">Keep mine</button>` : ""}
      <button type="button" class="sec-btn danger" data-revert="${key}">Use the new draft</button>
      <button type="button" class="sec-btn" data-compare="${key}">Close</button>
    </div>
  </div>`;
}

function critiqueCard(c) {
  const b = c.body || {};
  const done = !!c.addressed_at;
  const label = (data.modes || {})[c.mode] || c.mode;
  const inner = c.mode === "signals"
    ? `<ul class="crit-list">${(b.picks || []).map((p) => `
        <li><span class="crit-stance" data-stance="${esc(p.stance)}">${esc(p.stance)}</span>
          <span class="crit-point">${esc(p.title)}</span>
          <button type="button" class="cite-pill" data-sig="${p.id}" aria-label="Open signal ${p.id}">S${p.id}</button>
          <span class="crit-detail">${esc(p.why)}</span></li>`).join("")
        || `<li><span class="crit-detail">Nothing in the library bears on this that the section has not already cited.</span></li>`}</ul>`
    : `<ul class="crit-list">${(b.points || []).map((p) => `
        <li><span class="crit-point">${pills(p.point)}</span>
          <span class="crit-detail">${pills(p.detail)}</span></li>`).join("")}</ul>`;
  return `<aside class="crit${done ? " done" : ""}" data-crit="${c.id}">
    <div class="crit-head">
      <span class="crit-label">${esc(label)}</span>
      <span class="crit-when">${fmtWhen(c.created_at)}${done ? " · addressed" : ""}</span>
      <span class="spacer"></span>
      ${done ? "" : `<button type="button" class="sec-btn" data-addressed="${c.id}">Mark addressed</button>`}
      <button type="button" class="sec-btn" data-dismiss="${c.id}">Dismiss</button>
    </div>
    ${b.verdict ? `<p class="crit-verdict">${pills(b.verdict)}</p>` : ""}
    ${inner}
  </aside>`;
}

const critiquesFor = (key) => (data.critiques?.[key] || []).map(critiqueCard).join("");

// The falsifier list keeps its fields rather than collapsing to a textarea —
// the watch-list layout depends on the structure.
function editorFor(key) {
  const keys = editKeysFor(key);
  if (key === "what_would_change_our_mind") {
    const items = valueOf(key);
    const rows = Array.isArray(items) ? items : [];
    return `<div class="sec-editor" data-editor="${key}">
      <div id="falsifierRows">${rows.map(falsifierRow).join("")}</div>
      <button type="button" class="sec-btn" id="addFalsifier">Add a falsifier</button>
      ${editorActions(key)}
    </div>`;
  }
  return `<div class="sec-editor" data-editor="${key}">
    ${keys.map((k) => `
      ${keys.length > 1 ? `<label class="field-label">${esc(k.replace("so_what_", ""))}</label>` : ""}
      <textarea data-field-key="${k}" rows="${keys.length > 1 ? 8 : 12}">${esc(typeof valueOf(k) === "string" ? valueOf(k) : "")}</textarea>`).join("")}
    ${editorActions(key)}
  </div>`;
}

const falsifierRow = (f = { watch: "", direction: "strengthens", meaning: "" }) => `
  <div class="fal-row">
    <input type="text" data-fal="watch" value="${esc(f.watch || "")}" placeholder="The observable, 6-12 words">
    <select data-fal="direction">
      <option ${f.direction !== "weakens" ? "selected" : ""}>strengthens</option>
      <option ${f.direction === "weakens" ? "selected" : ""}>weakens</option>
    </select>
    <textarea data-fal="meaning" rows="2" placeholder="What it would imply">${esc(f.meaning || "")}</textarea>
    <button type="button" class="sec-btn" data-del-fal>Remove</button>
  </div>`;

const editorActions = (key) => `
  <div class="sec-editor-actions">
    <button type="button" class="btn btn-sm" data-save="${key}">Save</button>
    <button type="button" class="sec-btn" data-cancel>Cancel</button>
    ${editKeysFor(key).some(authoredOf) ? `<button type="button" class="sec-btn danger" data-revert="${key}">Revert to draft</button>` : ""}
    <span class="sec-msg"></span>
  </div>`;

function startClock(fromMs) {
  stopClock();
  const t0 = Date.now() - fromMs;
  tick = setInterval(() => {
    const el = $("genClock");
    if (!el) return stopClock();
    el.textContent = mmss(Date.now() - t0);
  }, 1000);
}
function stopClock() { if (tick) { clearInterval(tick); tick = null; } }

function drawStatus() {
  const st = $("repStatus");
  const r = data.report;
  const s = data.status || {};
  if (data.generating) {
    st.hidden = false;
    st.classList.remove("is-error");
    // Named stage plus a clock, because the writing step alone runs for
    // minutes and a static sentence cannot be told apart from a hang.
    st.innerHTML = `<span>Writing a fresh report — <strong>${esc(s.stage || "starting")}</strong>${s.note ? ` (${esc(s.note)})` : ""} · <span id="genClock">${mmss(s.elapsed_ms || 0)}</span></span>`;
    startClock(s.elapsed_ms || 0);
    return;
  }
  stopClock();
  // A failure used to leave the previous report on screen with nothing said.
  if (s.error && s.failed_at) {
    st.hidden = false;
    st.classList.add("is-error");
    st.textContent = `The last attempt to write a report failed after ${mmss(s.elapsed_ms || 0)} — ${s.error}. The report below is the previous one.`;
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
  $("repHeadline").innerHTML = pills(valueOf("headline") || "");
  // Instrument strip: real platform values in the house mono register, each
  // item its own element so the drawn separators fall between them.
  const bits = [`<b>${r.signal_count}</b> approved signals`];
  if (ctx.overview) bits.push(`<b>${ctx.overview.clusters.length}</b> clusters`);
  if (ctx.scenarios) bits.push(`<b>${ctx.scenarios.length}</b> scenarios`);
  if (ctx.sim) bits.push(`<b>${(ctx.sim.residual * 100).toFixed(1)}%</b> residual`);
  bits.push(fmtWhen(r.updated_at));
  if (r.citations_dropped) bits.push(`<b>${r.citations_dropped}</b> citation${r.citations_dropped === 1 ? "" : "s"} dropped`);
  $("repMeta").innerHTML = bits.map((b) => `<span>${b}</span>`).join("\n");

  const RENDER = {
    what_would_change_our_mind: () => falsifierList(valueOf("what_would_change_our_mind")),
    so_what: () => audienceSplit({
      so_what_policy: valueOf("so_what_policy"),
      so_what_industry: valueOf("so_what_industry"),
      so_what: valueOf("so_what"),
    }),
  };

  const oddsFigure = ctx.sim
    ? `<figure class="report-figure"><div class="fig-head"><h4>How the odds fall</h4><p class="fig-sub">${ctx.sim.n.toLocaleString()} sampled futures, seed ${ctx.sim.seed}</p></div><div id="repOdds"></div></figure>`
    : "";

  const fig = {
    state_of_evidence: evidenceFigure(ctx),
    // Drivers come before the scenarios now, so the tornado stands on its own
    // rather than as a footnote to odds the reader has not reached.
    sensitivity: ctx.sim ? `<figure class="report-figure"><div class="fig-head"><h4>How far each driver moves the outcome</h4><p class="fig-sub" id="repTornadoCap"></p></div><div id="repTornado"></div></figure>` : "",
    // The triangle hands off to the fork instead of stopping.
    triangle_reading: triangleFigure(ctx.triangle) + triangleBridge(ctx.mix),
    // Scenario and odds are one movement: here is the fork, here is how it falls.
    scenario_space: scenarioLedger(ctx.scenarios, ctx.sim)
      + (data.report.odds ? `<div class="report-prose sub-prose">${paras(valueOf("odds"))}</div>` : "")
      + oddsFigure,
  };

  $("repBody").innerHTML = SECTIONS.map(([key, title]) => `
    <section class="report-section${fig[key] ? " has-figure" : ""}" data-section="${key}">
      <div class="sec-head">
        <h3>${esc(title)}</h3>
        ${toolbar(key)}
      </div>
      ${editing === key ? editorFor(key) : (RENDER[key] ? RENDER[key]() : `<div class="report-prose">${paras(valueOf(key))}</div>`)}
      ${comparing === key ? comparePanel(key) : ""}
      ${fig[key] || ""}
      ${critiquesFor(key)}
    </section>`).join("");

  drawCharts(ctx);
  wireRail();
}

// Everything the figures draw is fetched live rather than taken from the
// model's prose, so a picture can never disagree with the platform. When the
// report itself is stale the banner already says so; the figures stay current
// on purpose, and the method note explains why.
let ctx = { facets: null, overview: null, triangle: null, scenarios: null, sim: null };

async function loadContext() {
  const get = (p) => api(p).catch(() => null);
  const [facets, overview, triangle, scenarios, simRes, mix] = await Promise.all([
    get("/api/signals/facets?status=approved"),
    get("/api/signals/overview"),
    get("/api/triangle"),
    get("/api/scenarios?status=published"),
    get("/api/simulation/latest"),
    get("/api/scenarios/triangle-mix"),
  ]);
  ctx = {
    facets, overview,
    triangle: triangle?.counts || null,
    scenarios: scenarios?.scenarios || null,
    sim: simRes?.latest || null,
    mix: mix?.scenarios || null,
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
      ${noteCard(s)}
      ${sourceText(s)}`;
    wireNoteCard(dr); wireSourceText(dr);
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
  if (data.generating) timer = setTimeout(load, 2000);
}

$("regenerate").addEventListener("click", async () => {
  const btn = $("regenerate");
  btn.disabled = true;
  $("repState").textContent = "requesting…";
  try {
    await api("/api/report/regenerate", { method: "POST" });
    $("repState").textContent = "";
    clearTimeout(timer);
    timer = setTimeout(load, 2000);
  } catch (e) {
    $("repState").textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});



// Scenario rail. Snap points do the positioning; these just move by one panel
// or jump to one, and respect a reduced-motion preference.
// Hand-rolled glide. Native smooth scrolling is unavailable here: Lenis
// drives page scroll and cancels programmatic smooth scrolls on nested
// elements, so `behavior: "smooth"` silently never arrives and even a plain
// scrollLeft assignment animates-then-dies while CSS scroll-behavior is set.
let railAnim = null, railSettle = null;
function railGlide(rail, target) {
  const max = rail.scrollWidth - rail.clientWidth;
  const to = Math.max(0, Math.min(max, target));
  const land = () => { rail.scrollLeft = to; markRailPosition(); };

  // No frames are coming in a hidden or throttled tab, so animating would
  // leave the rail exactly where it was. Movement must never depend on the
  // animation arriving — the same rule the section reveals learned.
  if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) return land();

  cancelAnimationFrame(railAnim);
  clearTimeout(railSettle);
  const from = rail.scrollLeft, t0 = performance.now(), dur = 380;
  const ease = (p) => 1 - Math.pow(1 - p, 4);   // ease-out-quart, house curve
  let done = false;
  const frame = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    rail.scrollLeft = from + (to - from) * ease(p);
    if (p < 1) railAnim = requestAnimationFrame(frame);
    else { done = true; markRailPosition(); }
  };
  railAnim = requestAnimationFrame(frame);
  // Safety net: if the frames never landed, put it where it was asked to go.
  railSettle = setTimeout(() => { if (!done) land(); }, dur + 120);
}

function railStep(dir) {
  const rail = document.querySelector(".sc-rail");
  if (!rail) return;
  const panel = rail.querySelector(".sc-block");
  const step = panel ? panel.getBoundingClientRect().width + 20 : rail.clientWidth * 0.8;
  railGlide(rail, rail.scrollLeft + dir * step);
}
function railTo(i) {
  const rail = document.querySelector(".sc-rail");
  const panel = rail?.querySelectorAll(".sc-block")[i];
  if (!panel) return;
  railGlide(rail, panel.offsetLeft - rail.offsetLeft);
}

// Which panel is in view, so the dots say where you are.
function markRailPosition() {
  const rail = document.querySelector(".sc-rail");
  if (!rail) return;
  const panels = [...rail.querySelectorAll(".sc-block")];
  // Nearest to the LEFT edge, not the centre: panels snap to start and more
  // than one is visible at a time, so centre-matching marked panel 1 as
  // current while the rail was still at position zero.
  let best = 0, bestD = Infinity;
  panels.forEach((p, i) => {
    const dd = Math.abs((p.offsetLeft - rail.offsetLeft) - rail.scrollLeft);
    if (dd < bestD) { bestD = dd; best = i; }
  });
  // At the end of the rail the last panel cannot reach the left edge, so
  // left-edge matching under-reports. If we are at the end, we are on the last.
  if (rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2) best = panels.length - 1;
  document.querySelectorAll(".sc-dot").forEach((d, i) => d.classList.toggle("here", i === best));
  const prev = document.querySelector('[data-rail="prev"]');
  const next = document.querySelector('[data-rail="next"]');
  if (prev) prev.disabled = rail.scrollLeft <= 2;
  if (next) next.disabled = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
}

function wireRail() {
  const rail = document.querySelector(".sc-rail");
  if (!rail || rail._wired) return;
  rail._wired = true;
  rail.addEventListener("scroll", markRailPosition, { passive: true });
  markRailPosition();
}

// ---------------- authoring interactions ----------------

const closeMenus = () => document.querySelectorAll(".sec-modes").forEach((m) => (m.hidden = true));

function collectEdit(key) {
  if (key === "what_would_change_our_mind") {
    const rows = [...document.querySelectorAll("#falsifierRows .fal-row")].map((r) => ({
      watch: r.querySelector('[data-fal="watch"]').value.trim(),
      direction: r.querySelector('[data-fal="direction"]').value,
      meaning: r.querySelector('[data-fal="meaning"]').value.trim(),
    })).filter((f) => f.watch || f.meaning);
    return { [key]: JSON.stringify(rows) };
  }
  const out = {};
  document.querySelectorAll("[data-field-key]").forEach((el) => { out[el.dataset.fieldKey] = el.value; });
  return out;
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) { closeMenus(); return; }

  // ---- edit ----
  if (t.dataset.rail) { railStep(t.dataset.rail === "next" ? 1 : -1); return; }
  if (t.dataset.railTo !== undefined) { railTo(+t.dataset.railTo); return; }

  if (t.dataset.edit) { editing = t.dataset.edit; comparing = null; closeMenus(); drawReport(); return; }
  if (t.dataset.compare) { comparing = comparing === t.dataset.compare ? null : t.dataset.compare; editing = null; closeMenus(); drawReport(); return; }
  if (t.dataset.keep) {
    await api(`/api/report/sections/${encodeURIComponent(t.dataset.keep)}/keep`, { method: "POST" });
    comparing = null;
    await load();
    return;
  }
  if (t.dataset.cancel !== undefined) { editing = null; drawReport(); return; }

  if (t.dataset.save) {
    const key = t.dataset.save;
    const msg = t.closest(".sec-editor-actions").querySelector(".sec-msg");
    msg.textContent = "saving…";
    try {
      for (const [k, text] of Object.entries(collectEdit(key))) {
        await api(`/api/report/sections/${encodeURIComponent(k)}`, { method: "PUT", body: { text } });
      }
      editing = null;
      await load();
    } catch (err) { msg.textContent = err.message; }
    return;
  }

  if (t.dataset.revert) {
    if (!confirm("Discard your text for this section and go back to the machine draft?")) return;
    for (const k of editKeysFor(t.dataset.revert)) {
      try { await api(`/api/report/sections/${encodeURIComponent(k)}`, { method: "DELETE" }); } catch {}
    }
    editing = null;
    comparing = null;
    await load();
    return;
  }

  // ---- critique ----
  if (t.dataset.menu) {
    const m = $("modes-" + t.dataset.menu);
    const wasHidden = m.hidden;
    closeMenus();
    m.hidden = !wasHidden;
    return;
  }

  if (t.dataset.critique) {
    const key = t.dataset.critique, mode = t.dataset.mode;
    closeMenus();
    const sec = document.querySelector(`[data-section="${key}"]`) || document.querySelector(".report-standfirst");
    sec.insertAdjacentHTML("beforeend", `<aside class="crit pending" id="critPending"><div class="crit-head"><span class="crit-label">${esc((data.modes || {})[mode] || mode)}</span><span class="crit-when">reading the section…</span></div></aside>`);
    try {
      await api("/api/report/critique", { method: "POST", body: { section: key, mode } });
      await load();
    } catch (err) {
      const p = $("critPending");
      if (p) p.innerHTML = `<div class="error-note">${esc(err.message)}</div>`;
    }
    return;
  }

  if (t.dataset.addressed) {
    await api(`/api/report/critiques/${t.dataset.addressed}/addressed`, { method: "POST" });
    await load();
    return;
  }
  if (t.dataset.dismiss) {
    await api(`/api/report/critiques/${t.dataset.dismiss}`, { method: "DELETE" });
    await load();
    return;
  }
  if (t.dataset.delFal !== undefined) { t.closest(".fal-row").remove(); return; }
  if (t.id === "addFalsifier") {
    $("falsifierRows").insertAdjacentHTML("beforeend", falsifierRow());
    return;
  }
});

renderNav("/report");
$("backdrop")?.addEventListener("click", closeDrawer);
load();
