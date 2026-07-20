// Futures of Parasocial AI — Node/Express API + static frontend.
// Signal library + live scanning + CLA scenarios + Monte Carlo + RAG chat.
import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as d from "./db.js";
import { seedIfEmpty } from "../scripts/seed.js";
import { loadIndex, ensureEmbeddings, ensureScenarioEmbeddings, similarTo, topSignals, indexedCount } from "./vectors.js";
import { embedQuery, voyageEnabled } from "./voyage.js";
import { llmEnabled } from "./ai.js";
import { runScan, scanRunning, scanStep, scanSettings, DEFAULT_GATE } from "./scan.js";
import { judgeHorizons, horizonStatus } from "./horizons.js";
import { startScheduler, scheduleInfo } from "./scheduler.js";
import { ARCHETYPES, draftScenario, embedScenario } from "./scenarios.js";
import { simulate, previewDistribution, makeSampler } from "./montecarlo.js";
import { chatHandler } from "./chat.js";
import { perplexityEnabled } from "./perplexity.js";
import { firecrawlEnabled } from "./firecrawl.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const app = express();
app.use(express.json({ limit: "2mb" }));

// The platform is fully open by design — no accounts, no password.
// Old /login links land on the app.
app.get("/login", (_req, res) => res.redirect("/signals"));
app.get("/", (_req, res) => res.sendFile(join(HERE, "public", "home.html")));
app.get("/transparency", (_req, res) => res.sendFile(join(HERE, "public", "transparency.html")));
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

app.get("/api/signals/:id", (req, res) => {
  const s = d.getSignal.get(+req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  const similar = similarTo(s.id, 5).map((h) => ({ ...d.getSignal.get(h.id), score: Math.round(h.score * 1000) / 1000 }));
  res.json({ ...s, similar });
});

// ---------- review queue (human-in-the-loop gate) ----------
app.get("/api/review/queue", (_req, res) => {
  const pending = d.pendingSignals.all().map((s) => {
    let nearest = null;
    try { nearest = JSON.parse(s.raw_json || "{}").nearest || null; } catch {}
    const near = nearest ? { ...d.getSignal.get(nearest.id), score: Math.round(nearest.score * 1000) / 1000 } : null;
    return { ...s, nearest: near };
  });
  res.json({ signals: pending, scenario_drafts: d.draftScenarios.all() });
});

app.post("/api/review/approve-all", (_req, res) => {
  const pending = d.pendingSignals.all();
  const ts = d.now();
  for (const s of pending) d.setSignalStatus.run("approved", ts, s.id);
  res.json({ ok: true, approved: pending.length });
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

// ---------- scanning ----------
app.post("/api/scan/run", (_req, res) => {
  if (scanRunning()) return res.status(409).json({ error: "scan already running" });
  const p = runScan("manual"); // async — fire and report
  p.then((r) => console.log("[scan] manual run finished:", r?.status ?? r?.reason)).catch((e) => console.error("[scan] manual run crashed:", e));
  res.json({ ok: true, started: true });
});
app.get("/api/scan/runs", (_req, res) => res.json({ runs: d.listScanRuns.all() }));
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
["review", "scenarios", "scenario", "scenario-config", "simulation", "chat", "sources", "drivers", "driver-config"].forEach((p) =>
  app.get("/" + p, (_req, res) => res.sendFile(join(HERE, "public", p + ".html"))));

// ---------- boot ----------
seedIfEmpty();
loadIndex();
ensureEmbeddings().then(() => ensureScenarioEmbeddings()).catch((e) => console.warn("[boot] embeddings incomplete:", e.message));
startScheduler();

app.listen(PORT, () => console.log(`[server] Futures of Parasocial AI on :${PORT}`));
