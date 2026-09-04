import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";
import { sourceText, wireSourceText } from "./signal-text.js";
import { probabilityBars, tornado, ARCH_COLOR } from "./charts.js";
import { evidenceFigure, triangleFigure, triangleBridge, scenarioLedger, CLA } from "./report-figures.js";

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
// A section can carry more than one written part — merging the fork and the
// odds into one movement, and splitting "so what" by audience, meant the
// section id stopped being the thing you edit. Parts are what get authored
// and critiqued; the section is just where they sit.
const SECTIONS = [
  ["state_of_evidence", "The state of the evidence", ["state_of_evidence"]],
  ["sensitivity", "Which levers decide it", ["sensitivity"]],
  ["triangle_reading", "The triangle reading", ["triangle_reading"]],
  ["scenario_space", "The scenario space and the odds", ["scenario_space", "odds"]],
  ["so_what", "So what", ["so_what_policy", "so_what_industry"]],
  ["what_would_change_our_mind", "What we're watching for", ["what_would_change_our_mind"]],
];

// Shown on the control when a section has more than one part, so it is clear
// which piece of writing the button acts on.
const PART_LABEL = {
  scenario_space: "the fork",
  odds: "the odds",
  so_what_policy: "policy",
  so_what_industry: "industry",
  headline: "the headline",
};
const partsOf = (sectionKey) => (SECTIONS.find(([k]) => k === sectionKey) || [])[2] || [sectionKey];
// Where a part's critiques should be rendered. A scenario is written text that
// lives in `scenarios` rather than in the report draft, so it is addressed as
// "scenario:<slug>" and belongs to the section that shows the fork.
const isScenarioPart = (part) => String(part).startsWith("scenario:");
const scenarioOf = (part) => (ctx?.scenarios || []).find((s) => s.slug === String(part).slice(9));
const sectionOfPart = (part) =>
  isScenarioPart(part) ? "scenario_space"
    : (SECTIONS.find(([, , parts]) => parts.includes(part)) || [])[0] || part;
// A section owns a part if it declares it, or if it is where scenarios live.
// How a part is named to the author in confirms and status lines.
const partName = (part) =>
  PART_LABEL[part] || (isScenarioPart(part) ? `the ${scenarioOf(part)?.title || "scenario"} scenario` : "this section");
// Server errors name environment variables; readers get a sentence instead.
const humanErr = (m) => /ANTHROPIC_API_KEY/.test(m) ? "Generation is unavailable — no model key is configured."
  : /VOYAGE_API_KEY/.test(m) ? "Alternative signals needs the vector index, which is not configured."
  : m;
const sectionOwns = (sectionKey, part) =>
  !!part && (partsOf(sectionKey).includes(part) || (isScenarioPart(part) && sectionKey === "scenario_space"));

// Controls are anchored to the block they act on rather than piled in the
// section head — with two or three parts in a section the pile stopped saying
// which buttons belonged to which piece of writing. A renderer emits a slot;
// one pass after the section is in the DOM fills them in.
const toolSlot = (part) => `<div class="part-tools" data-part-tools="${part}"></div>`;
function fillToolSlots(root) {
  root.querySelectorAll("[data-part-tools]").forEach((el) => {
    el.innerHTML = partControls(el.dataset.partTools);
  });
}

const INPUT_LABEL = {
  signals: "the approved library",
  triangle: "the triangle classification",
  scenarios: "the published scenarios",
  simulation: "the latest simulation run",
  drivers: "the driver settings",
};

let data = null;
let timer = null;
let editing = null;    // part key currently open in the editor
let comparing = null;  // part key currently showing draft-vs-yours
let dirty = false;     // the open editor holds text that has not been saved
let pending = {};      // part → { mode } while a critique is being written
let critError = {};    // part → message when the last critique failed
let tick = null;       // local 1s clock so elapsed time moves between polls

const mmss = (ms) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

// An authored section wins over the machine draft. `draft_moved` means the
// evidence has shifted since it was written — surfaced, never auto-applied.
// Scenario slugs are storage identifiers. Everywhere one is shown to a reader
// it resolves to the published title — falling back to the slug only if the
// scenario is not in the published set, which is honest rather than blank.
const scenarioTitle = (slug) =>
  (ctx?.scenarios || []).find((s) => s.slug === slug)?.title || slug;

