// Artifact imagery, second generation — Gemini 2.5 Flash Image ("nano banana"),
// reached through Leonardo's v2 generations API (same key as the rest of the
// image pipeline; no separate Google credential).
//
// Unlike the first Phoenix pass, this model renders legible text, so each
// object is asked to carry its own authored specimen words. The exact composed
// prompt is written back into server/seed/artifacts.json as `image_prompt_used`
// and disclosed on the /artifacts page.
//
//   node --env-file=.env scripts/gen-artifacts-nb.mjs [--force] [--only=archetype]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "server", "public", "img", "artifacts");
const DATA = join(ROOT, "server", "seed", "artifacts.json");
mkdirSync(OUT, { recursive: true });

const KEY = (process.env.LEONARDO_API_KEY || "").trim();
if (!KEY) { console.error("LEONARDO_API_KEY is not set"); process.exit(1); }
const MODEL = "gemini-2.5-flash-image";
const FORCE = process.argv.includes("--force");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// House register + the object's own words, rendered legibly. Long specimens
// are abridged for the photograph — dense blocks make the model mis-spell —
// while the card below the image always carries the full authored text.
const LINES = 5, WIDTH = 46;
function abridge(specimen) {
  return specimen
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, LINES)
    .map((l) => (l.length > WIDTH ? l.slice(0, WIDTH).replace(/[ ,;:.-]+$/, "") + "…" : l))
    .join("\n");
}
function composePrompt(a) {
  return [
    a.image_prompt,
    "",
    "The object carries printed text. Render it sharply and legibly, spelled exactly as written below, in a typeface true to the object (thermal receipt print, ID-card sans, form typewriting, stitched lettering, screen UI — whatever the object implies), laid out plausibly and never crowded. Do not invent, repeat or add any text beyond these lines:",
    "",
    abridge(a.specimen),
    "",
    "Editorial product photograph, muted olive-cream-gold palette, soft directional light, shallow depth of field, no people, no hands.",
  ].join("\n");
}

async function generate(prompt) {
  const r = await fetch("https://cloud.leonardo.ai/api/rest/v2/generations", {
    method: "POST",
    headers: { authorization: "Bearer " + KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ model: MODEL, public: false, parameters: { prompt, quantity: 1 } }),
  });
  const j = await r.json();
  const id = j?.generate?.generationId;
  if (!id) throw new Error("submit failed: " + JSON.stringify(j).slice(0, 200));
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const p = await (await fetch(`https://cloud.leonardo.ai/api/rest/v1/generations/${id}`, {
      headers: { authorization: "Bearer " + KEY, accept: "application/json" },
    })).json();
    const g = p?.generations_by_pk;
    if (g?.status === "COMPLETE") {
      const url = g.generated_images?.[0]?.url;
      if (!url) throw new Error("complete but no image url");
      return Buffer.from(await (await fetch(url)).arrayBuffer());
    }
    if (g?.status === "FAILED") throw new Error("generation FAILED");
  }
  throw new Error("timeout");
}

const scenarios = JSON.parse(readFileSync(DATA, "utf8"));
let made = 0, skipped = 0, failed = 0;

for (const sc of scenarios) {
  if (ONLY && sc.archetype !== ONLY) continue;
  for (const a of sc.artifacts) {
    const file = join(OUT, `${sc.archetype}-${a.slug}.jpg`);
    if (existsSync(file) && !FORCE && a.image_prompt_used) { skipped++; continue; }
    const prompt = composePrompt(a);
    try {
      log(`>> ${sc.archetype}/${a.slug} (${a.type})`);
      const buf = await generate(prompt);
      writeFileSync(file, buf);
      a.image_prompt_used = prompt;
      a.image_model = MODEL;
      made++;
      log(`   saved ${buf.length} bytes`);
      writeFileSync(DATA, JSON.stringify(scenarios, null, 2));   // checkpoint after each
    } catch (e) {
      failed++;
      log(`   !! ${a.slug}: ${e.message}`);
    }
  }
}
log(`done — ${made} generated, ${skipped} skipped, ${failed} failed`);
