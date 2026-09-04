// The live synthesis report.
//
// The platform can produce many lenses — a signal library, a futures triangle,
// four CLA scenarios, a Monte Carlo model, a RAG chat — and until now it left
// the reader to assemble the argument from them. This module writes the
// argument: one document that states what the evidence shows, what the
// triangle reads, where the scenario space sits, what the odds are, what would
// change our mind, and what follows for a decision-maker.
//
// It follows triangle.js's write-up pattern — a composition hash over the
// inputs, prose cached in `settings` — with one deliberate difference: reading
// the report NEVER generates it. Generation is a high-effort model call on a
// site with no auth, so it happens only when a human asks, and not more than
// once every MIN_INTERVAL_MS. A stale report says it is stale.

import { createHash } from "node:crypto";
import * as d from "./db.js";
import { askTool, llmEnabled } from "./ai.js";
import { getWriteup } from "./triangle.js";
import { enforceVerbatim, enforceVerbatimDeep, verbatimCoverage, quotablePassages } from "./quotes.js";

const REPORT_KEY = "live_report";
const MIN_INTERVAL_MS = 10 * 60 * 1000;

// ---------------- staleness ----------------

// Everything the report reads from. If any of it moves, the report is a
// description of a library that no longer exists.
export function reportComposition() {
  const approved = d.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS maxId FROM signals WHERE status = 'approved'").get();
  const scenarios = d.publishedScenarios.all().map((s) => `${s.id}:${s.updated_at || ""}`).join(",");
  const sim = d.lastSimRun.get();
  const drivers = d.db.prepare("SELECT COALESCE(MAX(updated_at), '') AS t FROM drivers").get().t;
  const tri = getWriteup();
  const parts = {
    signals: `${approved.n}/${approved.maxId}`,
    triangle: tri?.hash || "none",
    scenarios,
    simulation: sim ? String(sim.id) : "none",
    drivers,
  };
  const hash = createHash("sha1").update(Object.values(parts).join("|")).digest("hex").slice(0, 12);
  return { hash, parts, approvedCount: approved.n };
}

// The machine draft is never mutated. An authored section is stored beside it
// and wins on read; base_hash records which draft it was written against, so
// the page can say when the evidence has moved underneath it. Regeneration
// writes a new draft and leaves authored text alone — the same shape scenarios
// already use, where the model proposes and the human decides.
// A stable fingerprint of one machine section, whatever shape it holds.
export const sectionFingerprint = (v) =>
  v === undefined || v === null ? null
    : createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex").slice(0, 16);

export function authoredSections() {
  const comp = reportComposition();
  const report = getReport() || {};
  const out = {};
  for (const row of d.allSectionEdits.all()) {
    let value = row.text;
    try { const parsed = JSON.parse(row.text); if (parsed && typeof parsed === "object") value = parsed; } catch { /* plain prose */ }
    const nowSha = sectionFingerprint(report[row.section_key]);
    out[row.section_key] = {
      value,
      updated_at: row.updated_at,
      base_hash: row.base_hash,
      base_text_sha: row.base_text_sha,
      // Sections saved before the gate covered authored text may carry a
      // quotation that would not pass. The page marks those honestly rather
      // than presenting every quotation as verified.
      quotes: (() => {
        const g = enforceVerbatimDeep(value, { record: false });
        return { checked: g.checked, stripped: g.stripped, failing: g.verdicts.filter((v) => !v.ok).map((v) => v.quote) };
      })(),
      // The question is whether the machine draft has changed since this was
      // written, not whether the evidence has. Regeneration rewrites the prose
      // without necessarily moving the evidence hash, so comparing the draft
      // text is the only thing that actually answers it.
      draft_moved: !!row.base_text_sha && !!nowSha && row.base_text_sha !== nowSha,
      evidence_moved: !!row.base_hash && row.base_hash !== comp.hash,
    };
  }
  return out;
}

export function getReport() {
  try { return JSON.parse(d.getSetting(REPORT_KEY, "null")); } catch { return null; }
}

let generating = false;
let lastStartedAt = 0;