const authoredOf = (key) => data?.authored?.[key];
const valueOf = (key) => {
  const a = authoredOf(key);
  return a ? a.value : data.report[key];
};

// Same citation affordance as the chat page, but rendered as real buttons:
// these are the primary control on the page, and a span with a click handler
// is unreachable by keyboard and announced as nothing.
const citeHtml = (s) => esc(s)
  .replace(/\[S(\d+)\]/g, `<button type="button" class="cite-pill" data-sig="$1" aria-label="Open signal $1">S$1</button>`)
  .replace(/\[SC:([a-z0-9-]+)\]/gi, (_m, slug) =>
    `<button type="button" class="cite-pill" data-scenario="${slug}" aria-label="Open scenario ${esc(scenarioTitle(slug))}">${esc(scenarioTitle(slug))}</button>`);

// An attributed quotation — the server's own pattern (quotes.js QUOTED). What
// survives the gate on the machine draft is verified by construction; an
// authored part reports which of its quotations would fail. Either way the
// reader can see which words are a source's own, and the citation carries the
// quotation into the drawer so it can be found in the retained text.
// Mirror of quotes.js QUOTED: one alternation per quote style, never crossing a mark of its own style.
const QUOTED = /(?:"([^"]{25,400})"|\u201C([^\u201C\u201D]{25,400})\u201D)\s*(\([^)]*\))?\s*\[S(\d+)\]/g;
let failingQuotes = new Set();
const pills = (s) => {
  if (typeof s !== "string") return "";
  let out = "", last = 0;
  for (const m of s.matchAll(QUOTED)) {
    const [, straight, curly, paren, id] = m;
    const quote = straight ?? curly;
    const failed = failingQuotes.has(quote.slice(0, 160));
    out += citeHtml(s.slice(last, m.index));
    out += `<q class="vq${failed ? " fail" : ""}" title="${failed ? "Not verified — these words were not found in the retained source text" : "Verified word-for-word against the retained source text"}">${esc(quote)}</q>${paren ? " " + esc(paren) : ""} <button type="button" class="cite-pill" data-sig="${id}" data-quote="${encodeURIComponent(quote)}" aria-label="Open signal ${id} at this quotation">S${id}</button>`;
    last = m.index + m[0].length;
  }
  return out + citeHtml(s.slice(last));
};

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
  const col = (label, who, text, part) => `
    <div class="aud">
      <h4 class="aud-label">${esc(label)}</h4>
      <p class="aud-who">${esc(who)}</p>
      ${toolSlot(part)}
      <div class="report-prose">${paras(text)}</div>
    </div>`;
  return `<div class="aud-split">
    ${col("For policy", "Public-policy makers working on AI governance", policy, "so_what_policy")}
    ${col("For industry", "Strategy and trust teams inside AI companies", industry, "so_what_industry")}
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
// One compact cluster per block: the label is the block it sits on, so the
// buttons say only what they do.
function partControls(part) {
  const a = authoredOf(part);
  const open = (data.critiques?.[part] || []).filter((c) => !c.addressed_at).length;
  return `${a ? `<span class="sec-badge${a.draft_moved ? " moved" : ""}" title="${a.draft_moved ? "The draft has been rewritten since you authored this" : "Your text, not the machine draft"}">authored${a.draft_moved ? " · draft moved" : ""}</span>` : ""}
    ${open ? `<span class="sec-badge open" title="${open} critique${open === 1 ? "" : "s"} not yet marked addressed">${open} open</span>` : ""}
    ${a?.quotes?.stripped ? `<span class="sec-badge fail" title="Open the editor and check quotations">${a.quotes.stripped} unverified quotation${a.quotes.stripped === 1 ? "" : "s"}</span>` : ""}
    ${a ? `<button type="button" class="sec-btn" data-compare="${part}">${comparing === part ? "Hide" : "Compare"}</button>` : ""}
    <button type="button" class="sec-btn" data-edit="${part}">Edit</button>
    <span class="sec-menu">
      <button type="button" class="sec-btn" data-menu="${part}" aria-haspopup="menu" aria-expanded="false" aria-controls="modes-${part}"${pending[part] ? " disabled" : ""}>Critique</button>
      <span class="sec-modes" id="modes-${part}" role="menu" hidden>
        ${Object.entries(data.modes || {}).map(([m, label]) =>
          `<button type="button" class="sec-mode" role="menuitem" data-critique="${part}" data-mode="${m}">${esc(label)}</button>`).join("")}
      </span>
    </span>`;
}

// The heading rail is 210px wide, which is why a cluster of five pills used to
// wrap into a ragged pile there. Controls belong in the wide column, on the
// block they act on; the rail stays typography. Sections whose prose all lives
// in figures or columns get nothing here — those blocks carry their own.
function toolbar(sectionKey) {
  return partsOf(sectionKey)[0] === sectionKey ? toolSlot(sectionKey) : "";
}

// Yours beside the draft. Only offered where an authored version exists.
function comparePanel(part) {
  const a = authoredOf(part);
  if (!a) return "";
  const asText = (v) => (typeof v === "string" ? v
    : Array.isArray(v) ? v.map((f) => `${(f.direction || "").toUpperCase()} — ${f.watch}\n${f.meaning}`).join("\n\n")
    : JSON.stringify(v, null, 2));
  const col = (label, note, body, cls) => `
    <div class="cmp-col ${cls}">
      <div class="cmp-head"><span class="cmp-label">${esc(label)}</span><span class="cmp-note">${esc(note)}</span></div>
      <div class="report-prose">${body}</div>
    </div>`;
  return `<div class="cmp" data-compare-for="${part}">
    ${col("Your version", `edited ${fmtWhen(a.updated_at)}`, paras(asText(a.value)), "mine")}
    ${col("Current machine draft", a.draft_moved ? "regenerated since you wrote yours" : "unchanged since you wrote yours", paras(asText(data.report[part])), "draft")}
    <div class="cmp-actions">
      ${a.draft_moved ? `<button type="button" class="btn btn-sm" data-keep="${part}">Keep mine</button>` : ""}
      <button type="button" class="sec-btn danger" data-revert="${part}">Use the new draft</button>
      <button type="button" class="sec-btn" data-compare="${part}">Close</button>
    </div>
  </div>`;
}

// A critique being written, or the reason the last one failed. Held in state
// rather than injected into the DOM, so a redraw cannot lose it.
function critiqueState(part) {
  const p = pending[part], e = critError[part];
  if (p) return `<aside class="crit pending" role="status"><div class="crit-head"><span class="crit-label">${esc((data.modes || {})[p.mode] || p.mode)}</span><span class="crit-when">reading ${esc(partName(part))}…</span></div></aside>`;
  if (e) return `<aside class="crit" role="status"><div class="crit-head"><span class="crit-label">Critique failed</span><span class="spacer"></span><button type="button" class="sec-btn" data-clear-error="${part}">Dismiss</button></div><div class="error-note">${esc(e)}</div></aside>`;
  return "";
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
      ${isScenarioPart(c.section_key) ? `<span class="crit-subject">${esc(scenarioOf(c.section_key)?.title || c.section_key.slice(9))}</span>` : ""}
      <span class="crit-when">${fmtWhen(c.created_at)}${done ? " · addressed" : ""}</span>
      <span class="spacer"></span>
      ${done ? "" : `<button type="button" class="sec-btn" data-addressed="${c.id}">Mark addressed</button>`}
      <button type="button" class="sec-btn danger" data-dismiss="${c.id}">Delete</button>
    </div>
    ${b.verdict ? `<p class="crit-verdict">${pills(b.verdict)}</p>` : ""}
    ${inner}
  </aside>`;
}

