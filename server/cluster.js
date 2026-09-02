// Grouping the review queue by meaning.
//
// The 33-cluster taxonomy is assigned at intake by the classifier, so it can
// only ever name themes we already knew to look for. Grouping the pending
// queue by embedding proximity surfaces the ones we did not — and, more
// practically, lets a reviewer decide about twenty related signals in one
// considered pass instead of twenty unrelated ones.
//
// Method: incremental centroid ("leader") clustering. Each signal joins the
// first existing group whose centroid it resembles above THRESHOLD, or starts
// a new one; then one reassignment pass settles borderline members. This is
// average-linkage in spirit and O(n · groups) rather than O(n²) or worse, and
// unlike single-linkage it cannot chain two unrelated themes together through
// a bridge signal.
//
// Singletons are never absorbed into a nearest group. A signal that resembles
// nothing else in the queue is the most interesting thing in it, and it is
// exactly what a "tidy" clustering would bury.

import { createHash } from "node:crypto";
import * as d from "./db.js";
import { getVector, cosine } from "./vectors.js";
import { askTool, llmEnabled } from "./ai.js";

// Threshold is in MEAN-CENTRED space, not raw cosine — see centre() below.
// Measured on the live queue: raw pairwise cosine averages 0.666 with a 99.9th
// percentile of 0.854, so no raw threshold separates themes; it either yields
// one blob or nothing. Centred, the same pairs average 0.000, and 0.42 gives
// coherent, nameable groups (digital resurrection; China's companion rules;
// elderly-care robots; fictosexuality; AI coworkers). Loosening to 0.35 starts
// fusing unrelated themes into grab-bags, which defeats the purpose: a group
// you cannot name is not a group you can decide about.
const THRESHOLD = 0.42;
const MIN_SIZE = 2;       // below this it is a singleton, not a group
const MAX_LABELLED = 40;  // groups sent to the labeller in one call

const round = (x) => Math.round(x * 1000) / 1000;

// The corpus is one subject, so every vector shares a large common component:
// "this is about parasocial AI". Subtracting the queue's mean removes that
// shared direction and leaves the part that actually distinguishes one signal
// from another. Without this the geometry has no usable dynamic range.
function centre(vecs) {
  const dim = vecs[0].length;
  const mean = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i];
  for (let i = 0; i < dim; i++) mean[i] /= vecs.length;
  return vecs.map((v) => {
    const o = new Float32Array(dim);
    let s = 0;
    for (let i = 0; i < dim; i++) { o[i] = v[i] - mean[i]; s += o[i] * o[i]; }
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let i = 0; i < dim; i++) o[i] *= inv;
    return o;
  });
}

function centroidOf(vecs) {
  const dim = vecs[0].length;
  const c = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) c[i] += v[i];
  let s = 0;
  for (let i = 0; i < dim; i++) s += c[i] * c[i];
  const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
  for (let i = 0; i < dim; i++) c[i] *= inv;
  return c;
}

// ---------------- the grouping itself ----------------

function buildGroups(rows) {
  const raw = [];
  for (const r of rows) {
    const v = getVector(r.id);
    if (v) raw.push({ row: r, raw: v });
  }
  if (!raw.length) return { groups: [], singletons: [] };
  const centred = centre(raw.map((x) => x.raw));
  const items = raw.map((x, i) => ({ row: x.row, vec: centred[i] }));
  // Deterministic order: newest first, matching the queue's own ordering.
  items.sort((a, b) => b.row.id - a.row.id);

  let groups = [];   // [{ members: [item], centroid }]
  for (const it of items) {
    let best = null, bestScore = THRESHOLD;
    for (const g of groups) {
      const s = cosine(it.vec, g.centroid);
      if (s >= bestScore) { best = g; bestScore = s; }
    }
    if (best) {
      best.members.push(it);
      best.centroid = centroidOf(best.members.map((m) => m.vec));
    } else {
      groups.push({ members: [it], centroid: it.vec });
    }
  }

  // One reassignment pass: early arrivals seeded groups before those groups
  // had settled, so let every signal reconsider against the final centroids.
  const centroids = groups.map((g) => g.centroid);
  const reassigned = centroids.map(() => []);
  const loose = [];
  for (const it of items) {
    let bestIdx = -1, bestScore = THRESHOLD;
    for (let i = 0; i < centroids.length; i++) {
      const s = cosine(it.vec, centroids[i]);
      if (s >= bestScore) { bestIdx = i; bestScore = s; }
    }
    if (bestIdx >= 0) reassigned[bestIdx].push({ ...it, score: bestScore });
    else loose.push(it);
  }

  const out = [];
  const singletons = [...loose];
  for (const members of reassigned) {
    if (members.length >= MIN_SIZE) out.push(members);
    else singletons.push(...members);
  }
  out.sort((a, b) => b.length - a.length);
  return { groups: out, singletons };
}

