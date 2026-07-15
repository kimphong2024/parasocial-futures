#!/usr/bin/env bash
# 3D hero pipeline — stage 1: Janus-head turnaround references (Phoenix 1.0,
# fixed seed for cross-view consistency); stage 2 (separate invocation with
# `rodin`): feed the reference image ids to Leonardo's rodin-v2 for a GLB.
#
# Usage:
#   bash scripts/gen-3d.sh refs           # generate the 4 turnaround views
#   bash scripts/gen-3d.sh rodin id1 id2 id3 id4   # submit Rodin with image ids
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/server/public/img/rodin-refs"
MODELS="$DIR/server/public/models"
mkdir -p "$OUT" "$MODELS"

KEY=$(grep '^LEONARDO_API_KEY=' "$DIR/.env" | cut -d= -f2- | tr -d '"'"'"' \r\n')
MODEL="de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3"   # Leonardo Phoenix 1.0
SEED=20411
NEG="text, words, letters, watermark, logo, signature, illustration, cartoon, painting, bright background, daylight, sky, blue, purple, two heads, two separate objects, body, shoulders, neck stump, pedestal, stand, base, table, fine filigree, wire, static noise"

BASE="a single sculpted head floating in darkness, one face split vertically down the middle: the left half covered in thick soft clumps of green moss over dark stone, sculptural and chunky; the right half a smooth flawless white porcelain synthetic surface with a thin glowing golden seam where the halves meet; a complete floating head with a smoothly rounded finished underside, no neck, no pedestal, museum turntable photograph, pure black background, soft studio specimen lighting, clean sculptural forms"

log() { echo "[$(date +%H:%M:%S)] $*"; }

gen_view() {
  local name="$1" view="$2"
  log ">> $name"
  local body
  body=$(FULLPROMPT="$BASE, $view" NEG="$NEG" MODEL="$MODEL" SEED="$SEED" python3 - <<'PY'
import json, os
print(json.dumps({
  "prompt": os.environ["FULLPROMPT"],
  "negative_prompt": os.environ["NEG"],
  "modelId": os.environ["MODEL"],
  "width": 1024, "height": 1024,
  "seed": int(os.environ["SEED"]),
  "num_images": 1, "contrast": 4.0, "alchemy": False, "public": False,
}))
PY
)
  local gid
  gid=$(curl -sS --max-time 60 -X POST https://cloud.leonardo.ai/api/rest/v1/generations \
    -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "accept: application/json" \
    -d "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("sdGenerationJob",{}).get("generationId",""))' 2>/dev/null)
  if [ -z "$gid" ]; then log "   !! submit failed for $name"; return 1; fi
  local i resp status url img_id
  for i in $(seq 1 50); do
    sleep 4
    resp=$(curl -sS --max-time 40 -H "authorization: Bearer $KEY" -H "accept: application/json" \
      "https://cloud.leonardo.ai/api/rest/v1/generations/$gid")
    status=$(echo "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generations_by_pk"]["status"])' 2>/dev/null)
    if [ "$status" = "COMPLETE" ]; then
      url=$(echo "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generations_by_pk"]["generated_images"][0]["url"])' 2>/dev/null)
      img_id=$(echo "$resp" | python3 -c 'import json,sys;print(json.load(sys.stdin)["generations_by_pk"]["generated_images"][0]["id"])' 2>/dev/null)
      curl -sS --max-time 90 -o "$OUT/$name.jpg" "$url"
      log "   saved $name.jpg  image_id=$img_id"
      echo "$name=$img_id" >> "$OUT/image-ids.txt"
      return 0
    elif [ "$status" = "FAILED" ]; then
      log "   !! FAILED $name"; return 1
    fi
  done
  log "   !! timeout $name"; return 1
}

if [ "${1:-refs}" = "refs" ]; then
  : > "$OUT/image-ids.txt"
  gen_view "janus-front"  "front view facing the camera, the golden seam running vertically down the centre of the face, moss half on the left, porcelain half on the right"
  gen_view "janus-left"   "left profile view showing the thick mossy half of the head in full profile"
  gen_view "janus-right"  "right profile view showing the smooth porcelain half of the head in full profile"
  gen_view "janus-back"   "rear view of the head, moss half on one side and porcelain half on the other meeting at the golden seam down the back"
  log "REFS DONE — ids in $OUT/image-ids.txt"
  exit 0
fi

if [ "$1" = "rodin" ]; then
  shift
  log ">> rodin-v2 submit with ${#} reference images"
  local_body=$(python3 - "$@" <<'PY'
import json, sys
refs = [{"image": {"id": i, "type": "GENERATED"}, "strength": "HIGH"} for i in sys.argv[1:]]
print(json.dumps({
  "model": "rodin-v2",
  "public": False,
  "parameters": {
    "quantity": 1,
    "output_format": "glb",
    "mesh_mode": "Quad",
    "quality": "medium",
    "material": "PBR",
    "seed": 20400,
    "guidances": {"image_reference": refs},
  },
}))
PY
)
  resp=$(curl -sS --max-time 120 -X POST https://cloud.leonardo.ai/api/rest/v2/generations \
    -H "authorization: Bearer $KEY" -H "content-type: application/json" -H "accept: application/json" \
    -d "$local_body")
  echo "$resp" | python3 -m json.tool | head -40
  echo "$resp" > "$MODELS/rodin-submit.json"
  log "submit response saved to $MODELS/rodin-submit.json"
fi