// Parts, plus the section id itself for critiques stored before a section was
// split into parts — otherwise those rows would silently stop rendering.
const critiquesFor = (sectionKey) => {
  const keys = [...partsOf(sectionKey)];
  if (!keys.includes(sectionKey)) keys.push(sectionKey);
  if (sectionKey === "scenario_space") {
    keys.push(...Object.keys(data.critiques || {}).filter(isScenarioPart));
  }
  return keys.flatMap((k) => data.critiques?.[k] || [])
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(critiqueCard).join("") + keys.map(critiqueState).join("");
};

// The falsifier list keeps its fields rather than collapsing to a textarea —
// the watch-list layout depends on the structure.
// The scenario fields, in the order the ledger reads them.
const SC_FIELDS = [
  ["summary", "Summary", 4],
  ...CLA.map(([k, label, gloss]) => [k, `${label} — ${gloss}`, k === "myth" ? 3 : 5]),
];

// A scenario is real data, not a draft with a machine version behind it, so
// there is nothing to compare against and nothing to revert to — it saves
// straight to the published row, which is what makes the report go stale.
function scenarioEditor(part) {
  const sc = scenarioOf(part);
  if (!sc) return `<div class="error-note">That scenario is no longer published.</div>`;
  return `<div class="sec-editor sc-editor" data-editor="${part}">
    <p class="caption">Editing the published <b>${esc(sc.archetype)}</b> scenario. Saving changes the scenario everywhere it is used, and marks the report stale.</p>
    <label class="field-label" for="sc-title">Title</label>
    <input type="text" id="sc-title" data-sc-field="title" value="${esc(sc.title)}">
    ${SC_FIELDS.map(([k, label, rows]) => `
      <label class="field-label" for="sc-${k}">${esc(label)}</label>
      <textarea id="sc-${k}" data-sc-field="${k}" rows="${rows}">${esc(sc[k] || "")}</textarea>`).join("")}
    <div class="sec-editor-actions">
      <button type="button" class="btn btn-sm" data-save="${part}">Save the scenario</button>
      <button type="button" class="sec-btn" data-cancel="${part}">Cancel</button>
      <button type="button" class="sec-btn" data-check-quotes="${part}">Check quotations</button>
      <span class="sec-msg" role="status" aria-live="polite"></span>
    </div>
    <div class="quote-verdicts" data-verdicts-for="${part}" role="status"></div>
  </div>`;
}