// ---------------- labelling ----------------

const LABEL_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "the group's index as given" },
          label: { type: "string", description: "4-8 words naming what these signals share, in the house voice — observational, no hype" },
          rationale: { type: "string", description: "one sentence on what actually binds them, and any signal that sits oddly in the group" },
        },
        required: ["index", "label", "rationale"],
      },
    },
  },
  required: ["groups"],
};

async function labelGroups(groups) {
  const fallback = groups.map((members, i) => {
    const counts = {};
    for (const m of members) counts[m.row.cluster] = (counts[m.row.cluster] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return { index: i, label: top ? `${top[0]} — ${members.length} related hits` : `Group ${i + 1}`, rationale: "" };
  });
  if (!llmEnabled() || !groups.length) return fallback;

  const slice = groups.slice(0, MAX_LABELLED);
  const prompt = slice.map((members, i) =>
    `GROUP ${i} (${members.length} signals; taxonomy clusters: ${[...new Set(members.map((m) => m.row.cluster))].join(", ")})\n` +
    members.slice(0, 10).map((m) => `- ${m.row.title}`).join("\n")
  ).join("\n\n");

  try {
    const out = await askTool({
      system: `You name clusters of scanned signals for a foresight platform on parasocial AI (horizon 2040). House voice: measured, literate, observational; no hype, no exclamation marks, no emoji. A label names what the signals share as a phenomenon, not as a topic word — prefer "Bereavement services selling posthumous voice clones" over "Grief tech". If a group is incoherent, say so plainly in the rationale.`,
      prompt: `Name each group.\n\n${prompt}`,
      toolName: "label_groups",
      schema: LABEL_SCHEMA,
      maxTokens: 4000,
      effort: "low",
    });
    const byIndex = new Map((out.groups || []).map((g) => [g.index, g]));
    return groups.map((_, i) => byIndex.get(i) || fallback[i]);
  } catch (e) {
    console.error("[cluster] labelling failed:", e.message);
    return fallback;
  }
}

// ---------------- cached entry point ----------------

let cache = null; // { key, payload }

// Keyed on the exact membership of the queue, so any approve, reject or new
// scan hit invalidates the grouping rather than serving a stale one.
function queueKey() {
  const ids = d.db.prepare("SELECT id FROM signals WHERE status = 'pending' ORDER BY id").all().map((r) => r.id);
  return createHash("sha1").update(`${ids.length}|${ids.join(",")}`).digest("hex").slice(0, 12);
}

export function clusterStatus() {
  return { cached: !!cache, key: cache?.key || null };
}

export async function groupPendingQueue() {
  const key = queueKey();
  if (cache && cache.key === key) return cache.payload;

  const rows = d.db.prepare("SELECT id, title, summary, cluster, signal_type, urgency, horizon, url, source FROM signals WHERE status = 'pending'").all();
  const { groups, singletons } = buildGroups(rows);
  const labels = await labelGroups(groups);

  const payload = {
    threshold: THRESHOLD,
    grouped: groups.reduce((n, g) => n + g.length, 0),
    singletons: singletons.length,
    groups: groups.map((members, i) => {
      const centroid = centroidOf(members.map((m) => m.vec));
      const cohesion = round(members.reduce((s, m) => s + cosine(m.vec, centroid), 0) / members.length);
      const rep = [...members].sort((a, b) => cosine(b.vec, centroid) - cosine(a.vec, centroid))[0];
      return {
        id: `g${i}`,
        label: labels[i]?.label || `Group ${i + 1}`,
        rationale: labels[i]?.rationale || "",
        size: members.length,
        cohesion,
        representative: { id: rep.row.id, title: rep.row.title },
        member_ids: members.map((m) => m.row.id),
        members: members.map((m) => ({ id: m.row.id, title: m.row.title, cluster: m.row.cluster })),
      };
    }),
  };
  cache = { key, payload };
  return payload;
}

export function invalidateClusters() { cache = null; }
