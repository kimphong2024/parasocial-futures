// Seed the database from the capstone signal-scan CSV (705 signals, pre-vetted
// → status 'approved'), plus the 7 Monte Carlo drivers and starter Firecrawl
// sources. Idempotent: each block only runs when its table is empty, so this is
// safe to call on every boot (fresh Railway volume seeds itself).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db, now, insertSignal, countSignals, countDrivers, insertDriver, insertSource, listSources, insertScenario, insertTheme, countThemes } from "../server/db.js";
import { DEFAULT_THEMES } from "../server/perplexity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(HERE, "..", "server", "seed", "ai_relationships_signal_scan_combined.csv");

// Minimal RFC-4180 parser — the CSV contains quoted fields with commas.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function seedSignals() {
  if (countSignals.get().n > 0) return 0;
  if (!existsSync(CSV_PATH)) { console.warn("[seed] CSV not found at", CSV_PATH); return 0; }
  const rows = parseCSV(readFileSync(CSV_PATH, "utf8"));
  const header = rows.shift();
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const ts = now();
  let n = 0;
  const insertAll = db.prepare("BEGIN");
  insertAll.run();
  try {
    for (const r of rows) {
      const get = (k) => (r[col[k]] || "").trim();
      const url = get("url");
      if (!get("title") || !url) continue;
      try {
        insertSignal.run(
          get("title"), get("summary"), url, get("source"), get("topic_tags"),
          get("cluster"), get("signal_type"), get("urgency"), get("horizon"),
          get("date"), get("year") ? Number(get("year")) : null,
          get("provenance"), "approved", null, null, ts, ts,
        );
        n++;
      } catch (e) {
        if (!/UNIQUE/.test(e.message)) throw e; // duplicate url in CSV → skip
      }
    }
    db.prepare("COMMIT").run();
  } catch (e) {
    db.prepare("ROLLBACK").run();
    throw e;
  }
  return n;
}

// Seven key uncertainties for 2040, PERT-parameterised. Ranges are evidence-informed
// starting judgments — the whole point is that they are editable in the driver UI.
const DRIVERS = [
  { key: "companion_adoption", name: "AI companion adoption", unit: "% of adults", description: "Share of adults worldwide with a regular AI companion relationship (daily or near-daily parasocial use) by 2040.", params: { min: 5, mode: 22, max: 60 }, rationale: "AI Companions cluster: Replika/Character.AI scale signals, dating-app exodus, youth adoption rates trending upward across waves." },
  { key: "regulation_stringency", name: "Regulation stringency", unit: "index 0-100", description: "How binding and enforced parasocial-AI governance is by 2040 (0 = laissez-faire, 100 = strict licensing and design mandates).", params: { min: 15, mode: 45, max: 85 }, rationale: "Governance Emerging cluster: minors-protection bills, addictive-design litigation, EU AI Act companion provisions." },
  { key: "sycophancy_mitigation", name: "Sycophancy mitigation", unit: "index 0-100", description: "Technical and design maturity of countermeasures against engineered agreeableness and engagement-optimised attachment.", params: { min: 20, mode: 55, max: 90 }, rationale: "AI Sycophancy cluster: lab safety research, model-behaviour standards, platform incentive critiques." },
  { key: "social_trust", name: "Interpersonal social trust", unit: "index 0-100", description: "General trust between people (not in AI) — the substrate parasocial AI either erodes or backfills by 2040.", params: { min: 20, mode: 45, max: 70 }, rationale: "Partnership Collapse and Clinical & Public Health clusters: loneliness epidemic data, declining marriage/dating conversion." },
  { key: "youth_norm_shift", name: "Youth normalisation", unit: "% of under-25s", description: "Share of under-25s who consider an AI relationship a normal part of social life by 2040.", params: { min: 15, mode: 40, max: 75 }, rationale: "Youth & Development cluster: adolescent companion use studies, school policy debates, generational attitude surveys." },
  { key: "incident_severity", name: "Crisis and incident pressure", unit: "index 0-100", description: "Cumulative severity of harms attributed to parasocial AI (deaths, fraud waves, mass grief events) shaping public reaction.", params: { min: 10, mode: 40, max: 90 }, rationale: "Crisis/legal signals: companion-linked suicides, AI romance fraud growth, digital-resurrection grief harms." },
  { key: "substitution_vs_complement", name: "Substitution vs complement", unit: "-1 to +1", description: "Whether AI relationships mostly replace human bonds (-1) or augment and rehearse them (+1) in aggregate by 2040.", params: { min: -0.8, mode: -0.1, max: 0.7 }, rationale: "Contested across Clinical & Public Health and Arts, Ideas & Academy clusters: therapy-adjacent benefits vs displacement studies." },
];

function seedDrivers() {
  if (countDrivers.get().n > 0) return 0;
  DRIVERS.forEach((d, i) =>
    insertDriver.run(d.key, d.name, d.description, d.unit, "pert", JSON.stringify(d.params), d.rationale, 1, i, now()));
  return DRIVERS.length;
}

const SOURCES = [
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/", kind: "scrape", notes: "Market moves, launches, funding in companion AI." },
  { name: "Ars Technica AI", url: "https://arstechnica.com/ai/", kind: "scrape", notes: "Technical and policy coverage of AI behaviour." },
  { name: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/", kind: "scrape", notes: "Research-adjacent reporting on human-AI relationships." },
];

function seedSources() {
  if (listSources.all().length > 0) return 0;
  SOURCES.forEach((s) => insertSource.run(s.name, s.url, s.kind, 5, 1, s.notes, now()));
  return SOURCES.length;
}

// Reviewed-and-published scenario set, exported from the working DB. Seeding it
// makes a fresh volume restore the full platform state, not just the corpus.
function seedScenarios() {
  if (db.prepare("SELECT COUNT(*) AS n FROM scenarios").get().n > 0) return 0;
  const path = join(HERE, "..", "server", "seed", "scenarios.json");
  if (!existsSync(path)) return 0;
  const rows = JSON.parse(readFileSync(path, "utf8"));
  const ts = now();
  for (const s of rows) {
    insertScenario.run(s.slug, s.title, s.archetype, s.horizon_year, s.summary,
      s.litany, s.systemic, s.worldview, s.myth, s.narrative,
      s.signal_ids, s.driver_conditions, s.status, ts, ts);
    if (s.status === "published")
      db.prepare("UPDATE scenarios SET published_at = ? WHERE slug = ?").run(ts, s.slug);
  }
  return rows.length;
}

function seedThemes() {
  if (countThemes.get().n > 0) return 0;
  const ts = now();
  DEFAULT_THEMES.forEach((t) => insertTheme.run(t.key, t.query, 1, ts));
  return DEFAULT_THEMES.length;
}

export function seedIfEmpty() {
  const signals = seedSignals();
  const drivers = seedDrivers();
  const sources = seedSources();
  const scenarios = seedScenarios();
  const themes = seedThemes();
  if (signals || drivers || sources || scenarios || themes)
    console.log(`[seed] seeded ${signals} signals, ${drivers} drivers, ${sources} sources, ${scenarios} scenarios, ${themes} themes`);
  return { signals, drivers, sources, scenarios, themes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = seedIfEmpty();
  console.log("[seed] done:", r);
}
