// Futures of Parasocial AI — Node/Express API + static frontend.
// Signal library + live scanning + CLA scenarios + Monte Carlo + RAG chat.
import express from "express";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as d from "./db.js";
import { seedIfEmpty } from "../scripts/seed.js";
import { loadIndex, ensureEmbeddings, ensureScenarioEmbeddings, similarTo, topSignals, indexedCount } from "./vectors.js";
import { embedQuery, voyageEnabled } from "./voyage.js";
import { llmEnabled } from "./ai.js";
import { runScan, scanRunning, scanStep, scanSettings, DEFAULT_GATE } from "./scan.js";
import { judgeHorizons, horizonStatus } from "./horizons.js";
import { auditMiddleware } from "./audit.js";
import { classifyTriangle, classifyTriangleIfNeeded, triangleStatus, getWriteup, generateWriteup, regenerateWriteupIfStale, writeupStatus } from "./triangle.js";
import { startScheduler, scheduleInfo } from "./scheduler.js";
import { ARCHETYPES, draftScenario, embedScenario } from "./scenarios.js";
import { simulate, previewDistribution, makeSampler } from "./montecarlo.js";
import { chatHandler } from "./chat.js";
import { groupPendingQueue } from "./cluster.js";
import { enforceVerbatimDeep, verbatimCoverage, repairRetainedText } from "./quotes.js";
import { runBackfill, backfillStatus, abortBackfill, startBackfillDrainer } from "./backfill.js";
import { getReport, generateReport, reportStatus, reportComposition, canGenerate, authoredSections, sectionFingerprint } from "./report.js";
import { critiqueSection, MODES as CRITIQUE_MODES } from "./critique.js";
import { perplexityEnabled } from "./perplexity.js";
import { firecrawlEnabled } from "./firecrawl.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", 1);
app.use(auditMiddleware);

// The platform is fully open by design — no accounts, no password.
// Old /login links land on the app.
app.get("/login", (_req, res) => res.redirect("/signals"));
app.get("/", (_req, res) => res.sendFile(join(HERE, "public", "home.html")));
app.get("/transparency", (_req, res) => res.redirect(301, "/reference#transparency"));
app.get("/reference", (_req, res) => res.sendFile(join(HERE, "public", "reference.html")));

// Public counts for the home page annotations — numbers only, no content.
app.get("/api/public/stats", (_req, res) => {
  const last = d.lastScanRun.get();
  res.json({
    signals: d.countByStatus.get("approved").n,
    clusters: d.facets("approved").cluster.length,
    scenarios: d.publishedScenarios.all().length,
    lastScan: last?.finished_at?.slice(0, 10) || null,
  });
});

// ---------- meta ----------
app.get("/api/audit", (req, res) => res.json({ entries: d.listAudit.all(Math.min(500, +req.query.limit || 100)) }));
// Clearing the log is itself a logged action — the wipe leaves one entry
// recording who cleared it and how many entries went.
app.delete("/api/audit", (_req, res) => {
  const n = d.countAudit.get().n;
  d.clearAudit.run();
  res.json({ ok: true, removed: n });
});
app.get("/api/health", (_req, res) => {
  const last = d.lastScanRun.get();
  res.json({
    ok: true,
    signals: d.countSignals.get().n,
    approved: d.countByStatus.get("approved").n,
    pending: d.countByStatus.get("pending").n,
    scenarios: d.publishedScenarios.all().length,
    drafts: d.draftScenarios.all().length,
    embedded: indexedCount(),
    lastScan: last ? { id: last.id, status: last.status, finished_at: last.finished_at, new_pending: last.new_pending } : null,
    scanRunning: scanRunning(),
    scanStep: scanStep(),
    schedule: scheduleInfo(),
    integrations: { llm: llmEnabled(), voyage: voyageEnabled(), perplexity: perplexityEnabled(), firecrawl: firecrawlEnabled() },
  });
});

// ---------- signals ----------
app.get("/api/signals", (req, res) => {
  const page = Math.max(1, +req.query.page || 1);
  const limit = Math.min(200, +req.query.limit || 60);
  const { total, rows } = d.querySignals({
    q: (req.query.q || "").trim(), cluster: req.query.cluster || "", type: req.query.type || "",
    urgency: req.query.urgency || "", horizon: req.query.horizon || "", status: req.query.status || "approved",
    provenance: req.query.provenance || "", sort: req.query.sort || "newest", page, limit,
  });
  res.json({ total, page, limit, signals: rows });
});

app.get("/api/signals/facets", (req, res) => res.json(d.facets(req.query.status || "approved")));

// Signal relational graph: nodes = approved signals, edges = embedding
// nearest-neighbour pairs (the library as one connected field). Computed
// from the in-memory vector index and cached until the process restarts
// or the library count changes.
let graphCache = null;
// Radar payload: every approved signal + the drivers with their evidence
// clusters — the client maps signal.cluster to a driver slice.
app.get("/api/signals/radar", (_req, res) => {
  const signals = d.db.prepare("SELECT id, title, cluster, horizon, urgency FROM signals WHERE status = 'approved'").all();
  const drivers = d.db.prepare("SELECT id, key, name, cluster_json, sort_order FROM drivers WHERE enabled = 1 ORDER BY sort_order, id").all();
  res.json({ signals, drivers });
});

