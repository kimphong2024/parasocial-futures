// Scenario drafting — Causal Layered Analysis scaffolding over Dator archetypes.
// Claude drafts from an evidence pack of approved signals; output lands as a
// 'draft' that a human edits and publishes. Publishing builds the scenario's
// embedding so it enters chat retrieval.
import { db, now, insertScenario, getScenario, enabledDrivers } from "./db.js";
import { askTool } from "./ai.js";
import { embedQuery, embedDocuments, voyageEnabled } from "./voyage.js";
import { topSignals, addScenarioVector } from "./vectors.js";

export const ARCHETYPES = {
  growth: { name: "Continued Growth", logic: "Current trajectories extend: AI companionship scales into a normal, commercially mature layer of social life. Momentum wins over friction." },
  collapse: { name: "Collapse", logic: "The system breaks: harms compound, trust craters, a crisis (or slow rot) makes parasocial AI a story of social damage and retreat." },
  discipline: { name: "Discipline", logic: "Society constrains the technology: strong norms, regulation and design mandates channel parasocial AI into bounded, supervised roles." },
  transformation: { name: "Transformation", logic: "A structural break in what 'relationship' means: parasocial AI dissolves and re-forms categories of kinship, personhood and intimacy rather than merely growing or being tamed." },
};

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Evocative but restrained scenario title, no colon-itis" },
    summary: { type: "string", description: "3-4 sentence abstract of the 2040 state" },
    litany: { type: "string", description: "CLA layer 1 — the visible surface of 2040: headlines, statistics, everyday observations. 1-2 paragraphs." },
    systemic: { type: "string", description: "CLA layer 2 — the structural causes: economic, technological, regulatory, demographic systems producing the litany. 1-2 paragraphs." },
    worldview: { type: "string", description: "CLA layer 3 — the shared beliefs and discourses that make this world coherent to the people in it. 1 paragraph." },
    myth: { type: "string", description: "CLA layer 4 — the deep metaphor or civilisational story underneath (e.g. 'the mirror', 'the golem', 'the hearth'). Short." },
    narrative: { type: "string", description: "A 400-600 word prose vignette of life in this 2040, written in the measured, observational house voice. No exclamation marks." },
    cited_signal_ids: { type: "array", items: { type: "integer" }, description: "IDs of the evidence signals (from the numbered pack) that most anchor this scenario. 8-15 ids." },
    driver_conditions: {
      type: "array",
      description: "The region of driver space where this scenario holds — a conjunction of conditions over the listed drivers.",
      items: {
        type: "object",
        properties: {
          driver_key: { type: "string" },
          op: { type: "string", enum: ["lte", "gte", "between"] },
          value: { type: "number", description: "For lte/gte" },
          lo: { type: "number", description: "For between" },
          hi: { type: "number", description: "For between" },
        },
        required: ["driver_key", "op"],
      },
    },
  },
  required: ["title", "summary", "litany", "systemic", "worldview", "myth", "narrative", "cited_signal_ids", "driver_conditions"],
};

// Evidence pack: top signals by similarity to the archetype logic (+ optional
// focus), stratified so no single cluster dominates and H3/critical rows are present.
async function evidencePack(archetype, focus) {
  const desc = `${ARCHETYPES[archetype].name}: ${ARCHETYPES[archetype].logic} ${focus || ""}`;
  const approved = new Set(db.prepare("SELECT id FROM signals WHERE status = 'approved'").all().map((r) => r.id));
  let ids = [];
  if (voyageEnabled()) {
    const qv = await embedQuery(desc);
    const hits = topSignals(qv, 120, (id) => approved.has(id));
    const byCluster = new Map();
    for (const h of hits) {
      const s = db.prepare("SELECT * FROM signals WHERE id = ?").get(h.id);
      const arr = byCluster.get(s.cluster) || [];
      if (arr.length < 4) { arr.push(s); byCluster.set(s.cluster, arr); }
      if ([...byCluster.values()].flat().length >= 32) break;
    }
    ids = [...byCluster.values()].flat();
  } else {
    ids = db.prepare("SELECT * FROM signals WHERE status = 'approved' ORDER BY RANDOM() LIMIT 32").all();
  }
  // Guarantee long-horizon and critical evidence is in the pack.
  const extra = db.prepare("SELECT * FROM signals WHERE status = 'approved' AND (horizon = 'H3' OR urgency = 'critical') ORDER BY RANDOM() LIMIT 8").all();
  const seen = new Set(ids.map((s) => s.id));
  for (const s of extra) if (!seen.has(s.id)) { ids.push(s); seen.add(s.id); }
  return ids;
}