// Generation is one long model call with real work either side of it. A bare
// "generating" boolean told a reader nothing for two minutes, and a failure
// was indistinguishable from nothing having happened — the error only reached
// the server console while the page went on showing the previous report.
let progress = { stage: null, note: "", startedAt: 0, ms: 0, error: null, failed_at: null };

// SDK errors arrive as "401 {…json…}". A reader needs the sentence inside,
// not the envelope.
function humanError(e) {
  const raw = String(e?.message || e || "unknown error");
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const msg = j?.error?.message || j?.message;
      if (msg) {
        const code = (raw.match(/^\s*(\d{3})/) || [])[1];
        return code ? `${msg} (HTTP ${code})` : msg;
      }
    } catch { /* fall through to the raw text */ }
  }
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

const setStage = (stage, note = "") => {
  progress.stage = stage;
  progress.note = note;
  console.log(`[report] ${stage}${note ? " — " + note : ""}`);
};

export const reportStatus = () => ({
  generating,
  lastStartedAt,
  stage: progress.stage,
  note: progress.note,
  elapsed_ms: generating && progress.startedAt ? Date.now() - progress.startedAt : progress.ms,
  error: progress.error,
  failed_at: progress.failed_at,
});

// Checked by the route before it fires generation off, so the rate limit can
// be answered with a real 429 rather than disappearing into a background
// promise the client never hears about.
export function canGenerate() {
  if (generating) return { ok: false, status: 409, error: "a report is already generating" };
  if (!llmEnabled()) return { ok: false, status: 503, error: "ANTHROPIC_API_KEY unset" };
  const since = Date.now() - lastStartedAt;
  if (lastStartedAt && since < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - since) / 60000);
    return { ok: false, status: 429, error: `a report was generated ${Math.round(since / 60000)} minutes ago — try again in ${wait} minute${wait === 1 ? "" : "s"}` };
  }
  return { ok: true };
}

// ---------------- the evidence pack ----------------

// Stratified so no cluster dominates the model's attention, with critical and
// long-horizon signals force-included — the same discipline scenarios.js uses
// when it builds a drafting pack.
function evidencePack(limit = 120) {
  const rows = d.db.prepare(
    "SELECT id, title, summary, cluster, signal_type, urgency, horizon, source, date FROM signals WHERE status = 'approved' ORDER BY id DESC"
  ).all();
  const byCluster = new Map();
  for (const r of rows) {
    if (!byCluster.has(r.cluster)) byCluster.set(r.cluster, []);
    byCluster.get(r.cluster).push(r);
  }
  const perCluster = Math.max(2, Math.floor(limit / Math.max(1, byCluster.size)));
  const picked = new Map();
  for (const [, list] of byCluster) {
    for (const r of list.slice(0, perCluster)) picked.set(r.id, r);
  }
  for (const r of rows) {
    if (picked.size >= limit) break;
    if (r.urgency === "critical" || r.horizon === "H3") picked.set(r.id, r);
  }
  return [...picked.values()].slice(0, limit);
}

