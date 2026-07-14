// Voyage AI client — document/query embeddings + reranking, raw fetch.
// Gated on VOYAGE_API_KEY; callers must handle null/throw when disabled.
const KEY = (process.env.VOYAGE_API_KEY || "").trim();
const MODEL = process.env.VOYAGE_MODEL || "voyage-3.5";
const RERANK = process.env.VOYAGE_RERANK || "rerank-2.5";
export const DIM = 1024;

export const voyageEnabled = () => !!KEY;

async function post(path, body, tries = 5) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch("https://api.voyageai.com/v1/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
      body: JSON.stringify(body),
    });
    if (r.status === 429 && attempt < tries) {
      const wait = Math.min(20000, 1000 * 2 ** attempt);
      console.warn(`[voyage] 429 — backing off ${wait}ms`);
      await new Promise((ok) => setTimeout(ok, wait));
      continue;
    }
    if (!r.ok) throw new Error(`voyage ${path} ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.json();
  }
}

// texts: string[] (≤128 per call). Returns Float32Array[].
export async function embedDocuments(texts) {
  if (!KEY) return null;
  const j = await post("embeddings", {
    input: texts.map((t) => String(t).slice(0, 8000)),
    model: MODEL, input_type: "document", output_dimension: DIM,
  });
  return j.data.map((d) => Float32Array.from(d.embedding));
}

export async function embedQuery(text) {
  if (!KEY) return null;
  const j = await post("embeddings", {
    input: [String(text).slice(0, 8000)],
    model: MODEL, input_type: "query", output_dimension: DIM,
  });
  return Float32Array.from(j.data[0].embedding);
}

// docs: string[]; returns [{index, score}] best-first, length ≤ topK.
export async function rerank(query, docs, topK) {
  if (!KEY || !docs.length) return docs.map((_, i) => ({ index: i, score: 0 })).slice(0, topK);
  const j = await post("rerank", { query, documents: docs, model: RERANK, top_k: topK });
  return j.data.map((d) => ({ index: d.index, score: d.relevance_score }));
}

export const MODEL_NAME = MODEL;