const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export async function draftScenario({ archetype, focus = "" }) {
  if (!ARCHETYPES[archetype]) throw new Error("unknown archetype");
  const pack = await evidencePack(archetype, focus);
  const drivers = enabledDrivers.all().map((d) => {
    const p = JSON.parse(d.params_json);
    return `- ${d.key} (${d.unit}): ${d.description} Current judgment: min ${p.min}, mode ${p.mode}, max ${p.max}.`;
  }).join("\n");
  const evidence = pack.map((s) => `[${s.id}] (${s.cluster} · ${s.signal_type} · ${s.urgency} · ${s.horizon}) ${s.title} — ${s.summary}`).join("\n");

  const input = await askTool({
    system: `You are a foresight practitioner drafting a 2040 scenario using Causal Layered Analysis inside a Dator archetype, for a capstone on parasocial AI and the futures of social relations.

Archetype: ${ARCHETYPES[archetype].name} — ${ARCHETYPES[archetype].logic}
${focus ? `Additional focus requested: ${focus}` : ""}

House voice: measured, literate, observational. Comfortable with uncertainty ("plausible", "emerging", "a weak signal suggests"). Never hype. No exclamation marks. No emoji.

Ground every layer in the evidence pack — the litany should echo real signals extrapolated to 2040, and cited_signal_ids must reference ids that genuinely shaped the draft.

Driver conditions: choose the region of the driver space below where THIS archetype plausibly holds. Use 2-3 conditions, strongly preferring half-spaces (gte/lte) over 'between' — each added condition multiplies down the joint probability, and a Monte Carlo over these conditions should leave the scenario with meaningful probability mass (roughly 5-35% of sampled futures), not a sliver. Use each driver's own unit and stay within its min-max range.

Drivers:
${drivers}`,
    prompt: `Evidence pack (approved signals):\n\n${evidence}\n\nDraft the ${ARCHETYPES[archetype].name} scenario for 2040.`,
    toolName: "emit_scenario",
    schema: DRAFT_SCHEMA,
    maxTokens: 12000,
    effort: "high",
  });

  // Keep only citations that exist in the pack (models sometimes drift).
  const packIds = new Set(pack.map((s) => s.id));
  const cited = (input.cited_signal_ids || []).filter((id) => packIds.has(id));

  let slug = slugify(input.title) || archetype;
  if (db.prepare("SELECT 1 FROM scenarios WHERE slug = ?").get(slug)) slug = `${slug}-${Date.now() % 10000}`;
  const ts = now();
  const info = insertScenario.run(
    slug, input.title, archetype, 2040, input.summary,
    input.litany, input.systemic, input.worldview, input.myth, input.narrative,
    JSON.stringify(cited), JSON.stringify(input.driver_conditions || []),
    "draft", ts, ts,
  );
  return getScenario.get(Number(info.lastInsertRowid));
}

export const scenarioText = (sc) =>
  `${sc.title} (${sc.archetype}, ${sc.horizon_year}) — ${sc.summary}\n${sc.litany}\n${sc.systemic}\n${sc.worldview}\n${sc.myth}`;

export async function embedScenario(sc) {
  if (!voyageEnabled()) return false;
  const [v] = await embedDocuments([scenarioText(sc)]);
  addScenarioVector(sc.id, v);
  return true;
}