function overview() {
  const clusters = d.db.prepare("SELECT cluster AS v, COUNT(*) AS n FROM signals WHERE status='approved' GROUP BY cluster ORDER BY n DESC").all();
  const sources = d.db.prepare("SELECT source AS v, COUNT(*) AS n FROM signals WHERE status='approved' GROUP BY source ORDER BY n DESC LIMIT 12").all();
  const horizons = d.db.prepare("SELECT horizon AS v, COUNT(*) AS n FROM signals WHERE status='approved' GROUP BY horizon ORDER BY n DESC").all();
  const urgency = d.db.prepare("SELECT urgency AS v, COUNT(*) AS n FROM signals WHERE status='approved' GROUP BY urgency ORDER BY n DESC").all();
  const pending = d.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE status='pending'").get().n;
  return { clusters, sources, horizons, urgency, pending };
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

function buildPrompt() {
  const ov = overview();
  const tri = getWriteup();
  const scenarios = d.publishedScenarios.all();
  const sim = d.lastSimRun.get();
  const results = sim ? JSON.parse(sim.results_json || "{}") : null;
  const drivers = d.enabledDrivers.all();
  const pack = evidencePack();

  const lines = [];
  lines.push(`LIBRARY — ${ov.clusters.reduce((n, c) => n + c.n, 0)} approved signals across ${ov.clusters.length} clusters.`);
  lines.push(`Clusters: ${ov.clusters.slice(0, 14).map((c) => `${c.v} (${c.n})`).join(", ")}.`);
  lines.push(`Horizons: ${ov.horizons.map((h) => `${h.v} ${h.n}`).join(", ")}. Urgency: ${ov.urgency.map((u) => `${u.v} ${u.n}`).join(", ")}.`);
  lines.push(`Most productive sources: ${ov.sources.slice(0, 8).map((s) => `${s.v} (${s.n})`).join(", ")}.`);
  if (ov.pending) lines.push(`NOTE: ${ov.pending} scanned signals are still awaiting human review and are NOT in the figures above.`);

  if (tri) {
    lines.push(`\nFUTURES TRIANGLE (already synthesized from ${tri.signal_count} classified signals — pull ${tri.counts.pull}, push ${tri.counts.push}, weight ${tri.counts.weight}):`);
    lines.push(`Pull: ${tri.pull}`);
    lines.push(`Push: ${tri.push}`);
    lines.push(`Weight: ${tri.weight}`);
    lines.push(`Tension: ${tri.tension}`);
  }

  if (scenarios.length) {
    lines.push(`\nPUBLISHED SCENARIOS (cite as [SC:slug]):`);
    for (const s of scenarios) {
      lines.push(`[SC:${s.slug}] ${s.title} (${s.archetype}, ${s.horizon_year}) — ${s.summary}`);
      lines.push(`  litany: ${s.litany}`);
      lines.push(`  systemic: ${s.systemic}`);
      lines.push(`  worldview: ${s.worldview}`);
      lines.push(`  myth: ${s.myth}`);
    }
  }

  if (results) {
    lines.push(`\nSIMULATION (run ${sim.id}, ${results.n} samples, seed ${results.seed}):`);
    for (const s of results.scenarios || []) lines.push(`  ${s.title} (${s.archetype}): ${pct(s.probability)}`);
    lines.push(`  RESIDUAL — sampled futures matching no scenario: ${pct(results.residual)}. This must be stated in the odds section; it is the honest measure of what the archetypes do not cover.`);
    const tor = results.tornado || {};
    for (const [slug, rows] of Object.entries(tor).slice(0, 4)) {
      lines.push(`  sensitivity for ${slug}: ${rows.slice(0, 4).map((r) => `${r.name} ${r.delta >= 0 ? "+" : ""}${pct(r.delta)}`).join(", ")}`);
    }
  } else {
    lines.push(`\nSIMULATION: no run recorded yet — say so rather than inventing odds.`);
  }

  if (drivers.length) {
    lines.push(`\nDRIVERS (human-set ranges, not measurements):`);
    for (const dr of drivers) lines.push(`  ${dr.name} (${dr.unit}) — ${dr.dist_type} ${dr.params_json}. Rationale: ${dr.rationale || "—"}`);
  }

  // Signals whose source text is retained are the only ones that can be
  // quoted: the gate has nothing to check a quotation against otherwise.
  const withText = new Set(d.db.prepare("SELECT signal_id FROM article_text").all().map((r) => r.signal_id));
  lines.push(`\nEVIDENCE — cite these as [S<id>]. Only these ids exist. Where a signal carries a QUOTABLE line, that is an exact sentence from its retained source text and the only words that may be placed inside quotation marks:`);
  for (const s of pack) {
    const line = `[S${s.id}] (${s.cluster} · ${s.signal_type} · ${s.urgency} · ${s.horizon}) ${s.title} — ${s.summary} (${s.source}${s.date ? ", " + s.date : ""})`;
    const qp = withText.has(s.id) ? quotablePassages(s.id, `${s.title} ${s.summary}`, { n: 1, maxLen: 200 }) : [];
    lines.push(qp.length ? `${line}\n    QUOTABLE: "${qp[0]}"` : line);
  }

  return { prompt: lines.join("\n"), allowedSignalIds: new Set(pack.map((s) => s.id)), allowedSlugs: new Set(scenarios.map((s) => s.slug)) };
}

// ---------------- generation ----------------

// Two blank-line-separated paragraphs per section. Asked for explicitly
// because a single 150-word block renders as a wall; the client can only
// split at sentence boundaries after the fact, and a 110-word sentence
// cannot be split at all without fracturing it.
const SECTION = (desc, words) => ({
  type: "string",
  description: `${desc} About ${words} words, written as two or three paragraphs separated by a blank line. Vary sentence length — a 100-word sentence is unreadable however it is set. Cite with [S<id>] and [SC:<slug>].`,
});

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One sentence, 20-30 words: the single thing this library currently says about parasocial AI by 2040. No hedging verbs like 'explores' or 'examines'." },
    state_of_evidence: SECTION("What the reviewed library actually shows — where the evidence is thick, where it is thin, and what the source concentration means for confidence.", 180),
    triangle_reading: SECTION("The triangle reading. Use the synthesis already provided; do not re-derive it from the signals. Close by naming the fork this balance implies — which way the evidence would have to break for each kind of future — so the section hands off to the scenarios that follow rather than stopping.", 170),
    scenario_space: SECTION("The four archetypes and what genuinely separates them — the fork, not the summary. The reader has just seen which triangle force each scenario rests on, so build on that rather than restating the archetypes.", 200),
    odds: SECTION("What the simulation says, stated as a conditional artifact of human-set ranges rather than a forecast. MUST state the residual and what it means.", 150),
    // This section now sits before the scenarios and the odds, so it cannot
    // lean on probabilities the reader has not reached.
    sensitivity: SECTION("The drivers: what the model actually varies, and which of them carry the outcome. Name the two or three that dominate and the ones that turn out not to matter. Write this so it stands on its own — the scenarios and their probabilities have NOT been introduced yet, so refer to outcomes in general terms rather than quoting percentages for named scenarios.", 150),
    // Structured rather than prose: these two were the only sections with no
    // shape to lay out, and a falsifier list and an audience split are both
    // genuinely structured content being flattened into paragraphs.
    what_would_change_our_mind: {
      type: "array",
      description: "Four to six falsifiers — specific, watchable developments that would change the reading.",
      items: {
        type: "object",
        properties: {
          watch: { type: "string", description: "The observable itself, 6-12 words, concrete enough to actually watch for. No hedging." },
          direction: { type: "string", enum: ["strengthens", "weakens"], description: "Whether observing this strengthens or weakens the current reading" },
          meaning: { type: "string", description: "One sentence on what it would imply. Cite with [S<id>] or [SC:<slug>] where the evidence supports it." },
        },
        required: ["watch", "direction", "meaning"],
      },
    },
    // Two flat fields rather than a nested object: asked for as an object, the
    // model returned a single string and satisfied the schema anyway — tool
    // inputs are not hard-validated, so a shape the model reliably produces
    // beats a tidier one it ignores.
    so_what_policy: SECTION("Implications for public-policy makers working on AI governance: what follows, and which lever actually moves. Do not address industry here.", 110),
    so_what_industry: SECTION("Implications for strategy and trust teams inside AI companies: what follows, including where the same evidence cuts against them. Do not address policymakers here.", 110),
  },
  required: ["headline", "state_of_evidence", "triangle_reading", "scenario_space", "odds", "sensitivity", "what_would_change_our_mind", "so_what_policy", "so_what_industry"],
};

