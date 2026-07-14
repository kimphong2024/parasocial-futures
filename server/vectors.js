// In-memory cosine index over signal + scenario embeddings.
// BLOB gotcha: node:sqlite returns Uint8Array whose byteOffset may not be
// 4-byte aligned — always copy (u8.slice()) before viewing as Float32Array.
import { db, allEmbeddings, allScenarioEmbeddings, upsertEmbedding, upsertScenarioEmbedding, signalsMissingEmbeddings, now } from "./db.js";
import { embedDocuments, voyageEnabled, DIM, MODEL_NAME } from "./voyage.js";

const signalVecs = new Map();   // signal_id -> Float32Array (unit-normalised)
const scenarioVecs = new Map(); // scenario_id -> Float32Array

const toF32 = (u8) => new Float32Array(u8.slice().buffer);
export const toBlob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

function normalise(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export function loadIndex() {
  signalVecs.clear();
  for (const r of allEmbeddings.all()) signalVecs.set(r.signal_id, normalise(toF32(r.vector)));
  scenarioVecs.clear();
  for (const r of allScenarioEmbeddings.all()) scenarioVecs.set(r.scenario_id, normalise(toF32(r.vector)));
  console.log(`[vectors] loaded ${signalVecs.size} signal + ${scenarioVecs.size} scenario vectors`);
}

export const signalText = (s) => `${s.title} — ${s.summary}`;
export const indexedCount = () => signalVecs.size;
export const hasVector = (signalId) => signalVecs.has(signalId);

export function addSignalVector(signalId, f32, persist = true) {
  if (persist) upsertEmbedding.run(signalId, toBlob(f32), MODEL_NAME, DIM, now());
  signalVecs.set(signalId, normalise(f32));
}

export function addScenarioVector(scenarioId, f32) {
  upsertScenarioEmbedding.run(scenarioId, toBlob(f32), MODEL_NAME, DIM, now());
  scenarioVecs.set(scenarioId, normalise(f32));
}

export function removeSignalVector(signalId) { signalVecs.delete(signalId); }

// topSignals(queryVec, k, filterFn?) -> [{id, score}]
export function topSignals(queryVec, k = 10, filterFn = null) {
  const q = normalise(queryVec);
  const hits = [];
  for (const [id, v] of signalVecs) {
    if (filterFn && !filterFn(id)) continue;
    hits.push({ id, score: dot(q, v) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

export function topScenarios(queryVec, k = 4) {
  const q = normalise(queryVec);
  const hits = [];
  for (const [id, v] of scenarioVecs) hits.push({ id, score: dot(q, v) });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

// Nearest existing signal to a raw (un-inserted) vector — used for scan dedup.
export function nearestSignal(f32) {
  const hits = topSignals(f32, 1);
  return hits[0] || null;
}

// Similar signals to an existing signal id.
export function similarTo(signalId, k = 5) {
  const v = signalVecs.get(signalId);
  if (!v) return [];
  return topSignals(v, k + 1).filter((h) => h.id !== signalId).slice(0, k);
}

// Embed published scenarios that lack vectors (covers seed-restored scenarios,
// which never went through the publish endpoint). Text mirrors scenarios.js
// scenarioText — kept inline to avoid an import cycle.
export async function ensureScenarioEmbeddings() {
  if (!voyageEnabled()) return 0;
  const missing = db.prepare(`SELECT s.* FROM scenarios s LEFT JOIN scenario_embeddings e ON e.scenario_id = s.id
    WHERE e.scenario_id IS NULL AND s.status = 'published'`).all();
  if (!missing.length) return 0;
  const texts = missing.map((sc) =>
    `${sc.title} (${sc.archetype}, ${sc.horizon_year}) — ${sc.summary}\n${sc.litany}\n${sc.systemic}\n${sc.worldview}\n${sc.myth}`);
  const vecs = await embedDocuments(texts);
  missing.forEach((sc, i) => addScenarioVector(sc.id, vecs[i]));
  console.log(`[vectors] embedded ${missing.length} scenarios`);
  return missing.length;
}

// Embed any approved/pending signals that lack vectors (boot + post-scan catch-up).
export async function ensureEmbeddings() {
  if (!voyageEnabled()) { console.warn("[vectors] VOYAGE_API_KEY unset — semantic features off"); return 0; }
  const missing = signalsMissingEmbeddings.all();
  if (!missing.length) return 0;
  console.log(`[vectors] embedding ${missing.length} signals…`);
  let done = 0;
  for (let i = 0; i < missing.length; i += 128) {
    const batch = missing.slice(i, i + 128);
    const vecs = await embedDocuments(batch.map(signalText));
    batch.forEach((s, j) => addSignalVector(s.id, vecs[j]));
    done += batch.length;
    console.log(`[vectors] ${done}/${missing.length}`);
  }
  return done;
}