app.get("/api/signals/graph", (_req, res) => {
  const approved = d.db.prepare("SELECT id, title, cluster, horizon FROM signals WHERE status = 'approved'").all();
  if (graphCache && graphCache.n === approved.length) return res.json(graphCache.payload);
  const K = 4, MIN_W = 0.45;
  const ok = new Set(approved.map((s) => s.id));
  const edges = new Map();
  for (const s of approved) {
    for (const hit of similarTo(s.id, K + 4).filter((h) => ok.has(h.id)).slice(0, K)) {
      if (hit.score < MIN_W) continue;
      const key = s.id < hit.id ? `${s.id}-${hit.id}` : `${hit.id}-${s.id}`;
      if (!edges.has(key)) edges.set(key, { a: Math.min(s.id, hit.id), b: Math.max(s.id, hit.id), w: Math.round(hit.score * 100) / 100 });
    }
  }
  const payload = {
    nodes: approved.map((s) => ({ id: s.id, t: s.title.slice(0, 90), c: s.cluster, h: s.horizon || "H1" })),
    edges: [...edges.values()],
  };
  graphCache = { n: approved.length, payload };
  res.json(payload);
});

// Library composition for the overview charts: clusters, sources (long tail
// folded), provenance families.
app.get("/api/signals/overview", (_req, res) => {
  const f = d.facets("approved");
  const srcRows = d.db.prepare(`
    SELECT CASE WHEN TRIM(source) = '' THEN 'unattributed' ELSE TRIM(source) END AS s, COUNT(*) AS n
    FROM signals WHERE status = 'approved'
    GROUP BY LOWER(CASE WHEN TRIM(source) = '' THEN 'unattributed' ELSE TRIM(source) END)
    ORDER BY n DESC, s`).all();
  const TOP = 20;
  const top = srcRows.slice(0, TOP).map((r) => ({ v: r.s, n: r.n }));
  const other = srcRows.slice(TOP).reduce((a, r) => a + r.n, 0);
  res.json({
    total: d.countByStatus.get("approved").n,
    clusters: f.cluster,
    sources: { top, other, distinct: srcRows.length },
    provenance: f.provenance,
  });
});

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ signals: [] });
  if (!voyageEnabled()) return res.status(503).json({ error: "semantic search unavailable (VOYAGE_API_KEY unset)" });
  try {
    const qv = await embedQuery(q);
    const approved = new Set(d.db.prepare("SELECT id FROM signals WHERE status = 'approved'").all().map((r) => r.id));
    const hits = topSignals(qv, Math.min(60, +req.query.limit || 30), (id) => approved.has(id));
    res.json({ signals: hits.map((h) => ({ ...d.getSignal.get(h.id), score: Math.round(h.score * 1000) / 1000 })) });
  } catch (e) {
    console.error(e);
    res.status(503).json({ error: "search failed" });
  }
});

// Field notes: a free-text card the reviewer can attach to any signal.
app.patch("/api/signals/:id/note", (req, res) => {
  const row = d.getSignal.get(+req.params.id);
  if (!row) return res.status(404).json({ error: "signal not found" });
  const note = String(req.body?.note ?? "").trim().slice(0, 4000);
  const ts = note ? d.now() : null;
  d.setSignalNote.run(note, ts, row.id);
  res.json({ ok: true, note, note_updated_at: ts });
});

// The retained article behind a signal — the text a quotation is checked
// against. Fetched on demand rather than with the signal, because these run to
// tens of thousands of characters.
app.get("/api/signals/:id/text", (req, res) => {
  const row = d.getArticleText.get(+req.params.id);
  if (!row) {
    const a = d.getTextAttempt.get(+req.params.id);
    return res.status(404).json({
      error: "no source text retained for this signal",
      attempts: a?.attempts || 0,
      last_reason: a?.last_reason || null,
      given_up: !!a && a.next_try_at === null,
    });
  }
  res.json(row);
});

