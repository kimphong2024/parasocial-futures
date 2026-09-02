// Scan orchestrator: Perplexity (broad) + Firecrawl (directed) → Claude
// classification against the existing taxonomy → URL + embedding dedup →
// insert survivors as status 'pending' for human review. Nothing publishes
// without approval. Each step is fenced so one failure never kills the run.
import { classifyTriangleIfNeeded } from "./triangle.js";
import { storeArticleText } from "./quotes.js";
import { db, now, insertScanRun, finishScanRun, getScanRun, insertSignal, getSignalByUrl, enabledSources, enabledThemes, touchSource, getSetting } from "./db.js";
import { perplexityScan, DEFAULT_THEMES } from "./perplexity.js";
import { firecrawlScan, DEFAULT_FOLLOW_LIMIT } from "./firecrawl.js";
import { askTool, llmEnabled } from "./ai.js";
import { embedDocuments, voyageEnabled } from "./voyage.js";
import { nearestSignal, addSignalVector, signalText } from "./vectors.js";

// Shipped defaults — the live values are user-editable via the settings table
// (env vars remain the fallback), and every run records what it actually used.
export const SCAN_DEFAULTS = {
  recency: "week",
  follow_limit: DEFAULT_FOLLOW_LIMIT,
  dedup_threshold: Number(process.env.DEDUP_THRESHOLD || 0.90),
};
export const DEFAULT_GATE = `RELEVANCE GATE (apply first, strictly): a candidate is relevant ONLY if its core subject is AI's effect on human relationships or social structures — companionship, intimacy, attachment, loneliness, friendship, romance, family, grief, community, or the norms and rules around AI relationships. Mark relevant=false for generic AI news: model releases, benchmarks, chips, funding without an intimacy product, enterprise or coding tools, robotics without a companionship role, and AI policy not about relationships. When the relationship angle is only a passing mention, mark relevant=false. Expect to reject a large share of candidates.`;

export function scanSettings() {
  const s = SCAN_DEFAULTS;
  return {
    recency: getSetting("recency", s.recency),
    follow_limit: Math.max(0, Math.min(5, Number(getSetting("follow_limit", s.follow_limit)))),
    dedup_threshold: Math.max(0.80, Math.min(0.99, Number(getSetting("dedup_threshold", s.dedup_threshold)))),
    relevance_gate: getSetting("relevance_gate", DEFAULT_GATE),
  };
}

let running = false;
let step = null; // "perplexity" | "firecrawl" | "classify" | "dedup+insert" while a run is live
export const scanRunning = () => running;
export const scanStep = () => step;

export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/.test(p)) u.searchParams.delete(p);
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

const existingClusters = () =>
  db.prepare("SELECT DISTINCT cluster FROM signals WHERE cluster != '' ORDER BY cluster").all().map((r) => r.cluster);

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "Index of the candidate in the input list" },
          relevant: { type: "boolean", description: "false if off-topic for parasocial AI / AI and social relations" },
          cluster: { type: "string", description: "One of the existing clusters, or 'NEW: <name>' if genuinely none fits" },
          signal_type: { type: "string", enum: ["discourse", "research", "market", "regulatory", "behavioral", "crisis/legal"] },
          urgency: { type: "string", enum: ["critical", "high", "medium", "low"] },
          horizon: { type: "string", enum: ["H1", "H2", "H3"], description: "H1 = now-2029, H2 = 2030-2035, H3 = 2036-2040+" },
          topic_tags: { type: "string", description: "2-4 snake_case tags, semicolon-separated" },
        },
        required: ["index", "relevant", "cluster", "signal_type", "urgency", "horizon", "topic_tags"],
      },
    },
  },
  required: ["items"],
};

// Returns { survivors, rejects } so the run record can show what the gate cut.
async function classify(candidates, gateText) {
  const clusters = existingClusters();
  const list = candidates.map((c, i) => `${i}. [${c.source || "?"}] ${c.title} — ${c.summary}`).join("\n");
  const { items } = await askTool({
    system: `You classify horizon-scan hits for a foresight project on parasocial AI and the future of social relations.

${gateText}

For survivors: assign one of the existing clusters below (prefer reusing them; only propose 'NEW: <name>' when nothing fits), one signal type, an urgency, and a time horizon.

Existing clusters:
${clusters.join("\n")}`,
    prompt: `Classify these scan candidates:\n\n${list}`,
    toolName: "classify_signals",
    schema: CLASSIFY_SCHEMA,
    maxTokens: 16000,
    effort: "medium",
  });
  const byIndex = new Map(items.map((x) => [x.index, x]));
  const merged = candidates.map((c, i) => ({ ...c, ...byIndex.get(i) }));
  return {
    survivors: merged.filter((c) => c.relevant !== false && c.cluster),
    rejects: merged.filter((c) => c.relevant === false || !c.cluster),
  };
}

