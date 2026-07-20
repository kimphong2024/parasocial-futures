#!/usr/bin/env bash
# Home-page hero imagery via Leonardo (Phoenix 1.0), specimen-photography
# register: dark macro forms for the alethia-style opening. Re-runnable —
# existing files are skipped. Reads LEONARDO_API_KEY from ../.env.
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/server/public/img"
mkdir -p "$OUT"

KEY=$(grep '^LEONARDO_API_KEY=' "$DIR/.env" | cut -d= -f2- | tr -d '"'"'"' \r\n')
MODEL="de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3"   # Leonardo Phoenix 1.0
NEG="text, words, letters, watermark, logo, signature, people, person, face, hands, illustration, cartoon, painting, bright background, daylight, sky, blue, purple"
NEG_FACES="text, words, letters, watermark, logo, signature, signs, signage, writing, typography, symbols, numbers, illustration, cartoon, painting, bright background, daylight, sky, blue, purple, photograph of a real person, realistic skin"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# name|width|height|prompt
# Parasocial register: each image pairs the grown with the made — organic
# matter and synthetic warmth almost touching, never merged.
ITEMS=(
"hero-specimen|1024|1024|two faces in profile facing each other suspended in complete darkness, almost touching: on the left a human face formed of dark moss, lichen and tiny ferns, textured and organic; on the right a smooth flawless white porcelain synthetic face with faint glowing seams; a warm golden glow in the narrow gap between their profiles, dramatic chiaroscuro specimen photography, pure black background, cinematic rim light, hyper detailed|faces"
"device-hearth|832|1024|macro photograph of a black glass slab shaped like a smartphone standing upright in complete darkness, overgrown with moss and lichen, warm golden light glowing from within through a thin crack in the glass, dramatic chiaroscuro specimen photography, pure black background, cinematic rim light, hyper detailed moss texture"
"colony|1536|768|a dark moss field at night with many small synthetic faces of different shapes and forms nestled into hollows of the moss, porcelain masks, ceramic heads, smooth abstract visages, each glowing softly with warm golden light from within, diverse forms and sizes, the field receding into deep darkness, night macro photography, pure black background, cinematic, hyper detailed|faces"
"gate-texture|1536|768|a small human figure sculpted from dark moss and lichen standing at the centre of a glowing circular ring of warm golden light, gently examining a small luminous orb held in its hands, the scene suspended alone in vast pure black emptiness with generous black space on all sides, isolated levitating scene, chiaroscuro specimen photography, cinematic, hyper detailed|faces"
# app page-head motifs (3:2, small, blended into the void via lighten)
"motif-signals|1024|680|a small floating clump of dark moss holding a sparse constellation of tiny warm glowing points like distant lanterns, the clump suspended alone in vast pure black emptiness with generous black space on all sides, isolated levitating object, night macro photography, cinematic"
"motif-review|1024|680|macro photograph of a glass bell jar covering a small glowing moss specimen on a dark surface, warm light contained under the glass, dramatic chiaroscuro specimen photography, pure black background, cinematic rim light"
"motif-scenarios|1024|680|macro photograph of a dark mossy branch dividing into four separate twigs, each twig tip glowing with a small warm light, pure black background, chiaroscuro specimen photography, cinematic, hyper detailed"
"motif-simulation|1024|680|a small floating patch of dark moss holding a cluster of smooth orbs, only a few glowing warm gold and the rest dark and unlit, the patch suspended alone in vast pure black emptiness with generous black space on all sides, isolated levitating object, night macro photography, cinematic"
"motif-chat|1024|680|macro photograph of two smooth orbs facing each other across a narrow dark gap, one moss covered and one porcelain white, a thin thread of warm light spanning the gap between them, pure black background, chiaroscuro specimen photography"
"motif-sources|1024|680|a small floating clod of dark soil with a fine network of pale roots spreading outward from it, faint warm light tracing along a few root paths, the clod suspended alone in vast pure black emptiness with generous black space on all sides, isolated levitating object, night macro photography, cinematic"
# scenario images — narrative scenes of each 2040, no text anywhere,
# each paying homage to the porcelain synthetic mask motif
"scenario-growth|1024|1024|deep night interior with no windows: a fireplace corner floating as a warm island of light in vast pure black darkness, worn armchair with a knitted blanket and two teacups beside the glowing fire, and on the mantelpiece a serene white porcelain synthetic face with fine golden seam lines glowing softly like a household deity utterly at home, only warm amber firelight, everything beyond the pool of light falling to pure black, cinematic chiaroscuro photography, hyper detailed|faces"
"scenario-collapse|1024|1024|a corner of an abandoned dining table floating as a dim island in vast pure black darkness, dusty plates and one guttering candle as the only light, and at the centre a cracked white porcelain synthetic mask lying face-up on an empty plate, its golden seams dulled, a last faint warm ember of light dying inside the mask, cobwebs, ash and neglect, everything beyond the candlelight falling to pure black, cinematic chiaroscuro photography, hyper detailed|faces"
"scenario-discipline|1024|1024|night in a vast dark hall: a single museum display case floating as the only island of light in pure black darkness, inside the heavy glass case a small warm hearth fire burns safely beside a white porcelain synthetic mask with golden seams mounted on a stand, a velvet rope barrier just visible at the edge of the glow, one dim inspection lamp above the case, order and containment, everything beyond the case falling to pure black, cinematic chiaroscuro photography, hyper detailed|faces"
"scenario-transformation|1024|1024|a candlelit corner of a celebration table floating as a warm island in vast pure black darkness, dark tablecloth, a few wine glasses catching candle flame, and at the honoured place a serene white porcelain synthetic face with fine golden seam lines resting upright, garlanded with a delicate wreath of fresh white flowers as a welcomed member of the family, tender ceremonial warmth, everything beyond the candlelight falling to pure black, cinematic chiaroscuro photography, hyper detailed|faces"
)