function editorFor(part) {
  if (isScenarioPart(part)) return scenarioEditor(part);
  if (part === "what_would_change_our_mind") {
    const items = valueOf(part);
    const rows = Array.isArray(items) ? items : [];
    return `<div class="sec-editor" data-editor="${part}">
      <div id="falsifierRows">${rows.map(falsifierRow).join("")}</div>
      <button type="button" class="sec-btn" id="addFalsifier">Add something to watch for</button>
      ${editorActions(part)}
    </div>`;
  }
  // Only name the field where a section holds several — a lone label above a
  // lone textarea is noise.
  const named = part === "headline" || partsOf(sectionOfPart(part)).length > 1;
  return `<div class="sec-editor" data-editor="${part}">
    <label class="field-label${named ? "" : " sr-only"}" for="ed-${part}">${esc(PART_LABEL[part] || part.replace(/_/g, " "))}</label>
    <textarea id="ed-${part}" data-field-key="${part}" rows="${part === "headline" ? 3 : 12}">${esc(typeof valueOf(part) === "string" ? valueOf(part) : "")}</textarea>
    ${editorActions(part)}
  </div>`;
}

const falsifierRow = (f = { watch: "", direction: "strengthens", meaning: "" }) => `
  <div class="fal-row">
    <input type="text" data-fal="watch" value="${esc(f.watch || "")}" placeholder="The observable, 6-12 words" aria-label="What we would see">
    <select data-fal="direction" aria-label="Direction — strengthens or weakens the reading">
      <option ${f.direction !== "weakens" ? "selected" : ""}>strengthens</option>
      <option ${f.direction === "weakens" ? "selected" : ""}>weakens</option>
    </select>
    <textarea data-fal="meaning" rows="2" placeholder="What it would imply" aria-label="What it would mean">${esc(f.meaning || "")}</textarea>
    <button type="button" class="sec-btn" data-del-fal>Remove</button>
  </div>`;