export async function runScan(trigger = "manual") {
  if (running) return { skipped: true, reason: "scan already running" };
  running = true;
  const runId = Number(insertScanRun.run(now(), trigger).lastInsertRowid);
  const errors = [];
  let pplxCount = 0, fcCount = 0, newPending = 0, dupUrl = 0, dupEmb = 0, rejectedRel = 0;
  const settings = scanSettings();
  // Per-run provenance: what ran, with which knobs and gate, what each stage cut.
  const detail = {
    settings: { recency: settings.recency, follow_limit: settings.follow_limit, dedup_threshold: settings.dedup_threshold },
    gate: settings.relevance_gate,
    gate_modified: settings.relevance_gate !== DEFAULT_GATE,
    themes: {},
    sources: {},
    rejected: [],
  };

  try {
    // Leg 1: Perplexity over enabled themes
    let candidates = [];
    try {
      step = "perplexity";
      const themes = enabledThemes.all();
      const p = await perplexityScan({ themes: themes.length ? themes : DEFAULT_THEMES, recency: settings.recency });
      errors.push(...p.errors);
      pplxCount = p.candidates.length;
      for (const c of p.candidates) detail.themes[c.theme] = (detail.themes[c.theme] || 0) + 1;
      candidates.push(...p.candidates.map((c) => ({ ...c, provenance: "scan:perplexity" })));
    } catch (e) { errors.push({ step: "perplexity", message: e.message }); }

    // Leg 2: Firecrawl over enabled sources
    try {
      step = "firecrawl";
      const sources = enabledSources.all();
      const f = await firecrawlScan(sources, (url) => !!getSignalByUrl.get(normalizeUrl(url)), settings.follow_limit);
      errors.push(...f.errors);
      fcCount = f.candidates.length;
      candidates.push(...f.candidates.map((c) => ({ ...c, provenance: "scan:firecrawl" })));
      const ts = now();
      for (const src of sources) {
        const r = f.perSource[src.id];
        if (r) {
          touchSource.run(ts, r.ok ? `ok (${r.found} found)` : `error: ${r.error.slice(0, 120)}`, src.id);
          detail.sources[src.name] = r.ok ? r.found : `error`;
        }
      }
    } catch (e) { errors.push({ step: "firecrawl", message: e.message }); }

    // URL dedup (before spending Claude/Voyage tokens)
    const seen = new Set();
    candidates = candidates.filter((c) => {
      const nu = normalizeUrl(c.url);
      if (seen.has(nu) || getSignalByUrl.get(nu)) { dupUrl++; return false; }
      seen.add(nu);
      c.url = nu;
      return true;
    });

    // Claude classification / relevance gate
    if (candidates.length && llmEnabled()) {
      try {
        step = "classify";
        const { survivors, rejects } = await classify(candidates, settings.relevance_gate);
        candidates = survivors;
        rejectedRel = rejects.length;
        detail.rejected = rejects.map((c) => ({ title: c.title, url: c.url, source: c.source || "" }));
      } catch (e) {
        errors.push({ step: "classify", message: e.message });
        candidates = []; // unclassified hits would pollute the taxonomy — drop, keep the error visible
      }
    } else if (candidates.length) {
      errors.push({ step: "classify", message: "ANTHROPIC_API_KEY unset — candidates dropped" });
      candidates = [];
    }

    // Embedding dedup + insert as pending (+ vector so the next run dedups against these too)
    step = "dedup+insert";
    let vecs = null;
    if (candidates.length && voyageEnabled()) {
      try { vecs = await embedDocuments(candidates.map(signalText)); }
      catch (e) { errors.push({ step: "embed", message: e.message }); }
    }
    const ts = now();
    candidates.forEach((c, i) => {
      const v = vecs?.[i];
      let nearest = null;
      if (v) {
        nearest = nearestSignal(v);
        if (nearest && nearest.score >= settings.dedup_threshold) { dupEmb++; return; }
      }
      try {
        // article_text is retained separately, not in raw_json — it is the
        // verbatim-check corpus, not part of the machine's audit payload.
        const { article_text, ...payload } = c;
        const raw = JSON.stringify({ ...payload, nearest });
        const info = insertSignal.run(
          c.title, c.summary || "", c.url, c.source || "", c.topic_tags || "",
          c.cluster || "", c.signal_type || "", c.urgency || "", c.horizon || "",
          c.date || "", c.date ? Number((c.date.match(/20\d\d/) || [])[0]) || null : null,
          c.provenance, "pending", runId, raw, ts, null,
        );
        const newId = Number(info.lastInsertRowid);
        if (v) addSignalVector(newId, v);
        if (article_text) { try { storeArticleText(newId, article_text); } catch { /* quotation support is best-effort */ } }
        newPending++;
      } catch (e) {
        if (/UNIQUE/.test(e.message)) dupUrl++;
        else errors.push({ step: "insert", source: c.url, message: e.message });
      }
    });

    finishScanRun.run(now(), "done", pplxCount, fcCount, newPending, dupUrl, dupEmb, rejectedRel, JSON.stringify(errors), JSON.stringify(detail), runId);
  } catch (e) {
    errors.push({ step: "run", message: e.message });
    finishScanRun.run(now(), "failed", pplxCount, fcCount, newPending, dupUrl, dupEmb, rejectedRel, JSON.stringify(errors), JSON.stringify(detail), runId);
  } finally {
    running = false;
    try { classifyTriangleIfNeeded(); } catch { /* non-fatal */ }
    step = null;
  }
  return getScanRun.get(runId);
}
