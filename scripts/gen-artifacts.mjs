// Artifact imagery — one photograph per artifact from the future, generated
// with Leonardo Phoenix. Every prompt is stored verbatim in
// server/seed/artifacts.json and shown on the /artifacts page, so the
// provenance of each object is inspectable.
//
//   node --env-file=.env scripts/gen-artifacts.mjs [--force]
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "server", "public", "img", "artifacts");
mkdirSync(OUT, { recursive: true });

const KEY = (process.env.LEONARDO_API_KEY || "").trim();
const MODEL = "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3"; // Phoenix 1.0
// The platform sets the words; the model must never attempt them.
const NEG = "text, words, letters, numbers, typography, handwriting, captions, watermark, logo, signature, brand marks, illustration, cartoon, 3d render, people, faces, hands";
const FORCE = process.argv.includes("--force");

const scenarios = JSON.parse(readFileSync(join(ROOT, "server", "seed", "artifacts.json"), "utf8"));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function generate(prompt) {
  const r = await fetch("https://cloud.leonardo.ai/api/rest/v1/generations", {
    method: "POST",
    headers: { authorization: "Bearer " + KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      prompt, negative_prompt: NEG, modelId: MODEL,
      width: 1024, height: 768, num_images: 1, contrast: 3.5, alchemy: false, public: false,
    }),
  });
  const j = await r.json();
  const id = j?.sdGenerationJob?.generationId;
  if (!id) throw new Error("submit failed: " + JSON.stringify(j).slice(0, 200));
  for (let i = 0; i < 50; i++) {
    await new Promise((ok) => setTimeout(ok, 4000));
    const p = await (await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${id}`, {
      headers: { authorization: "Bearer " + KEY, accept: "application/json" },
    })).json();
    const g = p?.generations_by_pk;
    if (g?.status === "COMPLETE") return g.generated_images[0].url;
    if (g?.status === "FAILED") throw new Error("generation FAILED");
  }
  throw new Error("timeout");
}

let made = 0, skipped = 0;
for (const sc of scenarios) {
  for (const a of sc.artifacts) {
    const file = join(OUT, `${sc.archetype}-${a.slug}.jpg`);
    if (existsSync(file) && !FORCE) { skipped++; continue; }
    try {
      log(`>> ${sc.archetype}/${a.slug} (${a.type})`);
      const url = await generate(a.image_prompt);
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, buf);
      made++;
      log(`   saved ${buf.length} bytes`);
    } catch (e) {
      log(`   !! ${a.slug}: ${e.message}`);
    }
  }
}
log(`done — ${made} generated, ${skipped} already present`);