const editorActions = (part) => `
  <div class="sec-editor-actions">
    <button type="button" class="btn btn-sm" data-save="${part}">Save</button>
    <button type="button" class="sec-btn" data-cancel="${part}">Cancel</button>
    ${authoredOf(part) ? `<button type="button" class="sec-btn danger" data-revert="${part}">Revert to draft</button>` : ""}
    <button type="button" class="sec-btn" data-check-quotes="${part}">Check quotations</button>
    <span class="sec-msg" role="status" aria-live="polite"></span>
  </div>
  <div class="quote-verdicts" data-verdicts-for="${part}" role="status"></div>`;

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
    st.textContent = r
      ? `The last attempt to write a report failed after ${mmss(s.elapsed_ms || 0)} — ${humanErr(s.error)}. The report below is the previous one; regenerate to try again.`
      : `The attempt to write the report failed after ${mmss(s.elapsed_ms || 0)} — ${humanErr(s.error)}. Try again when the cause is fixed.`;
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
    st.textContent = `This report describes an earlier state of the instrument — ${list} moved since it was written. Regenerate to bring it current.`;
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

  // An open editor is the author's, not the server's: the live node — and
  // everything typed into it — survives the rebuild. So do the rail position
  // and any layers the reader folded.
  const live = editing ? document.querySelector(`[data-editor="${CSS.escape(editing)}"]`) : null;
  const railIndex = [...document.querySelectorAll(".sc-dot")].findIndex((d) => d.classList.contains("here"));
  const folded = new Set([...document.querySelectorAll(".sc-block")]
    .filter((b) => b.querySelector(".cla-wrap") && !b.querySelector(".cla-wrap").open)
    .map((b) => b.getAttribute("aria-label")));

  $("repMethod").hidden = false;
  $("repHeadline").innerHTML = pills(valueOf("headline") || "");
  // The headline is written too, so it gets the same controls as any part.
  $("repHeadTools").innerHTML = editing === "headline"
    ? editorFor("headline")
    : `<div class="sec-tools standfirst-tools">${partControls("headline", false)}</div>`
      + (comparing === "headline" ? comparePanel("headline") : "")
      + (data.critiques?.headline || []).map(critiqueCard).join("")
      + critiqueState("headline");
  // Instrument strip: real platform values in the house mono register, each
  // item its own element so the drawn separators fall between them.
  const bits = [`<b>${r.signal_count}</b> approved signals`];
  if (ctx.overview) bits.push(`<b>${ctx.overview.clusters.length}</b> clusters`);
  if (ctx.scenarios) bits.push(`<b>${ctx.scenarios.length}</b> scenarios`);
  if (ctx.sim) bits.push(`<b>${(ctx.sim.residual * 100).toFixed(1)}%</b> fit no scenario`);
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
    scenario_space: scenarioLedger(ctx.scenarios, ctx.sim, (sc) => toolSlot(`scenario:${sc.slug}`))
      + (data.report.odds ? `<div class="part-block">
          <div class="part-block-head"><h5>How the odds read</h5>${toolSlot("odds")}</div>
          <div class="report-prose sub-prose">${paras(valueOf("odds"))}</div>
        </div>` : "")
      + oddsFigure,
  };

  $("repBody").innerHTML = SECTIONS.map(([key, title]) => {
    // Editing and comparing act on a part, which may not be the section id.
    const ed = sectionOwns(key, editing) ? editing : null;
    const cmp = sectionOwns(key, comparing) ? comparing : null;
    // While a part is being edited the figure is suppressed: for the merged
    // scenario section it restates the very prose in the textarea.
    const body = ed
      ? editorFor(ed)
      : (RENDER[key] ? RENDER[key]() : `<div class="report-prose">${paras(valueOf(key))}</div>`);
    return `
    <section class="report-section" data-section="${key}">
      <div class="sec-head">
        <h3>${esc(title)}</h3>
      </div>
      ${toolbar(key)}
      ${body}
      ${cmp ? comparePanel(cmp) : ""}
      ${ed ? "" : (fig[key] || "")}
      ${critiquesFor(key)}
    </section>`;
  }).join("");

  fillToolSlots($("repBody"));
  if (live) {
    const fresh = document.querySelector(`[data-editor="${CSS.escape(editing)}"]`);
    if (fresh && fresh !== live) fresh.replaceWith(live);
  }
  drawCharts(ctx);
  wireRail();
  document.querySelectorAll(".sc-block").forEach((b) => {
    const d = b.querySelector(".cla-wrap");
    if (d && folded.has(b.getAttribute("aria-label"))) d.open = false;
  });
  if (railIndex > 0) {
    const rail = document.querySelector(".sc-rail");
    const panel = rail?.querySelectorAll(".sc-block")[railIndex];
    if (panel) { rail.scrollLeft = panel.offsetLeft - rail.offsetLeft; markRailPosition(); }
  }
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
    get("/api/triangle/counts"),
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
    // Titles come from the published scenario, not the simulation snapshot:
    // the snapshot froze whatever the titles were when the run happened, so a
    // later rename would leave stale names on the chart.
    probabilityBars(odds, (c.sim.scenarios || []).map((s) => ({
      label: scenarioTitle(s.slug), sublabel: s.archetype, value: s.probability, color: ARCH_COLOR[s.archetype] || "#6B7264",
    })).concat([{ label: "No scenario fits", sublabel: "residual", value: c.sim.residual, color: "#8A8778" }]));
  }
  const tor = $("repTornado");
  if (tor) {
    const first = Object.keys(c.sim.tornado || {})[0];
    if (first) {
      tornado(tor, c.sim.tornado[first]);
      const cap = $("repTornadoCap");
      if (cap) cap.innerHTML = `Driver sensitivity for <strong>${esc(scenarioTitle(first))}</strong> — each driver's top third against its bottom third. Full set on the <a href="/simulation">simulation</a> page.`;
    }
  }
}