const SYSTEM = `You write the live synthesis report for "Futures of Parasocial AI", a foresight instrument on how AI reshapes human social relations by 2040, built from a human-reviewed signal library.

House voice: measured, literate, observational. Comfortable with uncertainty — "plausible", "emerging", "a weak signal suggests". No hype, no exclamation marks, no emoji, no marketing register. The reader's intelligence is respected.

Rules that are not negotiable:
- Every substantive claim carries a citation: [S<id>] for a signal, [SC:<slug>] for a scenario. Cite only ids present in the evidence provided. Inventing an id is worse than making no claim.
- Quotation marks are a claim to have reproduced a source's exact words. Quote ONLY a signal's QUOTABLE line, copied exactly (a contiguous part of it is fine), in double quotes immediately followed by the citation. Never put summary text or your own words inside quotation marks — every quotation is checked word-for-word against the retained source and removed if it does not match. One or two exact quotations per section, where a source's own phrasing carries the point, are worth more than none.
- Probabilities are conditional artifacts of human-set driver ranges and hand-shaped scenario conditions. Never call them forecasts or predictions.
- Where the evidence is thin, say so. Where the library leans (English-language, Western media), say so.
- The report is an argument, not a tour. It should be readable top to bottom by someone who never clicks through to the underlying pages.`;

