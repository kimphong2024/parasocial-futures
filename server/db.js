// SQLite state — node:sqlite DatabaseSync, WAL, schema inline, prepared statements.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.STATE_DB || join(HERE, "..", "data", "state.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  url TEXT UNIQUE NOT NULL,
  source TEXT DEFAULT '',
  topic_tags TEXT DEFAULT '',
  cluster TEXT DEFAULT '',
  signal_type TEXT DEFAULT '',
  urgency TEXT DEFAULT '',
  horizon TEXT DEFAULT '',
  date TEXT DEFAULT '',
  year INTEGER,
  provenance TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  scan_run_id INTEGER,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_cluster ON signals(cluster);

CREATE TABLE IF NOT EXISTS embeddings (
  signal_id INTEGER PRIMARY KEY,
  vector BLOB NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenario_embeddings (
  scenario_id INTEGER PRIMARY KEY,
  vector BLOB NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'scrape',
  crawl_limit INTEGER NOT NULL DEFAULT 5,
  enabled INTEGER NOT NULL DEFAULT 1,
  notes TEXT DEFAULT '',
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  perplexity_candidates INTEGER NOT NULL DEFAULT 0,
  firecrawl_candidates INTEGER NOT NULL DEFAULT 0,
  new_pending INTEGER NOT NULL DEFAULT 0,
  dup_url INTEGER NOT NULL DEFAULT 0,
  dup_embedding INTEGER NOT NULL DEFAULT 0,
  rejected_relevance INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  archetype TEXT NOT NULL,
  horizon_year INTEGER NOT NULL DEFAULT 2040,
  summary TEXT DEFAULT '',
  litany TEXT DEFAULT '',
  systemic TEXT DEFAULT '',
  worldview TEXT DEFAULT '',
  myth TEXT DEFAULT '',
  narrative TEXT DEFAULT '',
  signal_ids TEXT NOT NULL DEFAULT '[]',
  driver_conditions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  dist_type TEXT NOT NULL DEFAULT 'pert',
  params_json TEXT NOT NULL,
  rationale TEXT DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  n_samples INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  drivers_snapshot TEXT NOT NULL,
  conditions_snapshot TEXT NOT NULL,
  results_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  question TEXT NOT NULL,
  cited_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS scan_themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  query TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
`);

// Guarded migrations for DBs created before a column existed (Railway volume
// persists across deploys, so CREATE TABLE IF NOT EXISTS never re-runs).
try { db.exec("ALTER TABLE scan_runs ADD COLUMN rejected_relevance INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
try { db.exec("ALTER TABLE scan_runs ADD COLUMN detail_json TEXT NOT NULL DEFAULT '{}'"); } catch { /* already migrated */ }
try { db.exec("ALTER TABLE drivers ADD COLUMN cluster_json TEXT NOT NULL DEFAULT '[]'"); } catch { /* already migrated */ }
try { db.exec("ALTER TABLE signals ADD COLUMN horizon_reasoning TEXT NOT NULL DEFAULT ''"); } catch { /* already migrated */ }
try { db.exec("ALTER TABLE signals ADD COLUMN horizon_judged_at TEXT"); } catch { /* already migrated */ }
try { db.exec("ALTER TABLE signals ADD COLUMN triangle TEXT"); } catch { /* already migrated */ }
try { db.exec("ALTER TABLE signals ADD COLUMN triangle_reasoning TEXT NOT NULL DEFAULT ''"); } catch { /* already migrated */ }

// One-time data migration: seed the evidence grouping for the shipped drivers
// from the clusters their rationales already name. Runs only while every
// driver's grouping is still empty, so human edits are never overwritten.
{
  const DRIVER_CLUSTERS = {
    companion_adoption: ["AI Companions", "Intimacy Economy", "Dating Reinvention", "Platform Strategy"],
    regulation_stringency: ["Governance Emerging", "Legal Reckoning", "Privacy & Surveillance", "Safety & Prosocial Design"],
    sycophancy_mitigation: ["AI Sycophancy", "AI Safety & Alignment", "Safety & Prosocial Design"],
    social_trust: ["Partnership Collapse", "Clinical & Public Health", "Male Loneliness & Friendship", "Culture & Discourse"],
    youth_norm_shift: ["Youth & Development", "Gaming & Virtual Worlds", "Fictosexuality & 2D-Love"],
    incident_severity: ["Legal Reckoning", "AI Romance Fraud", "Digital Resurrection & Grief"],
    substitution_vs_complement: ["Clinical & Public Health", "Relationship Services", "Arts, Ideas & Academy", "Sex Recession & Fertility"],
  };
  const unmapped = db.prepare("SELECT COUNT(*) AS n FROM drivers WHERE cluster_json != '[]'").get().n === 0;
  if (unmapped) {
    const put = db.prepare("UPDATE drivers SET cluster_json = ? WHERE key = ?");
    for (const [key, clusters] of Object.entries(DRIVER_CLUSTERS)) put.run(JSON.stringify(clusters), key);
  }
}

export const now = () => new Date().toISOString();

// ---- signals ----
const SIGNAL_COLS = "title, summary, url, source, topic_tags, cluster, signal_type, urgency, horizon, date, year, provenance, status, scan_run_id, raw_json, created_at, reviewed_at";
export const insertSignal = db.prepare(`INSERT INTO signals (${SIGNAL_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
export const getSignal = db.prepare("SELECT * FROM signals WHERE id = ?");
export const getSignalByUrl = db.prepare("SELECT id FROM signals WHERE url = ?");
export const countSignals = db.prepare("SELECT COUNT(*) AS n FROM signals");
export const countByStatus = db.prepare("SELECT COUNT(*) AS n FROM signals WHERE status = ?");
export const setSignalStatus = db.prepare("UPDATE signals SET status = ?, reviewed_at = ? WHERE id = ?");
export const setSignalHorizon = db.prepare("UPDATE signals SET horizon = ?, horizon_reasoning = ?, horizon_judged_at = ? WHERE id = ?");
export const approvedSignals = db.prepare("SELECT id, title, summary, cluster, signal_type, date, year, horizon FROM signals WHERE status = 'approved' ORDER BY id");
export const setSignalTriangle = db.prepare("UPDATE signals SET triangle = ?, triangle_reasoning = ? WHERE id = ?");
export const triangleSignals = db.prepare("SELECT id, title, cluster, signal_type, urgency, horizon, triangle, triangle_reasoning FROM signals WHERE status = 'approved' ORDER BY id");
export const triangleUnclassified = db.prepare("SELECT id, title, summary, cluster, signal_type FROM signals WHERE status = 'approved' AND (triangle IS NULL OR triangle = '') ORDER BY id");
export const pendingSignals = db.prepare("SELECT * FROM signals WHERE status = 'pending' ORDER BY created_at DESC, id DESC");

// Dynamic filtered list — returns { total, rows }.
export function querySignals({ q = "", cluster = "", type = "", urgency = "", horizon = "", status = "approved", provenance = "", sort = "newest", page = 1, limit = 60 }) {
  const where = [], params = [];
  if (status && status !== "all") { where.push("status = ?"); params.push(status); }
  if (cluster) { where.push("cluster = ?"); params.push(cluster); }
  if (type) { where.push("signal_type = ?"); params.push(type); }
  if (urgency) { where.push("urgency = ?"); params.push(urgency); }
  if (horizon) { where.push("horizon = ?"); params.push(horizon); }
  if (provenance) { where.push("provenance = ?"); params.push(provenance); }
  if (q) { where.push("(title LIKE ? OR summary LIKE ? OR topic_tags LIKE ? OR source LIKE ?)"); const like = `%${q}%`; params.push(like, like, like, like); }
  const W = where.length ? "WHERE " + where.join(" AND ") : "";
  const ORDER = { newest: "year DESC, date DESC, id DESC", oldest: "year ASC, date ASC, id ASC", urgency: "CASE urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, id DESC", title: "title COLLATE NOCASE ASC" }[sort] || "id DESC";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM signals ${W}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM signals ${W} ORDER BY ${ORDER} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  return { total, rows };
}

export function facets(status = "approved") {
  const W = status === "all" ? "" : "WHERE status = ?";
  const p = status === "all" ? [] : [status];
  const facet = (col) => db.prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM signals ${W} GROUP BY ${col} ORDER BY n DESC`).all(...p).filter((r) => r.v);
  return { cluster: facet("cluster"), signal_type: facet("signal_type"), urgency: facet("urgency"), horizon: facet("horizon"), provenance: facet("provenance") };
}

// ---- embeddings ----
export const upsertEmbedding = db.prepare("INSERT INTO embeddings (signal_id, vector, model, dim, created_at) VALUES (?,?,?,?,?) ON CONFLICT(signal_id) DO UPDATE SET vector=excluded.vector, model=excluded.model, dim=excluded.dim, created_at=excluded.created_at");
export const allEmbeddings = db.prepare("SELECT signal_id, vector, dim FROM embeddings");
export const signalsMissingEmbeddings = db.prepare("SELECT s.id, s.title, s.summary FROM signals s LEFT JOIN embeddings e ON e.signal_id = s.id WHERE e.signal_id IS NULL AND s.status IN ('approved','pending')");
export const upsertScenarioEmbedding = db.prepare("INSERT INTO scenario_embeddings (scenario_id, vector, model, dim, created_at) VALUES (?,?,?,?,?) ON CONFLICT(scenario_id) DO UPDATE SET vector=excluded.vector, model=excluded.model, dim=excluded.dim, created_at=excluded.created_at");
export const allScenarioEmbeddings = db.prepare("SELECT scenario_id, vector, dim FROM scenario_embeddings");

// ---- scan sources / runs ----
export const insertSource = db.prepare("INSERT INTO scan_sources (name, url, kind, crawl_limit, enabled, notes, created_at) VALUES (?,?,?,?,?,?,?)");
export const listSources = db.prepare("SELECT * FROM scan_sources ORDER BY id");
export const enabledSources = db.prepare("SELECT * FROM scan_sources WHERE enabled = 1 ORDER BY id");
export const getSource = db.prepare("SELECT * FROM scan_sources WHERE id = ?");
export const deleteSource = db.prepare("DELETE FROM scan_sources WHERE id = ?");
export const touchSource = db.prepare("UPDATE scan_sources SET last_run_at = ?, last_status = ? WHERE id = ?");

export const insertTheme = db.prepare("INSERT INTO scan_themes (key, query, enabled, created_at) VALUES (?,?,?,?)");
export const listThemes = db.prepare("SELECT * FROM scan_themes ORDER BY id");
export const enabledThemes = db.prepare("SELECT * FROM scan_themes WHERE enabled = 1 ORDER BY id");
export const deleteTheme = db.prepare("DELETE FROM scan_themes WHERE id = ?");
export const countThemes = db.prepare("SELECT COUNT(*) AS n FROM scan_themes");

// ---- settings (key-value; env vars remain the fallback defaults) ----
const settingGet = db.prepare("SELECT value FROM settings WHERE key = ?");
const settingPut = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
export const getSetting = (key, fallback = null) => settingGet.get(key)?.value ?? fallback;
export const setSetting = (key, value) => settingPut.run(key, String(value), now());

export const insertScanRun = db.prepare("INSERT INTO scan_runs (started_at, trigger) VALUES (?,?)");
export const finishScanRun = db.prepare("UPDATE scan_runs SET finished_at = ?, status = ?, perplexity_candidates = ?, firecrawl_candidates = ?, new_pending = ?, dup_url = ?, dup_embedding = ?, rejected_relevance = ?, errors_json = ?, detail_json = ? WHERE id = ?");
export const listScanRuns = db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 30");
export const deleteScanRun = db.prepare("DELETE FROM scan_runs WHERE id = ? AND status != 'running'");
export const getScanRun = db.prepare("SELECT * FROM scan_runs WHERE id = ?");
export const lastScanRun = db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1");

// ---- scenarios ----
export const insertScenario = db.prepare("INSERT INTO scenarios (slug, title, archetype, horizon_year, summary, litany, systemic, worldview, myth, narrative, signal_ids, driver_conditions, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
export const getScenario = db.prepare("SELECT * FROM scenarios WHERE id = ?");
export const listScenarios = db.prepare("SELECT * FROM scenarios ORDER BY CASE archetype WHEN 'growth' THEN 0 WHEN 'collapse' THEN 1 WHEN 'discipline' THEN 2 WHEN 'transformation' THEN 3 ELSE 4 END, id");
export const publishedScenarios = db.prepare("SELECT * FROM scenarios WHERE status = 'published' ORDER BY id");
export const draftScenarios = db.prepare("SELECT * FROM scenarios WHERE status = 'draft' ORDER BY id");

// ---- drivers / simulation ----
export const insertDriver = db.prepare("INSERT INTO drivers (key, name, description, unit, dist_type, params_json, rationale, enabled, sort_order, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
export const listDrivers = db.prepare("SELECT * FROM drivers ORDER BY sort_order, id");
export const enabledDrivers = db.prepare("SELECT * FROM drivers WHERE enabled = 1 ORDER BY sort_order, id");
export const getDriver = db.prepare("SELECT * FROM drivers WHERE id = ?");
export const countDrivers = db.prepare("SELECT COUNT(*) AS n FROM drivers");
export const deleteDriver = db.prepare("DELETE FROM drivers WHERE id = ?");
export const maxDriverOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM drivers");

export const insertSimRun = db.prepare("INSERT INTO simulation_runs (created_at, n_samples, seed, drivers_snapshot, conditions_snapshot, results_json, duration_ms) VALUES (?,?,?,?,?,?,?)");
export const listSimRuns = db.prepare("SELECT id, created_at, n_samples, seed, duration_ms FROM simulation_runs ORDER BY id DESC LIMIT 20");
export const getSimRun = db.prepare("SELECT * FROM simulation_runs WHERE id = ?");
export const lastSimRun = db.prepare("SELECT * FROM simulation_runs ORDER BY id DESC LIMIT 1");

// ---- chat log ----
export const logChat = db.prepare("INSERT INTO chat_log (ts, question, cited_ids) VALUES (?,?,?)");

// Generic column update against a whitelist — used by PATCH routes.
export function updateRow(table, id, patch, allowed) {
  const sets = [], params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (!sets.length) return false;
  db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  return true;
}