// ---------------- drawer (citation follow-through) ----------------

let drawerOpener = null;
function closeDrawer() {
  document.body.classList.remove("drawer-open");
  const dr = $("drawer");
  dr.inert = true;
  drawerOpener?.focus?.();
  drawerOpener = null;
}

async function openSignal(id, quote = "") {
  const dr = $("drawer");
  dr.dataset.quote = quote;
  drawerOpener = document.activeElement;
  dr.inert = false;
  dr.setAttribute("role", "dialog");
  dr.setAttribute("aria-modal", "true");
  dr.setAttribute("aria-label", `Signal ${id}`);
  dr.innerHTML = `<p class="caption" role="status">Loading signal ${esc(id)}…</p>`;
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
    dr.querySelector(".drawer-close")?.focus();
  } catch (e) {
    dr.innerHTML = `<button class="drawer-close" aria-label="Close">×</button><div class="error-note">${esc(e.message)}</div>`;
    dr.querySelector(".drawer-close")?.addEventListener("click", closeDrawer);
    dr.querySelector(".drawer-close")?.focus();
  }
}

document.addEventListener("click", (e) => {
  const pill = e.target.closest(".cite-pill");
  if (!pill) return;
  if (pill.dataset.sig) openSignal(pill.dataset.sig, pill.dataset.quote ? decodeURIComponent(pill.dataset.quote) : "");
  else if (pill.dataset.scenario) location.href = `/scenarios#${pill.dataset.scenario}`;
});

// ---------------- load / regenerate ----------------

async function load() {
  clearTimeout(timer);
  try {
    const [rep] = await Promise.all([api("/api/report"), loadContext()]);
    data = rep;
    failingQuotes = new Set(Object.values(rep.authored || {}).flatMap((a) => a.quotes?.failing || []));
    drawStatus();
    drawReport();
  } catch (e) {
    const st = $("repStatus");
    st.hidden = false;
    st.classList.add("is-error");
    st.textContent = `The report could not be loaded — ${humanErr(e.message)}. Retrying.`;
    timer = setTimeout(load, 4000);
    return;
  }
  if (data.generating) timer = setTimeout(poll, 2000);
}

// While a report is being written only the status is asked for. A full reload
// every two seconds rebuilt the page under the reader — and under an author
// mid-sentence. The page is rebuilt once, when the new report has landed.
async function poll() {
  clearTimeout(timer);
  try {
    const rep = await api("/api/report");
    const landed = rep.hash !== data?.hash || !!rep.report !== !!data?.report;
    if (landed || !rep.generating) return load();
    data = { ...data, generating: rep.generating, status: rep.status };
    drawStatus();
    timer = setTimeout(poll, 2000);
  } catch {
    timer = setTimeout(poll, 4000);
  }
}

