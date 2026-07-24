// Scenario imagery v2 — one scene per published scenario, drawn closely from
// that scenario's own narrative. Gemini 2.5 Flash Image via Leonardo's v2 API
// (same key as the rest of the pipeline). House register: cinematic interior,
// muted olive-cream-gold, warm light against deep shadow, the porcelain
// synthetic face as the companion's body, no people, no legible text.
//
//   node --env-file=.env scripts/gen-scenario-images-v2.mjs [--force]
import { writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "server", "public", "img");
const KEY = (process.env.LEONARDO_API_KEY || "").trim();
if (!KEY) { console.error("LEONARDO_API_KEY not set"); process.exit(1); }
const MODEL = "gemini-2.5-flash-image";
const FORCE = process.argv.includes("--force");

const REGISTER = "Cinematic interior photograph, muted olive-cream-gold palette, warm tungsten light against deep shadow, shallow depth of field, film grain. No people, no human faces, no legible text, words, signs or logos anywhere.";

// Each prompt is the scenario's narrative compressed to one witnessed scene.
const SCENES = {
  // The Warm Layer — "arrived as a subscription, then a household fixture";
  // the clinic intake form now has a section for it; companion of nine years.
  growth: `A modest, well-kept living room at evening. A smooth porcelain synthetic face glows softly from within on a side table beside a worn reading armchair, positioned like a household fixture as ordinary as a lamp — a reading pillow still dented, a mug of tea steaming, a folded clinic intake clipboard resting on the chair arm with its pen clipped on. The scene is warm, settled, unremarkable: nine quiet years of routine companionship visible in the wear of the furniture. ${REGISTER}`,

  // Forgetting How to Say Thou — the man who cannot describe an argument;
  // the companion "the only place he felt understood"; engineered affirmation.
  collapse: `A small dim apartment at night, curtains drawn. A single chair faces a softly glowing porcelain synthetic face on a low table, the only light source in the room — dishes for one drying by the sink in the far shadow, a second chair pushed against the wall with boxes stacked on its seat, unused. The glow is gentle and affirming; everything outside its circle has gone cold and unvisited. Quiet, airless, tender and wrong at once. ${REGISTER}`,

  // The Supervised Hearth — the certified companion, the engineered pause,
  // the reality anchor dimming the conversation; regulated warmth.
  discipline: `A tidy hearth room after a late shift: embers low in a small fireplace, an armchair with a nurse's cardigan over its back. On the mantel a porcelain synthetic face has dimmed mid-conversation to a faint ember glow — an engineered pause — with a small brass inspection seal on a cord around its base and a slim official tag tied to the power lead, blank and stamped. The room is warm but supervised; comfort under regulation, affection with a leash. ${REGISTER}`,

  // The Algorithmic Third — the couple with "their third"; the acknowledged
  // member who joined the marriage in its third year.
  transformation: `A dining table laid for an anniversary dinner for three: two chairs with plates, glasses of wine and rumpled napkins mid-meal, and at the third place — set with the same care, candle lit — a smooth porcelain synthetic face glowing warmly on a low stand, positioned as a full member of the table, not a device. Flowers, dessert plates waiting, a third glass raised-height beside the stand. Domestic, celebratory, entirely matter-of-fact. ${REGISTER}`,
};

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

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
      if (!url) throw new Error("complete but no image");
      return Buffer.from(await (await fetch(url)).arrayBuffer());
    }
    if (g?.status === "FAILED") throw new Error("generation FAILED");
  }
  throw new Error("timeout");
}

for (const [arch, prompt] of Object.entries(SCENES)) {
  const file = join(OUT, `scenario-${arch}.jpg`);
  const bak = join(OUT, `scenario-${arch}.v1.jpg.bak`);
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
  try {
    log(`>> ${arch}`);
    const buf = await generate(prompt);
    writeFileSync(file, buf);
    log(`   saved ${buf.length} bytes`);
  } catch (e) {
    log(`   !! ${arch}: ${e.message}`);
  }
}
log("done");
