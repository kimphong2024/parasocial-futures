// Futures Triangle — classifies every approved signal into one of the three
// forces of Inayatullah's Futures Triangle (Six Pillars, Foresight 2008):
// the pull of the future, the push of the present, the weight of history.
// Mirrors the horizon-audit machinery: batched forced-tool judge calls with
// stored per-signal reasoning, plus a synthesized write-up cached in settings
// and regenerated whenever the library's composition changes.
import { createHash } from "node:crypto";
import { now, triangleSignals, triangleUnclassified, setSignalTriangle, getSetting, setSetting } from "./db.js";
import { askTool, llmEnabled } from "./ai.js";

const BATCH = 40;
const CONCURRENCY = 4;
const CORNERS = ["pull", "push", "weight"];

const SYSTEM = `You classify horizon-scan signals into the three forces of Inayatullah's Futures Triangle (Six Pillars, Foresight 2008), for a platform on parasocial AI and the futures of social relations. Judge what work the signal's phenomenon does in shaping the future — not its topic.

Definitions (choose exactly one per signal):
- pull — THE PULL OF THE FUTURE: the signal is primarily an image or vision of the future doing work in the present. Products and services marketed as the future, manifestos and speculative claims, aspirational categories being normalized, imagined relationships and personhood claims, futures people are reaching toward.
- push — THE PUSH OF THE PRESENT: a present-day driver or measured trend creating momentum. Adoption and usage statistics, market growth and revenue, capability advances shipping at scale, demographic behavior shifts already measured. Quantitative, present-tense momentum.
- weight — THE WEIGHT OF HISTORY: a barrier, harm, or deep structure resisting change. Regulation and litigation, documented harms and clinical damage, backlash and counter-movements, institutional friction, norms and categories that refuse to move.

For each signal write 1-2 sentences of reasoning citing the signal's own content and naming the force at work. A harms study is weight even when its subject is a futuristic product; a usage statistic is push even when the product sells a vision; marketing of an imagined future is pull even when revenue is real — classify the force, not the artifact.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", description: "Signal id from the input list" },
          triangle: { type: "string", enum: CORNERS },
          reasoning: { type: "string", description: "1-2 sentences citing the signal's content and naming the force at work" },
        },
        required: ["id", "triangle", "reasoning"],
      },
    },
  },
  required: ["items"],
};

let running = false;
const progress = { done: 0, total: 0, errors: 0, started_at: null, finished_at: null, by_corner: {} };
export const triangleStatus = () => ({ running, ...progress });

async function judgeBatch(signals) {
  const list = signals.map((s) =>
    `${s.id}. [${s.cluster} · ${s.signal_type || "?"}] ${s.title} — ${s.summary}`).join("\n");
  const { items } = await askTool({
    system: SYSTEM,
    prompt: `Classify each signal into pull, push, or weight. Return one item per id.\n\n${list}`,
    toolName: "classify_triangle",
    schema: SCHEMA,
    maxTokens: 12000,
    effort: "medium",
  });
  for (const it of items || []) {
    if (!CORNERS.includes(it.triangle) || !(it.reasoning || "").trim()) continue;
    setSignalTriangle.run(it.triangle, it.reasoning.trim(), it.id);
    progress.by_corner[it.triangle] = (progress.by_corner[it.triangle] || 0) + 1;
    progress.done++;
  }
}

export async function classifyTriangle({ onlyMissing = true } = {}) {
  if (running) return { skipped: true };
  if (!llmEnabled()) throw new Error("ANTHROPIC_API_KEY unset");
  running = true;
  const signals = onlyMissing
    ? triangleUnclassified.all()
    : triangleSignals.all().map((s) => ({ ...s, summary: s.summary || "" }));
  Object.assign(progress, { done: 0, total: signals.length, errors: 0, started_at: now(), finished_at: null, by_corner: {} });
  try {
    const batches = [];
    for (let i = 0; i < signals.length; i += BATCH) batches.push(signals.slice(i, i + BATCH));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const mine = batches[next++];
        try { await judgeBatch(mine); }
        catch (e) { progress.errors++; console.error("[triangle] batch failed:", e.message); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    progress.finished_at = now();
  } finally {
    running = false;
  }
  return triangleStatus();
}

// Fire-and-forget incremental pass — used after scans and on page loads.
export function classifyTriangleIfNeeded() {
  if (running || !llmEnabled()) return false;
  if (triangleUnclassified.all().length === 0) return false;
  classifyTriangle({ onlyMissing: true })
    .then(() => regenerateWriteupIfStale())
    .catch((e) => console.error("[triangle] incremental classify failed:", e.message));
  return true;
}

// ---------------- the live write-up ----------------

const WRITEUP_KEY = "triangle_writeup";

const WRITEUP_SCHEMA = {
  type: "object",
  properties: {
    pull: { type: "string", description: "~130 words on the pull of the future the library shows: the visions doing work, named concretely from the evidence" },
    push: { type: "string", description: "~130 words on the push of the present: the measured momentum, named concretely from the evidence" },
    weight: { type: "string", description: "~130 words on the weight of history: the barriers and harms resisting, named concretely from the evidence" },
    tension: { type: "string", description: "~120 words synthesizing the triangle: which force currently dominates, where the plausible future is being negotiated, and what would have to shift" },
  },
  required: ["pull", "push", "weight", "tension"],
};

function composition() {
  const rows = triangleSignals.all().filter((s) => CORNERS.includes(s.triangle));
  const counts = { pull: 0, push: 0, weight: 0 };
  let maxId = 0;
  for (const r of rows) { counts[r.triangle]++; maxId = Math.max(maxId, r.id); }
  const hash = createHash("sha1").update(`${counts.pull}|${counts.push}|${counts.weight}|${maxId}`).digest("hex").slice(0, 12);
  return { rows, counts, hash };
}

export function getWriteup() {
  try { return JSON.parse(getSetting(WRITEUP_KEY, "null")); } catch { return null; }
}

let writing = false;
export const writeupStatus = () => ({ writing });

export async function generateWriteup() {
  if (writing) return { skipped: true };
  if (!llmEnabled()) throw new Error("ANTHROPIC_API_KEY unset");
  writing = true;
  try {
    const { rows, counts, hash } = composition();
    const byCorner = Object.fromEntries(CORNERS.map((c) => [c, rows.filter((r) => r.triangle === c)]));
    // top evidence per corner: critical urgency and recency first
    const top = (list) => [...list]
      .sort((a, b) => (b.urgency === "critical") - (a.urgency === "critical") || b.id - a.id)
      .slice(0, 15)
      .map((s) => `[${s.cluster}] ${s.title} — ${s.triangle_reasoning}`)
      .join("\n");
    const clusterDist = (list) => {
      const m = {};
      for (const s of list) m[s.cluster] = (m[s.cluster] || 0) + 1;
      return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} (${n})`).join(", ");
    };
    const out = await askTool({
      system: `You write the live Futures Triangle synthesis for a foresight platform on parasocial AI (horizon 2040), from its human-reviewed signal library. House voice: measured, literate, observational; comfortable with uncertainty; no hype, no exclamation marks, no emoji. Ground every claim in the evidence provided — name real phenomena from the signals, never invent. Refer to forces in Inayatullah's terms: the pull of the future, the push of the present, the weight of history.`,
      prompt: `The library currently classifies ${counts.pull + counts.push + counts.weight} signals into the triangle: pull ${counts.pull}, push ${counts.push}, weight ${counts.weight}.

PULL — leading clusters: ${clusterDist(byCorner.pull)}
Top pull evidence:
${top(byCorner.pull)}

PUSH — leading clusters: ${clusterDist(byCorner.push)}
Top push evidence:
${top(byCorner.push)}

WEIGHT — leading clusters: ${clusterDist(byCorner.weight)}
Top weight evidence:
${top(byCorner.weight)}

Write the four sections.`,
      toolName: "write_triangle",
      schema: WRITEUP_SCHEMA,
      maxTokens: 8000,
      effort: "high",
    });
    const record = { ...out, hash, updated_at: now(), signal_count: counts.pull + counts.push + counts.weight, counts };
    setSetting(WRITEUP_KEY, JSON.stringify(record));
    return record;
  } finally {
    writing = false;
  }
}

// Regenerate in the background when the composition has moved on.
export function regenerateWriteupIfStale() {
  if (writing || !llmEnabled()) return false;
  const current = getWriteup();
  const { hash, counts } = composition();
  if (counts.pull + counts.push + counts.weight === 0) return false;
  if (current && current.hash === hash) return false;
  generateWriteup().catch((e) => console.error("[triangle] writeup failed:", e.message));
  return true;
}