$("regenerate").addEventListener("click", async () => {
  const btn = $("regenerate");
  btn.disabled = true;
  $("repState").textContent = "requesting…";
  try {
    await api("/api/report/regenerate", { method: "POST" });
    $("repState").textContent = "";
    clearTimeout(timer);
    timer = setTimeout(poll, 1500);
  } catch (e) {
    $("repState").textContent = humanErr(e.message);
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
  // Tall enough for whichever panel is about to arrive; the exact height is
  // set on landing.
  rail.style.height = Math.max(...[...rail.querySelectorAll(".sc-block")].map((p) => p.offsetHeight)) + 6 + "px";

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
  // The rail is as tall as the panel in view (plus its own bottom padding).
  if (panels[best]) rail.style.height = panels[best].offsetHeight + 6 + "px";
  document.querySelectorAll(".sc-dot").forEach((d, i) => {
    d.classList.toggle("here", i === best);
    if (i === best) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current");
  });
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
  // Folding a layer or reflowing text changes the panel's height; follow it.
  rail.addEventListener("toggle", markRailPosition, true);
  const ro = new ResizeObserver(markRailPosition);
  rail.querySelectorAll(".sc-block").forEach((p) => ro.observe(p));
  markRailPosition();
}

// ---------------- authoring interactions ----------------

const closeMenus = () => {
  document.querySelectorAll(".sec-modes").forEach((m) => (m.hidden = true));
  document.querySelectorAll("[data-menu][aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
};
// Focus follows the action: a rebuild would otherwise drop it on <body>.
const focusSel = (sel) => { const el = document.querySelector(sel); if (el) { el.focus(); return true; } return false; };
const focusPart = (part) => focusSel(`[data-edit="${CSS.escape(part)}"]`);
const focusEditor = (part) => focusSel(`[data-editor="${CSS.escape(part)}"] textarea, [data-editor="${CSS.escape(part)}"] input`);
// A dirty editor is never discarded silently.
const mayLeaveEditor = () => !dirty || confirm("You have unsaved changes here. Discard them?");
const leaveEditor = () => { editing = null; dirty = false; };

document.addEventListener("input", (e) => { if (e.target.closest("[data-editor]")) dirty = true; });
window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.body.classList.contains("drawer-open")) { closeDrawer(); return; }
  const open = document.querySelector(".sec-modes:not([hidden])");
  if (open) { closeMenus(); document.querySelector(`[aria-controls="${open.id}"]`)?.focus(); }
});

function collectEdit(key) {
  if (isScenarioPart(key)) {
    const out = {};
    document.querySelectorAll("[data-sc-field]").forEach((el) => { out[el.dataset.scField] = el.value.trim(); });
    return out;
  }
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

  if (t.dataset.edit) {
    if (editing !== t.dataset.edit && !mayLeaveEditor()) return;
    leaveEditor(); editing = t.dataset.edit; comparing = null; closeMenus(); drawReport(); focusEditor(editing); return;
  }
  if (t.dataset.compare) {
    if (!mayLeaveEditor()) return;
    const part = t.dataset.compare;
    comparing = comparing === part ? null : part; leaveEditor(); closeMenus(); drawReport(); focusSel(`[data-compare="${CSS.escape(part)}"]`); return;
  }
  if (t.dataset.keep) {
    const part = t.dataset.keep;
    try { await api(`/api/report/sections/${encodeURIComponent(part)}/keep`, { method: "POST" }); comparing = null; await load(); focusPart(part); }
    catch (err) { note(t, humanErr(err.message)); }
    return;
  }
  if (t.dataset.cancel !== undefined) {
    if (!mayLeaveEditor()) return;
    const part = t.dataset.cancel; leaveEditor(); drawReport(); focusPart(part); return;
  }

  if (t.dataset.save) {
    const key = t.dataset.save;
    const msg = t.closest(".sec-editor-actions").querySelector(".sec-msg");
    msg.textContent = "saving…";
    try {
      if (isScenarioPart(key)) {
        // Straight to the published row: this is the scenario itself, not a
        // report section overlaying a machine draft.
        const sc = scenarioOf(key);
        if (!sc) throw new Error("that scenario is no longer published");
        const patch = collectEdit(key);
        if (!patch.title) throw new Error("a scenario needs a title");
        t.disabled = true;
        await api(`/api/scenarios/${sc.id}`, { method: "PATCH", body: patch });
        leaveEditor();
        await load();
        focusPart(key);
        return;
      }
      t.disabled = true;
      for (const [k, text] of Object.entries(collectEdit(key))) {
        await api(`/api/report/sections/${encodeURIComponent(k)}`, { method: "PUT", body: { text } });
      }
      leaveEditor();
      await load();
      focusPart(key);
    } catch (err) {
      msg.textContent = humanErr(err.message);
      t.disabled = false;
      if (/could not be verified/.test(err.message)) checkQuotes(key);
    }
    return;
  }

  if (t.dataset.revert) {
    const part = t.dataset.revert;
    if (!confirm(`Discard your text for ${partName(part)} and go back to the machine draft?`)) return;
    try {
      await api(`/api/report/sections/${encodeURIComponent(part)}`, { method: "DELETE" });
      leaveEditor(); comparing = null;
      await load();
      focusPart(part);
    } catch (err) { note(t, humanErr(err.message)); }
    return;
  }

  // ---- critique ----
  if (t.dataset.menu) {
    const m = $("modes-" + t.dataset.menu);
    const wasHidden = m.hidden;
    closeMenus();
    m.hidden = !wasHidden;
    t.setAttribute("aria-expanded", String(!m.hidden));
    if (!m.hidden) m.querySelector(".sec-mode")?.focus();
    return;
  }

  if (t.dataset.critique) {
    const key = t.dataset.critique, mode = t.dataset.mode;
    closeMenus();
    pending[key] = { mode }; delete critError[key];
    drawReport();
    try {
      await api("/api/report/critique", { method: "POST", body: { section: key, mode } });
      delete pending[key];
      await load();
    } catch (err) {
      delete pending[key];
      critError[key] = humanErr(err.message);
      drawReport();
    }
    focusSel(`[data-menu="${CSS.escape(key)}"]`);
    return;
  }
  if (t.dataset.checkQuotes) { await checkQuotes(t.dataset.checkQuotes); return; }
  if (t.dataset.clearError) { delete critError[t.dataset.clearError]; drawReport(); focusSel(`[data-menu="${CSS.escape(t.dataset.clearError)}"]`); return; }

  if (t.dataset.addressed) {
    try { await api(`/api/report/critiques/${t.dataset.addressed}/addressed`, { method: "POST" }); await load(); }
    catch (err) { note(t, humanErr(err.message)); }
    return;
  }
  if (t.dataset.dismiss) {
    if (!confirm("Delete this critique? It cannot be recovered.")) return;
    try { await api(`/api/report/critiques/${t.dataset.dismiss}`, { method: "DELETE" }); await load(); }
    catch (err) { note(t, humanErr(err.message)); }
    return;
  }
  if (t.dataset.delFal !== undefined) { t.closest(".fal-row").remove(); return; }
  if (t.id === "addFalsifier") {
    $("falsifierRows").insertAdjacentHTML("beforeend", falsifierRow());
    return;
  }
});

