// Artifact imagery, second generation — Gemini 2.5 Flash Image ("nano banana").
// Unlike the Leonardo pass, this model renders legible text, so each object is
// asked to carry its own specimen words. The exact composed prompt is written
// back into server/seed/artifacts.json as `image_prompt_used` and shown on the
// /artifacts page, so what produced each photograph stays inspectable.
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

const KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
if (!KEY) {
  console.error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set — add it to .env");
  process.exit(1);
}
const MODEL = process.env.NB_MODEL || "gemini-2.5-flash-image";
const FORCE = process.argv.includes("--force");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// House register + the object's own words, rendered legibly.
function composePrompt(a) {
  return [
    a.image_prompt,
    "",
    "The object carries printed text. Render it sharply and legibly, exactly as written, in a typeface true to the object (thermal receipt print, ID-card sans, form typewriting, stitched lettering, screen UI — whatever the object implies). Keep the layout plausible for a real document of this kind; do not invent extra text beyond what follows:",
    "",
    a.specimen,
    "",
    "Editorial product photograph, muted olive-cream-gold palette, soft directional light, shallow depth of field, no people, no hands.",
  ].join("\n");
}

async function generate(prompt) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 220)}`);
  const j = await r.json();
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) throw new Error("no image in response: " + JSON.stringify(j).slice(0, 220));
  return Buffer.from(img.inlineData.data, "base64");
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
      a.image_prompt_used = prompt;      // disclosure follows the image
      a.image_model = MODEL;
      made++;
      log(`   saved ${buf.length} bytes`);
      writeFileSync(DATA, JSON.stringify(scenarios, null, 2));   // checkpoint
    } catch (e) {
      failed++;
      log(`   !! ${a.slug}: ${e.message}`);
    }
  }
}
log(`done — ${made} generated, ${skipped} skipped, ${failed} failed`);
