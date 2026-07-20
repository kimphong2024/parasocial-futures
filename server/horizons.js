// Horizon audit — a fleet of LLM judge calls re-assessing every approved
// signal's time horizon (H1/H2/H3) with per-signal written reasoning. The
// scan classifier assigns horizons cheaply at intake; this pass makes the
// field rigorous and auditable: reasoning is stored on the signal and
// shown in the library drawer.
import { now, approvedSignals, setSignalHorizon } from "./db.js";
import { askTool, llmEnabled } from "./ai.js";

const BATCH = 40;
const CONCURRENCY = 4;

const SYSTEM = `You are a foresight analyst judging the TIME HORIZON of horizon-scan signals for a platform on parasocial AI and the futures of social relations (horizon year 2040). For each signal, judge when the PHENOMENON the signal points to plausibly becomes a mainstream, socially significant reality — not when the article was published.

Definitions (apply strictly):
- H1 (now–2029): the phenomenon is already unfolding or requires no missing preconditions — products shipping, behaviors measured at scale, regulation in force or imminent. Evidence of present-tense diffusion.
- H2 (2030–2035): plausible mainstream arrival requires named further developments (technical maturity, cost curves, regulatory settlements, generational turnover beginning) that are visibly underway but not complete.
- H3 (2036–2040+): arrival depends on stacked preconditions — multiple slow variables (deep norm change, legal category change, demographic turnover) that cannot compound before the mid-2030s.

For every signal, write 2-4 sentences of reasoning that cite the signal's own content: what is already true in it, what still has to happen, and which diffusion barriers (cost, law, norms, infrastructure) gate the timeline. Name the deciding factor. Do not use vague phrases like "in the coming years". A published study or shipped product is evidence about the present (H1) even when its implications are long-term — judge the phenomenon's social arrival, not its first appearance.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", description: "Signal id from the input list" },
          horizon: { type: "string", enum: ["H1", "H2", "H3"] },
          reasoning: { type: "string", description: "2-4 sentences citing the signal's content: what is present, what must still happen, the deciding factor" },
        },
        required: ["id", "horizon", "reasoning"],
      },
    },
  },
  required: ["items"],
};

let running = false;
const progress = { done: 0, total: 0, changed: 0, errors: 0, started_at: null, finished_at: null, by_horizon: {} };
export const horizonStatus = () => ({ running, ...progress });

async function judgeBatch(signals) {
  const list = signals.map((s) =>
    `${s.id}. [${s.cluster} · ${s.signal_type || "?"} · dated ${s.date || s.year || "unknown"} · current: ${s.horizon || "unset"}] ${s.title} — ${s.summary}`).join("\n");
  const { items } = await askTool({
    system: SYSTEM,
    prompt: `Judge the horizon of each signal. Return one item per id.\n\n${list}`,
    toolName: "judge_horizons",
    schema: SCHEMA,
    maxTokens: 16000,
    effort: "high",
  });
  const ts = now();
  const byId = new Map(signals.map((s) => [s.id, s]));
  for (const it of items || []) {
    const s = byId.get(it.id);
    if (!s || !["H1", "H2", "H3"].includes(it.horizon) || !(it.reasoning || "").trim()) continue;
    setSignalHorizon.run(it.horizon, it.reasoning.trim(), ts, it.id);
    if (s.horizon !== it.horizon) progress.changed++;
    progress.by_horizon[it.horizon] = (progress.by_horizon[it.horizon] || 0) + 1;
    progress.done++;
  }
}

export async function judgeHorizons() {
  if (running) return { skipped: true };
  if (!llmEnabled()) throw new Error("ANTHROPIC_API_KEY unset");
  running = true;
  const signals = approvedSignals.all();
  Object.assign(progress, { done: 0, total: signals.length, changed: 0, errors: 0, started_at: now(), finished_at: null, by_horizon: {} });
  try {
    const batches = [];
    for (let i = 0; i < signals.length; i += BATCH) batches.push(signals.slice(i, i + BATCH));
    // a small fleet of concurrent judges works through the batches
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const mine = batches[next++];
        try { await judgeBatch(mine); }
        catch (e) { progress.errors++; console.error("[horizons] batch failed:", e.message); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    progress.finished_at = now();
  } finally {
    running = false;
  }
  return horizonStatus();
}