// Anti-hallucination guard, mirroring the citation filter in scenarios.js:
// citations the evidence pack does not contain are removed after generation
// rather than trusted.
function stripUnknownCitations(text, allowedSignalIds, allowedSlugs) {
  if (typeof text !== "string") return { text, dropped: 0 };
  let dropped = 0;
  let out = text.replace(/\[S(\d+)\]/g, (m, id) => {
    if (allowedSignalIds.has(+id)) return m;
    dropped++;
    return "";
  });
  out = out.replace(/\[SC:([a-z0-9-]+)\]/gi, (m, slug) => {
    if (allowedSlugs.has(slug)) return m;
    dropped++;
    return "";
  });
  return { text: out.replace(/ {2,}/g, " ").replace(/ ([,.;])/g, "$1"), dropped };
}

export async function generateReport() {
  const gate = canGenerate();
  if (!gate.ok) {
    const err = new Error(gate.error);
    err.status = gate.status;
    throw err;
  }

  generating = true;
  lastStartedAt = Date.now();
  progress = { stage: null, note: "", startedAt: Date.now(), ms: 0, error: null, failed_at: null };
  try {
    setStage("assembling the evidence");
    const { prompt, allowedSignalIds, allowedSlugs } = buildPrompt();
    setStage("writing", `${allowedSignalIds.size} signals in the evidence pack`);
    const out = await askTool({
      system: SYSTEM,
      prompt: `${prompt}\n\nWrite the report.`,
      toolName: "write_report",
      schema: REPORT_SCHEMA,
      maxTokens: 12000,
      effort: "high",
    });

    setStage("checking citations");
    let dropped = 0, quotesChecked = 0, quotesStripped = 0;
    const quoteDetails = [];

    // Sections are no longer all flat strings — what_would_change_our_mind is
    // an array of objects and so_what is a pair. Both gates walk the whole
    // structure, otherwise a citation inside a nested field would skip them.
    const clean = (value) => {
      if (typeof value === "string") {
        const r = stripUnknownCitations(value, allowedSignalIds, allowedSlugs);
        dropped += r.dropped;
        // Second gate: anything presented as a quotation must be found
        // verbatim in retained source text, or the words come out and only
        // the citation stays. Deterministic, and it fails closed.
        const q = enforceVerbatim(r.text);
        quotesChecked += q.checked;
        quotesStripped += q.stripped;
        quoteDetails.push(...q.details);
        return q.text;
      }
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
      }
      return value;
    };

    const sections = {};
    for (const k of Object.keys(REPORT_SCHEMA.properties)) sections[k] = clean(out[k]);
    if (dropped) console.warn(`[report] stripped ${dropped} citation(s) not present in the evidence pack`);
    if (quotesStripped) console.warn(`[report] stripped ${quotesStripped}/${quotesChecked} unverifiable quotation(s)`, quoteDetails);

    setStage("saving");
    const comp = reportComposition();
    const record = {
      ...sections,
      hash: comp.hash,
      inputs: comp.parts,
      updated_at: d.now(),
      signal_count: comp.approvedCount,
      evidence_ids: [...allowedSignalIds],
      citations_dropped: dropped,
      quotes_checked: quotesChecked,
      quotes_stripped: quotesStripped,
      verbatim_corpus: verbatimCoverage(),
    };
    d.setSetting(REPORT_KEY, JSON.stringify(record));
    setStage("done");
    return record;
  } catch (e) {
    // Kept so the page can say what went wrong instead of silently showing
    // the previous report as though nothing had been asked for.
    progress.error = humanError(e);
    progress.failed_at = d.now();
    progress.stage = "failed";
    throw e;
  } finally {
    generating = false;
    progress.ms = progress.startedAt ? Date.now() - progress.startedAt : 0;
  }
}
