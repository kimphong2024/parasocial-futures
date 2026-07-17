# Futures of Parasocial AI

FORE 6397 capstone platform — an interactive, cloud-based foresight tool on how AI reshapes social structures and relations by 2040, focused on parasocial AI. Everything that enters the library or the scenario set passes a human review gate first.

## What it does

| Piece | How |
|---|---|
| **Signal library** | 705-signal seed corpus (33 clusters), filter/facet browse, keyword + semantic search |
| **Live scanning** | Nightly (22:00 SGT) — Perplexity Sonar for the undirected sweep, Firecrawl for directed sources, Claude classifies into the existing taxonomy, URL + embedding dedup, hits land as `pending` |
| **Review queue** | Human approves/rejects/edits every scan hit and scenario draft before it publishes |
| **Scenario library** | Four Dator archetypes structured with Causal Layered Analysis, drafted by Claude from the approved evidence, human-edited, published |
| **Monte Carlo** | 7 editable driver distributions (PERT default) → 10k sampled futures → scenario probabilities, residual, tornado sensitivity |
| **Decision-support chat** | RAG over approved signals + published scenarios (Voyage embeddings + rerank), Claude streamed with `[S123]` citations |

## Run locally

```bash
npm install
cp .env.example .env   # fill in keys — everything degrades gracefully without them
npm start              # seeds the DB from server/seed/*.csv on first boot
# open http://localhost:8080
```

No `VOYAGE_API_KEY` → semantic features off. No scan keys → scans record the error and keep going.

## Deploy (Railway)

Dockerfile build via `railway.json`. Attach a volume at `/data` and set:

```
STATE_DB=/data/state.db
ANTHROPIC_API_KEY=…  VOYAGE_API_KEY=…
PERPLEXITY_API_KEY=…  FIRECRAWL_API_KEY=…
ENABLE_CRON=1  REFRESH_HOUR=22  REFRESH_TZ=Asia/Singapore
NODE_ENV=production
```

Then `railway up`. First boot auto-seeds the corpus and builds embeddings.

## Architecture

Node 22+ ESM, Express, `node:sqlite` (no ORM), vanilla JS frontend (no build step), hand-rolled SVG charts, Heartful Futures design system. Server modules:

```
server/
  server.js      routes + boot (seed → vector index → scheduler)
  db.js          schema + prepared statements
  scan.js        orchestrator: perplexity + firecrawl → classify → dedup → pending
  perplexity.js  6 themed sonar queries, weekly recency, tolerant JSON
  firecrawl.js   v2 scrape/crawl + Claude extraction (forced tool_use)
  scenarios.js   CLA drafting from a stratified evidence pack
  montecarlo.js  PERT/triangular/uniform/discrete, seeded, tornado terciles
  chat.js        RAG retrieval + SSE stream
  vectors.js     in-memory cosine index over SQLite BLOBs
  scheduler.js   in-process daily timer (Intl-based, DST-safe)
```

Human-in-the-loop is structural: scan hits insert as `pending`, scenario drafts as `draft`; only `/api/review/*` and `/api/scenarios/:id/publish` promote them, and both are UI actions.
