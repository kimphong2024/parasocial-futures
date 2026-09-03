// Critique of a report section.
//
// The report is drafted by the model, then authored by a human. This is the
// third move: the model reading what is now there and saying what is wrong
// with it. Five registers, because "give me feedback" produces mush — each
// one asks a different question and gets a different kind of answer.
//
// `signals` is deliberately not an opinion. It embeds the section and searches
// the approved library for evidence the section did not cite, then asks only
// which of those actually bear on it. Retrieval first, judgment second: the
// candidates are real rows, so the mode cannot invent a signal that would be
// convenient.

import * as d from "./db.js";
import { askTool, llmEnabled } from "./ai.js";
import { embedQuery, voyageEnabled } from "./voyage.js";
import { topSignals } from "./vectors.js";

export const MODES = {
  signals: {
    label: "Alternative signals",
    system: "", ask: "",   // handled by retrieval, not by a prose prompt
  },
  gaps: {
    label: "What this misses",
    system: "You find what an argument leaves out. Not style, not tone — the substantive omission a careful reader would notice: an actor, a mechanism, a counter-current, a region, a timescale the passage never mentions.",
    ask: "Name what this section misses. Be specific about what is absent and why its absence matters to the claim being made. If the section is genuinely complete for its length, say so plainly rather than inventing a gap.",
  },
  considerations: {
    label: "Points to consider",
    system: "You strengthen arguments. You point at the load-bearing assumption, the place a claim is doing more work than its evidence supports, the framing choice that could have gone another way.",
    ask: "What should the author reconsider here? Point at assumptions being carried silently, claims outrunning their evidence, and framing choices worth making deliberately.",
  },
  questions: {
    label: "Questions to consider",
    system: "You ask the questions a sharp reader would ask. Real questions with real stakes, not rhetorical prompts, and not questions the section already answers.",
    ask: "What questions does this section raise that it does not answer? Prefer questions that would change the reading if answered one way rather than another.",
  },
  redteam: {
    label: "What red teaming exposes",
    system: "You are an adversarial reader hired to break this argument before a hostile committee does. You look for the reading that makes the author look naive, the selection effect, the number that will not survive scrutiny, the alternative explanation that fits the same evidence.",
    ask: "Attack this section. Where would a hostile expert reader break it? Name the strongest counter-reading, any selection effect in the evidence, and the specific claim most likely to fail under scrutiny.",
  },
};

const POINTS_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "One sentence: the single most important thing to say about this section in this register. No preamble." },
    points: {
      type: "array",
      description: "Three to five points. Fewer is better than padding.",
      items: {
        type: "object",
        properties: {
          point: { type: "string", description: "The point itself, 10-25 words, stated as a claim not a hedge." },
          detail: { type: "string", description: "One or two sentences on why it matters and what to do about it. Cite [S<id>] where the library supports the point." },
        },
        required: ["point", "detail"],
      },
    },
  },
  // verdict is asked for but not required: across runs the model reliably
  // returns the points and drops it, and the points are the substance.
  required: ["points"],
};

const SIGNALS_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "One sentence on what the uncited evidence collectively adds, or that it adds little." },
    picks: {
      type: "array",
      description: "Only the candidates that genuinely bear on this section. Returning two is a fine answer; returning all of them is not.",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", description: "The signal id, exactly as given" },
          why: { type: "string", description: "One sentence: what this adds that the section currently lacks — support, complication, or contradiction." },
          stance: { type: "string", enum: ["supports", "complicates", "contradicts"] },
        },
        required: ["id", "why", "stance"],
      },
    },
  },
  required: ["picks"],
};

// The section as plain text, whatever shape it is stored in.
function sectionText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? v : [v.watch, v.direction, v.meaning].filter(Boolean).join(" — "))).join("\n");
  }
  if (value && typeof value === "object") return Object.values(value).filter((v) => typeof v === "string").join("\n\n");
  return "";
}

const citedIn = (text) => new Set([...text.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])));

// ---------------- alternative signals: retrieval, then judgment ----------------

async function critiqueSignals(text) {
  if (!voyageEnabled()) throw new Error("VOYAGE_API_KEY unset — alternative signals needs the vector index");
  const already = citedIn(text);
  const approved = new Set(d.db.prepare("SELECT id FROM signals WHERE status = 'approved'").all().map((r) => r.id));
  const qv = await embedQuery(text.slice(0, 4000));
  const hits = topSignals(qv, 40, (id) => approved.has(id) && !already.has(id));
  const candidates = hits.slice(0, 18).map((h) => ({ ...d.getSignal.get(h.id), score: h.score }));
  if (!candidates.length) return { verdict: "The library has nothing relevant that this section has not already cited.", picks: [] };

  const list = candidates.map((s) =>
    `[S${s.id}] (${s.cluster} · ${s.signal_type} · ${s.urgency} · ${s.horizon}) ${s.title} — ${s.summary}`).join("\n");

  const out = await askTool({
    system: "You select evidence. You are shown a passage from a foresight report and a set of signals from the same library that the passage does not cite. You say which of them actually bear on it and why. You never invent an id, and you would rather return two genuinely relevant signals than eight padded ones. Measured, literate, no hype.",
    prompt: `PASSAGE:\n${text}\n\nUNCITED CANDIDATES FROM THE APPROVED LIBRARY:\n${list}\n\nWhich of these bear on the passage, and what does each add?`,
    toolName: "select_signals",
    schema: SIGNALS_SCHEMA,
    maxTokens: 3000,
    effort: "medium",
  });

  const byId = new Map(candidates.map((s) => [s.id, s]));
  return {
    verdict: out.verdict,
    picks: (out.picks || [])
      .filter((p) => byId.has(p.id))   // the model cannot conjure an id that was not offered
      .map((p) => ({ ...p, title: byId.get(p.id).title, source: byId.get(p.id).source, url: byId.get(p.id).url, cluster: byId.get(p.id).cluster })),
  };
}

// ---------------- prose critique ----------------

async function critiquePoints(mode, text, context) {
  const m = MODES[mode];
  const out = await askTool({
    system: `${m.system}

You are reading one section of a foresight report on parasocial AI, horizon 2040, built from a human-reviewed signal library. House voice: measured, literate, observational; no hype, no exclamation marks, no emoji. Address the author directly and plainly. Do not praise. Do not restate the section back. If a point is only worth a sentence, it is worth a sentence.`,
    prompt: `SECTION UNDER REVIEW — "${context.title}":\n${text}\n\nFOR CONTEXT, the rest of the report in brief:\n${context.brief}\n\n${m.ask}`,
    toolName: "critique_section",
    schema: POINTS_SCHEMA,
    maxTokens: 4000,
    effort: "high",
  });
  return out;
}

// ---------------- entry point ----------------

export async function critiqueSection({ mode, sectionKey, title, value, brief }) {
  if (!llmEnabled()) throw new Error("ANTHROPIC_API_KEY unset");
  const text = sectionText(value).trim();
  if (!text) throw new Error("that section is empty — nothing to critique");

  const body = mode === "signals"
    ? await critiqueSignals(text)
    : await critiquePoints(mode, text, { title, brief });

  const row = { section_key: sectionKey, mode, body_json: JSON.stringify(body), created_at: d.now() };
  const info = d.insertCritique.run(row.section_key, row.mode, row.body_json, row.created_at);
  return { id: Number(info.lastInsertRowid), ...row, body };
}