// The verbatim gate, run by hand. Every "…" [S<id>] in the editor is looked up
// in that signal's retained source text; the verdicts are shown, nothing is
// saved or altered. The same list is shown when a save is refused for a
// quotation that does not match — the author sees which words, and why.
async function checkQuotes(part) {
  const box = document.querySelector(`[data-verdicts-for="${CSS.escape(part)}"]`);
  if (!box) return;
  box.innerHTML = `<p class="caption">Checking…</p>`;
  try {
    const text = Object.values(collectEdit(part)).join("\n\n");
    const r = await api("/api/quotes/check", { method: "POST", body: { text } });
    if (!r.checked) {
      box.innerHTML = `<p class="caption">No attributed quotations here — a quotation is words in double quotes followed directly by a citation, like "…" [S12]. ${r.corpus.toLocaleString()} signals have retained source text to check against.</p>`;
      return;
    }
    box.innerHTML = `<p class="caption">${r.checked} quotation${r.checked === 1 ? "" : "s"} checked, ${r.stripped} would be refused.</p>
      <ul class="qv">${r.verdicts.map((v) => `
        <li class="${v.ok ? "ok" : "fail"}">
          <span class="qv-mark">${v.ok ? "verified" : "not verified"}</span>
          <span class="qv-quote">"${esc(v.quote)}${v.quote.length >= 160 ? "…" : ""}"</span>
          <button type="button" class="cite-pill" data-sig="${v.signal_id}" aria-label="Open signal ${v.signal_id}">S${v.signal_id}</button>
          <span class="qv-why">${v.ok ? `matches the retained text at character ${v.start.toLocaleString()} · sha256 ${esc(v.sha256.slice(0, 12))}…` : esc(v.reason)}</span>
        </li>`).join("")}</ul>`;
  } catch (e) {
    box.innerHTML = `<div class="error-note">${esc(humanErr(e.message))}</div>`;
  }
}

// Actions without a message slot of their own say what went wrong beside the
// control that was pressed.
function note(btn, msg) {
  btn.parentElement?.querySelector(".sec-msg")?.remove();
  btn.insertAdjacentHTML("afterend", `<span class="sec-msg" role="status">${esc(msg)}</span>`);
}

renderNav("/report");
$("backdrop")?.addEventListener("click", closeDrawer);
$("drawer").inert = true;
load();