app.get("/api/signals/:id", (req, res) => {
  const s = d.getSignal.get(+req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  const similar = similarTo(s.id, 5).map((h) => ({ ...d.getSignal.get(h.id), score: Math.round(h.score * 1000) / 1000 }));
  const t = d.getArticleText.get(s.id);
  res.json({ ...s, similar, text_chars: t?.chars || 0, text_sha256: t?.sha256 || null });
});

// ---------- verbatim corpus backfill ----------
// Walks the library fetching source text the verbatim gate can check against.
// Resumable by construction: the queue is "signals with no retained text", so
// re-running continues where the last run stopped.
app.get("/api/quotes/coverage", (_req, res) => {
  const total = d.db.prepare("SELECT COUNT(*) AS n FROM signals WHERE url LIKE 'http%'").get().n;
  const have = d.countArticleText.get().n;
  const now = d.now();
  res.json({
    total, retained: have,
    missing: d.countMissingText.get().n,
    retryable: d.countRetryable.get(now).n,
    given_up: d.countGivenUp.get().n,
    status: backfillStatus(),
  });
});

app.post("/api/quotes/backfill", (req, res) => {
  if (backfillStatus().running) return res.status(409).json({ error: "a backfill is already running" });
  const limit = Math.min(500, Math.max(1, +req.body?.limit || 200));
  const useFirecrawl = req.body?.useFirecrawl !== false;
  runBackfill({ limit, useFirecrawl }).catch((e) => console.error("[backfill] failed:", e.message));
  res.json({ ok: true, started: true, limit, useFirecrawl });
});

app.post("/api/quotes/backfill/abort", (_req, res) => res.json({ ok: abortBackfill() }));

// Dry run of the verbatim gate over any text: every attributed quotation
// ("…" [S<id>]) is looked up in that signal's retained source text and the
// verdict returned, nothing stored, nothing stripped. This is how the gate is
// tested — by an author checking their own quotation before saving, or by
// anyone who wants to see it refuse a changed word.
app.post("/api/quotes/check", (req, res) => {
  const raw = req.body?.text;
  if (typeof raw !== "string" || !raw.trim()) return res.status(400).json({ error: "text required" });
  if (raw.length > 20000) return res.status(400).json({ error: "text too long" });
  let value = raw;
  try { const j = JSON.parse(raw); if (j && typeof j === "object") value = j; } catch { /* plain prose */ }
  const g = enforceVerbatimDeep(value, { record: false });
  res.json({ checked: g.checked, stripped: g.stripped, verdicts: g.verdicts, corpus: verbatimCoverage() });
});

// ---------- the live synthesis report ----------
// Reading never generates. Generation is a high-effort model call on a site
// with no auth, so it is a deliberate human action and rate-limited; a report
// whose inputs have moved reports itself as stale rather than silently
// refreshing at a reader's expense.
app.get("/api/report", (_req, res) => {
  const report = getReport();
  const comp = reportComposition();
  const critiques = {};
  for (const c of d.listCritiques.all()) {
    (critiques[c.section_key] ||= []).push({
      id: c.id, mode: c.mode, created_at: c.created_at, addressed_at: c.addressed_at,
      body: JSON.parse(c.body_json),
    });
  }
  res.json({
    report,
    authored: authoredSections(),
    critiques,
    modes: Object.fromEntries(Object.entries(CRITIQUE_MODES).map(([k, v]) => [k, v.label])),
    hash: comp.hash,
    inputs: comp.parts,
    stale: !!report && report.hash !== comp.hash,
    changed: report ? Object.keys(comp.parts).filter((k) => (report.inputs || {})[k] !== comp.parts[k]) : [],
    generating: reportStatus().generating,
    status: reportStatus(),
    available: llmEnabled(),
  });
});

// Which triangle force each scenario actually rests on. Computed from the
// scenarios' own citations crossed with the triangle classification of those
// signals — so the bridge from the triangle to the fork is derived, not an
// asserted mapping of corners onto archetypes.
app.get("/api/scenarios/triangle-mix", (_req, res) => {
  const corner = new Map(
    d.db.prepare("SELECT id, triangle FROM signals WHERE status = 'approved' AND triangle IS NOT NULL AND triangle != ''")
      .all().map((r) => [r.id, r.triangle]));
  const out = d.publishedScenarios.all().map((sc) => {
    let ids = [];
    try { ids = JSON.parse(sc.signal_ids || "[]"); } catch { /* malformed */ }
    const mix = { pull: 0, push: 0, weight: 0 };
    let classified = 0;
    for (const id of ids) {
      const c = corner.get(id);
      if (c && mix[c] !== undefined) { mix[c]++; classified++; }
    }
    return { slug: sc.slug, title: sc.title, archetype: sc.archetype, cited: ids.length, classified, mix };
  });
  res.json({ scenarios: out });
});

// ---------- authoring ----------
// Editing is the point: the model drafts, a human writes. Saving records which
// draft it was written against so a later regeneration can flag divergence
// rather than silently discarding the authored text.
app.put("/api/report/sections/:key", (req, res) => {
  const key = req.params.key;
  const raw = req.body?.text;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  if (!text.trim()) return res.status(400).json({ error: "text required" });
  if (text.length > 20000) return res.status(400).json({ error: "section too long" });
  // The verbatim gate applies to the author's words as much as the machine's:
  // the page promises that anything shown as a quotation matches retained
  // source text. A human's prose is not silently edited, though — the save is
  // refused with the verdicts, and the author decides.
  let value = text;
  try { const j = JSON.parse(text); if (j && typeof j === "object") value = j; } catch { /* prose */ }
  const g = enforceVerbatimDeep(value, { record: true });
  if (g.stripped) {
    return res.status(422).json({
      error: `${g.stripped} quotation${g.stripped === 1 ? "" : "s"} could not be verified against retained source text`,
      quotes: g.verdicts,
    });
  }
  // Record the machine draft this was written against, so a later
  // regeneration can be recognised as a new draft rather than guessed at.
  const draft = (getReport() || {})[key];
  d.putSectionEdit.run(key, text, reportComposition().hash, sectionFingerprint(draft), d.now());
  res.json({ ok: true, authored: authoredSections()[key], quotes: { checked: g.checked, verdicts: g.verdicts } });
});

// "I have read the new draft and I am keeping mine." Clears the flag without
// touching the authored text.
app.post("/api/report/sections/:key/keep", (req, res) => {
  const key = req.params.key;
  if (!d.getSectionEdit.get(key)) return res.status(404).json({ error: "nothing authored here" });
  const draft = (getReport() || {})[key];
  d.rebaseSectionEdit.run(reportComposition().hash, sectionFingerprint(draft), d.now(), key);
  res.json({ ok: true, authored: authoredSections()[key] });
});

app.delete("/api/report/sections/:key", (req, res) => {
  d.dropSectionEdit.run(req.params.key);
  res.json({ ok: true });
});

// ---------- critique ----------
app.post("/api/report/critique", async (req, res) => {
  const { section, mode } = req.body || {};
  if (!CRITIQUE_MODES[mode] && mode !== "signals") return res.status(400).json({ error: "unknown critique mode" });
  const report = getReport();
  if (!report) return res.status(400).json({ error: "no report to critique yet" });
  // A scenario is written text too, and it is the substance of the fork the
  // report turns on — but it lives in `scenarios`, not in the report draft,
  // so its subject is assembled from the row rather than looked up by key.
  let value, subject = null;
  if (section.startsWith("scenario:")) {
    const sc = d.publishedScenarios.all().find((r) => r.slug === section.slice(9));
    if (!sc) return res.status(404).json({ error: "unknown scenario" });
    subject = sc.title;
    value = [
      sc.summary && `Summary: ${sc.summary}`,
      sc.litany && `Litany (the visible surface): ${sc.litany}`,
      sc.systemic && `Systemic (the causes underneath): ${sc.systemic}`,
      sc.worldview && `Worldview: ${sc.worldview}`,
      sc.myth && `Myth/metaphor: ${sc.myth}`,
    ].filter(Boolean).join("\n\n");
  } else {
    const authored = authoredSections()[section];
    value = authored ? authored.value : report[section];
    if (value === undefined) return res.status(404).json({ error: "unknown section" });
  }
  // A short brief of the rest keeps the critique aware of the whole argument
  // without paying to send all of it. Human titles, not storage keys — the
  // model quotes these back, and "so_what_policy" in a critique reads as a
  // leaked internal.
  const TITLES = {
    headline: "Headline", state_of_evidence: "The state of the evidence",
    triangle_reading: "The triangle reading", scenario_space: "The scenario space",
    odds: "The odds", sensitivity: "Which levers decide it",
    what_would_change_our_mind: "What we're watching for",
    so_what_policy: "So what — for policy", so_what_industry: "So what — for industry",
  };
  const brief = Object.entries(report)
    .filter(([k, v]) => k !== section && TITLES[k] && typeof v === "string" && v.length > 40)
    .map(([k, v]) => `${TITLES[k]}: ${v.slice(0, 220)}…`).join("\n");
  try {
    const out = await critiqueSection({
      mode, sectionKey: section, value, brief,
      title: subject ? `The ${subject} scenario` : (TITLES[section] || section.replace(/_/g, " ")),
    });
    res.json({ ok: true, critique: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/report/critiques/:id/addressed", (req, res) => {
  d.markCritiqueAddressed.run(d.now(), +req.params.id);
  res.json({ ok: true });
});
app.delete("/api/report/critiques/:id", (req, res) => {
  d.deleteCritique.run(+req.params.id);
  res.json({ ok: true });
});

app.post("/api/report/regenerate", (_req, res) => {
  const gate = canGenerate();
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  generateReport().catch((e) => console.error("[report] generation failed:", e.message));
  res.json({ ok: true, started: true });
});

// ---------- review queue (human-in-the-loop gate) ----------
// Paged and cluster-filterable. The queue reached 1352 pending, at which
// point shipping every row to the browser and offering only "approve all"
// left no reviewable middle ground — see PRD §3.
app.get("/api/review/queue", (req, res) => {
  const limit = Math.min(200, Math.max(1, +req.query.limit || 40));
  const page = Math.max(1, +req.query.page || 1);
  const cluster = req.query.cluster || "";
  const { total, rows } = d.querySignals({ status: "pending", cluster, page, limit, sort: "newest" });
  const signals = rows.map((s) => {
    let nearest = null;
    try { nearest = JSON.parse(s.raw_json || "{}").nearest || null; } catch {}
    const near = nearest ? { ...d.getSignal.get(nearest.id), score: Math.round(nearest.score * 1000) / 1000 } : null;
    return { ...s, nearest: near };
  });
  res.json({
    total, page, limit, cluster,
    signals,
    facets: d.facets("pending"),
    scenario_drafts: d.draftScenarios.all(),
  });
});

// Batch decision. The unit of judgment is recorded (`basis`) so the audit
// trail says what the human actually reviewed — a cluster, a group, or a
// hand-picked selection — rather than implying 200 individual reads.
app.post("/api/review/batch", (req, res) => {
  const { ids, action, basis = "selection" } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids required" });
  if (ids.length > 500) return res.status(400).json({ error: "at most 500 ids per batch" });
  if (action !== "approve" && action !== "reject") return res.status(400).json({ error: "action must be approve or reject" });
  const ts = d.now();
  const status = action === "approve" ? "approved" : "rejected";
  let changed = 0;
  d.db.exec("BEGIN");
  try {
    for (const raw of ids) {
      const s = d.getSignal.get(+raw);
      if (!s || s.status !== "pending") continue;
      d.setSignalStatus.run(status, ts, s.id);
      changed++;
    }
    d.db.exec("COMMIT");
  } catch (e) {
    d.db.exec("ROLLBACK");
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, action, basis, requested: ids.length, changed });
});

// Group the queue by embedding proximity, so a reviewer can decide about a
// theme rather than a row. Cached on queue membership; the first call after a
// scan or a batch pays for the grouping.
app.get("/api/review/groups", async (_req, res) => {
  try {
    res.json(await groupPendingQueue());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/review/signals/:id/approve", (req, res) => {
  const s = d.getSignal.get(+req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  d.setSignalStatus.run("approved", d.now(), s.id);
  res.json({ ok: true });
});

app.post("/api/review/signals/:id/reject", (req, res) => {
  const s = d.getSignal.get(+req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  d.setSignalStatus.run("rejected", d.now(), s.id);
  res.json({ ok: true });
});

app.patch("/api/review/signals/:id", (req, res) => {
  const ok = d.updateRow("signals", +req.params.id, req.body || {}, ["title", "summary", "cluster", "signal_type", "urgency", "horizon", "topic_tags", "source", "date"]);
  res.json({ ok });
});

// ---------- horizon audit ----------
app.post("/api/horizons/judge", (_req, res) => {
  if (horizonStatus().running) return res.status(409).json({ error: "horizon audit already running" });
  judgeHorizons().then((r) => console.log("[horizons] audit finished:", JSON.stringify(r))).catch((e) => console.error("[horizons] audit crashed:", e.message));
  res.json({ ok: true, started: true });
});
app.get("/api/horizons/status", (_req, res) => res.json(horizonStatus()));

// ---------- futures triangle ----------
// The page's one-stop payload. Reading it also self-heals: unclassified
// approved signals kick an incremental classify, and a stale write-up kicks
// a background regeneration — both fire-and-forget.
// The report's standfirst wants three integers; the full route above ships
// every classified row plus the write-up and kicks reclassification. This is
// the cheap read the report page polls.
app.get("/api/triangle/counts", (_req, res) => {
  const rows = d.triangleSignals.all();
  const counts = { pull: 0, push: 0, weight: 0 };
  for (const r of rows) if (counts[r.triangle] !== undefined) counts[r.triangle]++;
  res.json({ counts, total: rows.length });
});

app.get("/api/triangle", (_req, res) => {
  const rows = d.triangleSignals.all();
  const corners = { pull: [], push: [], weight: [] };
  for (const r of rows) if (corners[r.triangle]) corners[r.triangle].push(r);
  const unclassified = rows.length - corners.pull.length - corners.push.length - corners.weight.length;
  const kicked = classifyTriangleIfNeeded();
  const writeupKicked = !kicked && regenerateWriteupIfStale();
  res.json({
    counts: { pull: corners.pull.length, push: corners.push.length, weight: corners.weight.length },
    corners,
    unclassified,
    total: rows.length,
    writeup: getWriteup(),
    classifying: triangleStatus().running || kicked,
    writing: writeupStatus().writing || writeupKicked,
  });
});
app.get("/api/triangle/status", (_req, res) => res.json({ ...triangleStatus(), ...writeupStatus() }));
app.post("/api/triangle/classify", (req, res) => {
  if (triangleStatus().running) return res.status(409).json({ error: "triangle classification already running" });
  classifyTriangle({ onlyMissing: req.body?.onlyMissing !== false })
    .then(() => regenerateWriteupIfStale())
    .catch((e) => console.error("[triangle] classify failed:", e.message));
  res.json({ ok: true, started: true });
});
// Human override: drag a signal to a different force on the configure board.
app.patch("/api/triangle/signals/:id", (req, res) => {
  const corner = req.body?.triangle;
  if (!["pull", "push", "weight"].includes(corner)) return res.status(400).json({ error: "triangle must be pull, push or weight" });
  const row = d.getSignal.get(+req.params.id);
  if (!row || row.status !== "approved") return res.status(404).json({ error: "approved signal not found" });
  const old = row.triangle || "unclassified";
  if (old === corner) return res.json({ ok: true, unchanged: true });
  d.setSignalTriangle.run(corner, `Reclassified ${old} → ${corner} by the reviewer.`, row.id);
  regenerateWriteupIfStale();
  res.json({ ok: true, from: old, to: corner });
});

app.post("/api/triangle/writeup", (_req, res) => {
  if (writeupStatus().writing) return res.status(409).json({ error: "write-up already generating" });
  generateWriteup().catch((e) => console.error("[triangle] writeup failed:", e.message));
  res.json({ ok: true, started: true });
});

// ---------- scanning ----------
app.post("/api/scan/run", (_req, res) => {
  if (scanRunning()) return res.status(409).json({ error: "scan already running" });
  const p = runScan("manual"); // async — fire and report
  p.then((r) => console.log("[scan] manual run finished:", r?.status ?? r?.reason)).catch((e) => console.error("[scan] manual run crashed:", e));
  res.json({ ok: true, started: true });
});
app.get("/api/scan/runs", (_req, res) => res.json({ runs: d.listScanRuns.all() }));
// Remove a run's record (aborted/failed housekeeping); in-flight runs refuse.
app.delete("/api/scan/runs/:id", (req, res) => {
  const n = d.deleteScanRun.run(+req.params.id).changes;
  res.status(n ? 200 : 409).json({ ok: !!n });
});
app.get("/api/scan/runs/:id", (req, res) => {
  const r = d.getScanRun.get(+req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

// ---------- scan sources ----------
app.get("/api/sources", (_req, res) => res.json({ sources: d.listSources.all() }));
app.post("/api/sources", (req, res) => {
  const { name, url, kind = "scrape", crawl_limit = 5, notes = "" } = req.body || {};
  if (!name || !/^https?:\/\//.test(url || "")) return res.status(400).json({ error: "name and valid url required" });
  const info = d.insertSource.run(name, url, kind === "crawl" ? "crawl" : "scrape", Math.min(20, +crawl_limit || 5), 1, notes, d.now());
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});
app.patch("/api/sources/:id", (req, res) => {
  const patch = { ...req.body };
  if ("enabled" in patch) patch.enabled = patch.enabled ? 1 : 0;
  const ok = d.updateRow("scan_sources", +req.params.id, patch, ["name", "url", "kind", "crawl_limit", "enabled", "notes"]);
  res.json({ ok });
});
app.delete("/api/sources/:id", (req, res) => { d.deleteSource.run(+req.params.id); res.json({ ok: true }); });

// ---------- sweep themes (the Perplexity leg's user-editable query set) ----------
app.get("/api/themes", (_req, res) => res.json({ themes: d.listThemes.all() }));
app.post("/api/themes", (req, res) => {
  const { key, query } = req.body || {};
  if (!/^[a-z0-9_]{2,40}$/.test(key || "")) return res.status(400).json({ error: "key must be snake_case (a-z, 0-9, _)" });
  if (!(query || "").trim()) return res.status(400).json({ error: "query text required" });
  try {
    const info = d.insertTheme.run(key, query.trim(), 1, d.now());
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: /UNIQUE/.test(e.message) ? "a theme with that key already exists" : e.message });
  }
});
app.patch("/api/themes/:id", (req, res) => {
  const patch = { ...req.body };
  if ("enabled" in patch) patch.enabled = patch.enabled ? 1 : 0;
  if ("query" in patch && !(patch.query || "").trim()) return res.status(400).json({ error: "query text required" });
  const ok = d.updateRow("scan_themes", +req.params.id, patch, ["key", "query", "enabled"]);
  res.json({ ok });
});
app.delete("/api/themes/:id", (req, res) => { d.deleteTheme.run(+req.params.id); res.json({ ok: true }); });

// ---------- scan settings (knobs + relevance gate; defaults from env/code) ----------
app.get("/api/scan/settings", (_req, res) =>
  res.json({ ...scanSettings(), gate_default: DEFAULT_GATE, schedule: scheduleInfo() }));
app.put("/api/scan/settings", (req, res) => {
  const b = req.body || {};
  if ("recency" in b && !["day", "week", "month"].includes(b.recency))
    return res.status(400).json({ error: "recency must be day, week or month" });
  if ("follow_limit" in b && !(Number.isInteger(+b.follow_limit) && +b.follow_limit >= 0 && +b.follow_limit <= 5))
    return res.status(400).json({ error: "follow_limit must be an integer 0-5" });
  if ("dedup_threshold" in b && !(+b.dedup_threshold >= 0.80 && +b.dedup_threshold <= 0.99))
    return res.status(400).json({ error: "dedup_threshold must be between 0.80 and 0.99" });
  if ("relevance_gate" in b && !(b.relevance_gate || "").trim())
    return res.status(400).json({ error: "relevance gate text cannot be empty" });
  for (const k of ["recency", "follow_limit", "dedup_threshold", "relevance_gate"])
    if (k in b) d.setSetting(k, k === "relevance_gate" ? b[k].trim() : b[k]);
  res.json({ ok: true, ...scanSettings() });
});

// ---------- artifacts from the future ----------
// Objects extrapolated from each published scenario. The set (including the
// verbatim image prompts) ships as a seed file so provenance is auditable.
let artifactCache = null;
app.get("/api/artifacts", (_req, res) => {
  if (!artifactCache) {
    try {
      artifactCache = JSON.parse(readFileSync(join(HERE, "seed", "artifacts.json"), "utf8"));
    } catch (e) {
      return res.status(503).json({ error: "artifact set unavailable" });
    }
  }
  const live = new Set(d.publishedScenarios.all().map((s) => s.archetype));
  res.json({ scenarios: artifactCache.filter((s) => live.has(s.archetype)) });
});

// ---------- scenarios ----------
app.get("/api/scenarios", (req, res) => {
  let rows = d.listScenarios.all();
  if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
  res.json({ scenarios: rows, archetypes: ARCHETYPES });
});
app.get("/api/scenarios/:id", (req, res) => {
  const sc = d.getScenario.get(+req.params.id);
  if (!sc) return res.status(404).json({ error: "not found" });
  const cited = JSON.parse(sc.signal_ids || "[]").map((id) => d.getSignal.get(id)).filter(Boolean);
  res.json({ ...sc, cited });
});
app.post("/api/scenarios/draft", async (req, res) => {
  if (!llmEnabled()) return res.status(503).json({ error: "ANTHROPIC_API_KEY unset" });
  try {
    const sc = await draftScenario({ archetype: req.body?.archetype, focus: req.body?.focus || "" });
    res.json(sc);
  } catch (e) {
    console.error("[scenarios] draft failed:", e);
    res.status(500).json({ error: e.message });
  }
});
app.patch("/api/scenarios/:id", (req, res) => {
  const patch = { ...req.body, updated_at: d.now() };
  if (patch.driver_conditions && typeof patch.driver_conditions !== "string") patch.driver_conditions = JSON.stringify(patch.driver_conditions);
  if (patch.signal_ids && typeof patch.signal_ids !== "string") patch.signal_ids = JSON.stringify(patch.signal_ids);
  const ok = d.updateRow("scenarios", +req.params.id, patch, ["title", "summary", "litany", "systemic", "worldview", "myth", "narrative", "signal_ids", "driver_conditions", "horizon_year", "archetype", "updated_at"]);
  res.json({ ok });
});
app.post("/api/scenarios/:id/publish", async (req, res) => {
  const sc = d.getScenario.get(+req.params.id);
  if (!sc) return res.status(404).json({ error: "not found" });
  d.updateRow("scenarios", sc.id, { status: "published", published_at: d.now(), updated_at: d.now() }, ["status", "published_at", "updated_at"]);
  try { await embedScenario(d.getScenario.get(sc.id)); } catch (e) { console.warn("[scenarios] embed failed:", e.message); }
  res.json({ ok: true });
});
app.post("/api/scenarios/:id/archive", (req, res) => {
  const ok = d.updateRow("scenarios", +req.params.id, { status: "archived", updated_at: d.now() }, ["status", "updated_at"]);
  res.json({ ok });
});
app.post("/api/scenarios/:id/restore", (req, res) => {
  const sc = d.getScenario.get(+req.params.id);
  if (!sc) return res.status(404).json({ error: "not found" });
  const ok = d.updateRow("scenarios", sc.id, { status: "draft", updated_at: d.now() }, ["status", "updated_at"]);
  res.json({ ok });
});

// ---------- drivers + simulation ----------
app.get("/api/drivers", (_req, res) => res.json({ drivers: d.listDrivers.all() }));
app.post("/api/drivers", (req, res) => {
  const { key, name, unit = "", description = "", rationale = "" } = req.body || {};
  if (!/^[a-z0-9_]{2,50}$/.test(key || "")) return res.status(400).json({ error: "key must be snake_case (a-z, 0-9, _)" });
  if (!(name || "").trim()) return res.status(400).json({ error: "name required" });
  try {
    const order = d.maxDriverOrder.get().m + 1;
    const info = d.insertDriver.run(key, name.trim(), description, unit, "pert", JSON.stringify({ min: 0, mode: 50, max: 100 }), rationale, 1, order, d.now());
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (e) {
    res.status(400).json({ error: /UNIQUE/.test(e.message) ? "a driver with that key already exists" : e.message });
  }
});
app.delete("/api/drivers/:id", (req, res) => {
  const dr = d.getDriver.get(+req.params.id);
  if (!dr) return res.status(404).json({ error: "not found" });
  // a driver referenced by a live scenario's conditions must not vanish
  const using = d.listScenarios.all()
    .filter((sc) => sc.status !== "archived")
    .filter((sc) => JSON.parse(sc.driver_conditions || "[]").some((c) => c.driver_key === dr.key))
    .map((sc) => sc.title);
  if (using.length) return res.status(400).json({ error: `still referenced by: ${using.join(", ")} — remove those conditions first` });
  d.deleteDriver.run(dr.id);
  res.json({ ok: true });
});
app.patch("/api/drivers/:id", (req, res) => {
  const patch = { ...req.body, updated_at: d.now() };
  if (patch.params_json) {
    let p;
    try { p = typeof patch.params_json === "string" ? JSON.parse(patch.params_json) : patch.params_json; }
    catch { return res.status(400).json({ error: "invalid params_json" }); }
    const dist = patch.dist_type || d.getDriver.get(+req.params.id)?.dist_type || "pert";
    if (["pert", "triangular"].includes(dist) && !(p.min <= p.mode && p.mode <= p.max)) return res.status(400).json({ error: "require min <= mode <= max" });
    if (dist === "uniform" && !(p.min <= p.max)) return res.status(400).json({ error: "require min <= max" });
    try { makeSampler(dist, p); } catch (e) { return res.status(400).json({ error: e.message }); }
    patch.params_json = JSON.stringify(p);
  }
  if ("enabled" in patch) patch.enabled = patch.enabled ? 1 : 0;
  if (patch.cluster_json && typeof patch.cluster_json !== "string") patch.cluster_json = JSON.stringify(patch.cluster_json);
  const ok = d.updateRow("drivers", +req.params.id, patch, ["name", "description", "unit", "dist_type", "params_json", "rationale", "enabled", "cluster_json", "sort_order", "updated_at"]);
  res.json({ ok });
});
app.get("/api/drivers/:id/preview", (req, res) => {
  const dr = d.getDriver.get(+req.params.id);
  if (!dr) return res.status(404).json({ error: "not found" });
  const dist = req.query.dist_type || dr.dist_type;
  const params = req.query.params ? req.query.params : dr.params_json;
  try { res.json({ histogram: previewDistribution(dist, params) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/simulation/run", (req, res) => {
  const drivers = d.enabledDrivers.all();
  const scenarios = d.publishedScenarios.all().map((sc) => ({ id: sc.id, slug: sc.slug, title: sc.title, archetype: sc.archetype, conditions: JSON.parse(sc.driver_conditions || "[]") }));
  if (!scenarios.length) return res.status(400).json({ error: "no published scenarios to simulate — publish scenarios first" });
  const n = Math.min(100000, Math.max(1000, +req.body?.n || 10000));
  const seed = Number.isFinite(+req.body?.seed) ? +req.body.seed : Math.floor(Math.random() * 1e9);
  const results = simulate({ drivers, scenarios, n, seed });
  const info = d.insertSimRun.run(d.now(), n, seed, JSON.stringify(drivers), JSON.stringify(scenarios), JSON.stringify(results), results.duration_ms);
  res.json({ run_id: Number(info.lastInsertRowid), ...results });
});
app.get("/api/simulation/runs", (_req, res) => res.json({ runs: d.listSimRuns.all() }));
app.get("/api/simulation/latest", (_req, res) => {
  const r = d.lastSimRun.get();
  if (!r) return res.json({ latest: null });
  res.json({ latest: { run_id: r.id, created_at: r.created_at, ...JSON.parse(r.results_json) } });
});
app.get("/api/simulation/runs/:id", (req, res) => {
  const r = d.getSimRun.get(+req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json({ run_id: r.id, created_at: r.created_at, ...JSON.parse(r.results_json) });
});

// ---------- chat ----------
app.post("/api/chat", chatHandler);

// ---------- static frontend ----------
app.use(express.static(join(HERE, "public")));
app.get("/signals", (_req, res) => res.sendFile(join(HERE, "public", "index.html")));
["report", "review", "scenarios", "scenario", "scenario-config", "simulation", "chat", "sources", "drivers", "driver-config", "map", "artifacts", "present", "triangle", "triangle-config", "activity", "radar"].forEach((p) =>
  app.get("/" + p, (_req, res) => res.sendFile(join(HERE, "public", p + ".html"))));

// ---------- boot ----------
seedIfEmpty();
try { repairRetainedText(); } catch (e) { console.warn("[quotes] repair skipped:", e.message); }
// Reconcile runs orphaned by a mid-scan deploy: a process that just booted
// cannot have a scan in flight, so any row still 'running' is aborted.
try {
  const n = d.db.prepare("UPDATE scan_runs SET status = 'aborted', finished_at = COALESCE(finished_at, ?), errors_json = '[\"process restarted mid-run (deploy) — marked aborted at boot\"]' WHERE status = 'running'").run(d.now()).changes;
  if (n) console.log(`[boot] reconciled ${n} orphaned scan run(s) -> aborted`);
} catch (e) { console.warn("[boot] scan-run reconciliation failed:", e.message); }
loadIndex();
ensureEmbeddings().then(() => ensureScenarioEmbeddings()).catch((e) => console.warn("[boot] embeddings incomplete:", e.message));
startScheduler();
// The verbatim corpus fills itself in the background, paused while a scan runs.
startBackfillDrainer(scanRunning);

app.listen(PORT, () => console.log(`[server] Futures of Parasocial AI on :${PORT}`));