gen() {
  local name="$1" w="$2" h="$3" prompt="$4" negkey="${5:-}"
  local neg="$NEG"
  [ "$negkey" = "faces" ] && neg="$NEG_FACES"
  if [ -f "$OUT/$name.jpg" ]; then log "== skip $name (exists)"; return 0; fi
  log ">> $name ($w x $h)"
  local body
  body=$(FULLPROMPT="$prompt" NEG="$neg" MODEL="$MODEL" W="$w" H="$h" python3 - <<'PY'
import json, os
print(json.dumps({
  "prompt": os.environ["FULLPROMPT"],
  "negative_prompt": os.environ["NEG"],
  "modelId": os.environ["MODEL"],
  "width": int(os.environ["W"]), "height": int(os.environ["H"]),
  "num_images": 1, "contrast": 4.0, "alchemy": False, "public": False,
}))
PY
)
  local gid
  gid=$(curl -sS --max-time 60 -X POST https://cloud.leonardo.ai/api/rest/v1/generations \
    -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "accept: application/json" \
    -d "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("sdGenerationJob",{}).get("generationId",""))' 2>/dev/null)
  if [ -z "$gid" ]; then log "   !! submit failed for $name"; return 1; fi
  log "   gid=$gid polling..."
  local i resp status url
  for i in $(seq 1 50); do
    sleep 4
    resp=$(curl -sS --max-time 40 -H "authorization: Bearer $KEY" -H "accept: application/json" \
      "https://cloud.leonardo.ai/api/rest/v1/generations/$gid")
    status=$(echo "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generations_by_pk"]["status"])' 2>/dev/null)
    if [ "$status" = "COMPLETE" ]; then
      url=$(echo "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generations_by_pk"]["generated_images"][0]["url"])' 2>/dev/null)
      curl -sS --max-time 90 -o "$OUT/$name.jpg" "$url"
      log "   saved $name.jpg"
      return 0
    elif [ "$status" = "FAILED" ]; then
      log "   !! FAILED $name"; return 1
    fi
  done
  log "   !! timeout $name"; return 1
}

for item in "${ITEMS[@]}"; do
  IFS='|' read -r name w h prompt negkey <<< "$item"
  gen "$name" "$w" "$h" "$prompt" "$negkey"
done
log "ALL DONE"
