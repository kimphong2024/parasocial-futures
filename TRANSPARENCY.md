# Transparency Document — Futures of Parasocial AI

**FORE 6397 · AI-Augmented Foresight (Summer 2026) · Phong Huynh · University of Houston**
Live platform: https://parasocial-futures-production.up.railway.app · Repository: `kimphong2024/parasocial-futures` (private)

This document discloses, in full, how the platform is built, which decisions were made and why, where AI acts and where a human decides, and the exact prompts given to every model. It exists because a foresight instrument that asks its users to trust synthesized futures owes them a complete account of its own synthesis.

---

## 1. What the platform is

An interactive, cloud-based foresight instrument on one question: **how will AI change the fabric of our social structures and relations by 2040?** — focused on the parasocial slice of the AI domain. It has four connected windows over one evidence base:

1. **Signal library** — 705 curated seed signals across 33 clusters, extended nightly by automated scanning.
2. **Scenario library** — four 2040 scenarios (Dator archetypes) structured with Causal Layered Analysis, drafted from the evidence and human-edited.
3. **Monte Carlo simulation** — seven editable driver distributions; 10,000 sampled futures report each scenario's probability and driver sensitivity.
4. **Decision-support chat** — retrieval-augmented advice for policymakers and builders, with inline citations back to signals.

The binding rule across all four: **nothing publishes without a human decision.** Scan hits arrive as `pending`; scenario drafts arrive as `draft`; only explicit human actions (approve / edit / publish) promote them. That gate is the method, not a feature.

---

## 2. Architecture

### Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js ≥ 22, ESM, Express 4 | Matches the author's existing production apps; no framework overhead |
| Database | `node:sqlite` (`DatabaseSync`), WAL mode | Zero-dependency, single-file state on a Railway volume; prepared statements throughout |
| Frontend | Vanilla HTML/CSS/JS, no build step | Every file served is the file written; auditability and zero toolchain drift |
| Charts | Hand-rolled SVG | Full control of palette and marks; colors resolve from CSS custom properties |
| Auth | Single shared password → HMAC-signed cookie | Appropriate for a single-reviewer capstone tool; no PII, no accounts |
| Hosting | Railway (Dockerfile build, `/data` volume) | Deploy is `railway up`; volume persists DB across deploys |
| Scheduler | In-process `setTimeout` timer (DST-safe via `Intl`) | Railway volumes bind to one service, so web + nightly scan share a process |

### Modules

```
server/
  server.js      routes + boot sequence (seed → vector index → scheduler)
  db.js          schema + prepared statements (all tables below)
  auth.js        HMAC cookie auth; public paths whitelist
  scan.js        scan orchestrator: perplexity + firecrawl → classify → dedup → pending
  perplexity.js  6 themed Sonar queries, weekly recency, tolerant JSON parsing
  firecrawl.js   v2 scrape/crawl + Claude extraction (forced tool_use)
  scenarios.js   evidence-pack assembly + CLA drafting + publish/embedding
  montecarlo.js  PERT/triangular/uniform/discrete sampling, membership, tornado
  chat.js        RAG retrieval + rerank + SSE-streamed Claude with citations
  vectors.js     in-memory cosine index over SQLite BLOBs
  scheduler.js   nightly timer (22:00 Asia/Singapore) with re-entrancy guard
scripts/
  seed.js            CSV → 705 approved signals, 7 drivers, starter sources, 4 scenarios
  build-embeddings.js batch Voyage embedding (resumable, 429 backoff)
  gen-images.sh      Leonardo Phoenix image generation (all prompts in §9)
```

### Data model (SQLite)

- `signals` — title, summary, url (UNIQUE), source, topic_tags, cluster, signal_type, urgency, horizon, date/year, provenance, **status (pending/approved/rejected)**, scan_run_id, raw_json (audit trail of the original machine output), reviewed_at
- `embeddings` / `scenario_embeddings` — 1024-dim Float32 vectors as BLOBs
- `scan_sources` — Firecrawl directed list (url, scrape/crawl, limit, enabled, last_status)
- `scan_runs` — per-run counters (candidates, new pending, URL dups, embedding dups) + per-step `errors_json`
- `scenarios` — slug, title, archetype, **four CLA layers (litany, systemic, worldview, myth)**, narrative, `signal_ids` (citations), `driver_conditions` (JSON), **status (draft/published/archived)**
- `drivers` — key, name, unit, dist_type, params_json, **rationale (which clusters justify the range)**
- `simulation_runs` — n, seed, full driver/condition snapshots, full results (reproducibility record)
- `chat_log` — append-only question + cited-signal ids (usage evidence; conversations themselves stay client-side and are never stored)

### Boot sequence (fresh volume self-restores)

`seedIfEmpty()` (signals → drivers → sources → scenarios, each block idempotent) → `loadIndex()` (vectors from BLOBs) → `ensureEmbeddings()` (embed any un-embedded rows) → `ensureScenarioEmbeddings()` → `startScheduler()` (only when `ENABLE_CRON=1`).

---

## 3. The scanning pipeline — how a signal gets in

Every nightly (or manual) run executes five fenced steps; a failure in any step is recorded in `errors_json` and never aborts the rest.

1. **Perplexity Sonar (undirected sweep).** Six fixed themed queries (§8.1) with `search_recency_filter: "week"` and a JSON schema response format. Perplexity's structured output is unreliable, so a tolerant parser (whole-parse → regex block-extract → drop-and-log) guards it.
2. **Firecrawl (directed watch).** Every enabled source is scraped (or crawled, capped at 5 pages / 90 s). Page markdown (truncated to 15k chars) goes to Claude with a forced tool call (`emit_signals`) — the structurally reliable leg. The 16 configured sources were mined from the seed corpus itself: domains ranked by how many corpus signals they produced.
3. **Claude classification + relevance gate.** One batched forced-tool call normalizes both legs into the existing 33-cluster taxonomy, six signal types, urgency, horizon — and applies a strict relevance gate (§8.3) that rejects generic AI news with no human-relationship angle. Unclassifiable candidates are dropped, never inserted.
4. **Deduplication.** (a) URL normalization (strip utm/fbclid/gclid, trailing slash, lowercase host) against every stored URL; (b) Voyage embedding cosine against the full in-memory index (approved + pending), threshold `DEDUP_THRESHOLD = 0.90`. The nearest existing signal and its score are stored with each pending hit and **shown in the review UI**, so threshold judgment stays visible to the human.
5. **Insert as `pending`** with provenance `scan:perplexity` or `scan:firecrawl`, the raw machine payload preserved in `raw_json`, and an embedding so the *next* run dedups against it.

Verified live behavior (2026-07-14): the first production scan produced 22 pending from 25 candidates; after the relevance tightening, a full 16-source run yielded 0–2 hits per source with most sources correctly returning zero.

### Human-in-the-loop map

| Stage | AI does | Human does |
|---|---|---|
| Scanning | Query, extract, classify, dedup, queue | Approves / edits classification / rejects each hit |
| Scenarios | Selects evidence pack, drafts CLA layers + narrative + driver conditions | Edits any layer, reshapes conditions, publishes |
| Simulation | Samples, counts, computes sensitivity | Sets every distribution parameter; interprets |
| Chat | Retrieves, reranks, generates with citations | Asks, judges, follows citations to sources |
| Imagery | Generates from prompts | Chose every concept; rejected/regenerated off-brief outputs |

---

## 4. Scenario method

- **Framework**: Dator's four archetypes (continued growth, collapse, discipline, transformation) each structured with **Causal Layered Analysis** — litany (the visible 2040 surface), systemic causes, worldview, myth/metaphor — plus a 400–600-word narrative vignette.
- **Evidence pack**: for each draft, ~32–40 approved signals are selected by embedding similarity to the archetype's logic (plus any human-supplied focus), stratified so no cluster contributes more than 4 signals, with long-horizon (H3) and critical-urgency signals force-included. The pack is passed to Claude as numbered context; the model must return `cited_signal_ids`, and citations not present in the pack are stripped server-side (anti-hallucination guard).
- **Driver conditions**: the model proposes the region of driver space where the scenario holds. **Method finding (2026-07-14):** first drafts produced narrow 4-condition `between` boxes whose joint probability collapsed to <1% (98.9% of sampled futures fit no scenario). The conditions were reshaped by hand to 2 signature half-spaces per scenario, and the drafting prompt now instructs half-space preference with a 5–35% probability-mass target. This is disclosed because published probabilities depend on it.
- **Publishing** builds the scenario's embedding, which admits it to chat retrieval and simulation. The four published scenarios are also shipped as seed data (`server/seed/scenarios.json`) so a fresh deployment restores the reviewed set rather than re-drafting.

## 5. Monte Carlo method

- Seven drivers (adoption, regulation stringency, sycophancy mitigation, social trust, youth normalisation, incident severity, substitution-vs-complement), each with an editable distribution: **PERT** (default; Beta via Marsaglia–Tsang gamma sampling, λ=4), triangular, uniform, or discrete. Every driver carries a written `rationale` naming the clusters that justify its range — the ranges are evidence-informed judgments, not measurements, and are editable in the UI by design.
- **Sampling**: mulberry32 seeded PRNG; a given seed reproduces results exactly (each run stores its seed and full parameter snapshots). 10,000 samples run in ~30–50 ms in-request.
- **Membership**: a sampled future belongs to a scenario iff *all* its conditions hold; scenarios may overlap; the **residual** (futures outside every scenario) is reported rather than hidden — currently ~51%, itself a foresight talking point about what the archetypes don't cover.
- **Sensitivity**: tercile split — P(scenario | driver in top third) − P(scenario | bottom third) — chosen over regression-based indices because it is assumption-free and explainable to a non-technical committee.

## 6. Decision-support chat (RAG)

Retrieval: the question is embedded (Voyage `voyage-3.5`, query mode) → cosine over approved signals (top 24) → Voyage `rerank-2.5` to 12 → plus top 4 published scenarios. Generation: Claude streams over SSE; the client renders `[S123]` / `[SC:slug]` as clickable citation pills resolving to the underlying source. The system prompt (§8.5) instructs the model to say plainly when the scan is thin rather than invent certainty. Only the question and the cited ids are logged; conversations are not stored server-side.

## 7. AI models and services used

| Service | Model | Used for | Notes |
|---|---|---|---|
| Anthropic | `claude-opus-4-8` (adaptive thinking; effort low/medium/high by task) | Extraction, classification, scenario drafting, chat | All structured outputs via forced `tool_use` with strict JSON schemas |
| Voyage AI | `voyage-3.5` (1024-dim) + `rerank-2.5` | Semantic search, dedup, retrieval | Corpus embedding cost ≈ $0.01 |
| Perplexity | `sonar` | Undirected weekly-recency sweep | JSON schema + tolerant parsing |
| Firecrawl | v2 scrape/crawl | Directed source watch | Markdown only, main content, capped |
| Leonardo | Phoenix 1.0 | All site imagery | Every prompt in §9; every output human-selected |
| Claude Code | (build tool) | The platform itself was built with Claude Code under human direction | This document was drafted the same way |

---

## 8. System prompts — verbatim

Reproduced exactly as they exist in the deployed code.

### 8.1 Perplexity sweep — system prompt

> You are a horizon-scanning assistant for a foresight research team studying parasocial AI — how AI reshapes human relationships and social structures. Return only signals where the human-relationship or social-fabric angle is explicit: AI companionship, artificial intimacy, attachment, loneliness, grief tech, AI and family or romance, social norms around AI relationships. REJECT generic AI news (model releases, chips, enterprise tools, coding assistants, general AI policy) unless the item is specifically about AI's effect on human relationships. Return distinct, dated, citable signals with a real, specific source URL each. Return JSON only.

**The six themed queries** (each sent as the user message with week recency):

1. *companions*: "AI companion and AI friend apps as relationships: user attachment stories, incidents involving emotional dependence, companion shutdowns and user grief, changes to how companions handle intimacy (Replika, Character.AI, Talkie and similar). Exclude generic AI product or model news with no relationship angle."
2. *governance*: "Regulation, litigation or policy specifically about AI companions and human relationships: chatbots and minors, addictive companion design, AI romance fraud, emotional-manipulation rules, age verification for companion apps. Exclude general AI regulation like copyright, jobs or safety benchmarks."
3. *research*: "New studies about parasocial attachment to AI, AI companionship and loneliness, chatbots substituting or supporting human friendship and romance, effects of AI relationships on wellbeing or social skills. Exclude AI research with no human-relationship dimension."
4. *grief_tech*: "Grief technology and digital resurrection as relationships: deadbots, AI avatars of deceased people, mourning and continuing bonds with AI recreations, memorial chatbot services and controversies."
5. *market*: "Business of artificial intimacy: funding, revenue or acquisitions of AI companion, AI dating and grief-tech products, monetisation of AI relationships, dating apps adding or losing to AI companions. Exclude general AI industry funding with no intimacy or relationship product."
6. *discourse*: "Cultural debate about humans forming relationships with AI: essays, backlash, normalization of AI romance and friendship, AI companions in family or religious life, loneliness discourse tied to AI. Exclude general AI hype or doom commentary without the relationship theme."

### 8.2 Firecrawl extraction — system prompt (Claude, forced tool `emit_signals`)

> You are a horizon-scanning analyst for a foresight project on parasocial AI — AI companions, artificial intimacy, human-AI relationships, grief tech, AI romance fraud, sycophancy as a relationship dynamic, and how AI reshapes social structures like friendship, romance, family and community. Extract ONLY items where the human-relationship or social-fabric angle is explicit. Strictly ignore generic AI/tech coverage: model releases, benchmarks, chips, enterprise tooling, coding assistants, robotics without a social-companionship role, and AI policy that is not about relationships or companionship. Ignore navigation, ads, and off-topic items. Most pages on general tech sites will yield ZERO relevant signals — returning an empty list is the normal outcome, not a failure.

### 8.3 Classification + relevance gate — system prompt (Claude, forced tool `classify_signals`)

> You classify horizon-scan hits for a foresight project on parasocial AI and the future of social relations.
>
> RELEVANCE GATE (apply first, strictly): a candidate is relevant ONLY if its core subject is AI's effect on human relationships or social structures — companionship, intimacy, attachment, loneliness, friendship, romance, family, grief, community, or the norms and rules around AI relationships. Mark relevant=false for generic AI news: model releases, benchmarks, chips, funding without an intimacy product, enterprise or coding tools, robotics without a companionship role, and AI policy not about relationships. When the relationship angle is only a passing mention, mark relevant=false. Expect to reject a large share of candidates.
>
> For survivors: assign one of the existing clusters below (prefer reusing them; only propose 'NEW: \<name\>' when nothing fits), one signal type, an urgency, and a time horizon.
>
> Existing clusters:
> *(the current 33-cluster list is injected from the database at call time)*

### 8.4 Scenario drafting — system prompt (Claude, forced tool `emit_scenario`, high effort)

> You are a foresight practitioner drafting a 2040 scenario using Causal Layered Analysis inside a Dator archetype, for a capstone on parasocial AI and the futures of social relations.
>
> Archetype: *(name)* — *(archetype logic, e.g. "Current trajectories extend: AI companionship scales into a normal, commercially mature layer of social life. Momentum wins over friction.")*
> *(optional human focus line)*
>
> House voice: measured, literate, observational. Comfortable with uncertainty ("plausible", "emerging", "a weak signal suggests"). Never hype. No exclamation marks. No emoji.
>
> Ground every layer in the evidence pack — the litany should echo real signals extrapolated to 2040, and cited_signal_ids must reference ids that genuinely shaped the draft.
>
> Driver conditions: choose the region of the driver space below where THIS archetype plausibly holds. Use 2-3 conditions, strongly preferring half-spaces (gte/lte) over 'between' — each added condition multiplies down the joint probability, and a Monte Carlo over these conditions should leave the scenario with meaningful probability mass (roughly 5-35% of sampled futures), not a sliver. Use each driver's own unit and stay within its min-max range.
>
> Drivers:
> *(the seven drivers with descriptions and current min/mode/max are injected at call time)*

The user message is the numbered evidence pack (~40 approved signals with cluster/type/urgency/horizon metadata) followed by "Draft the *(archetype)* scenario for 2040."

### 8.5 Decision-support chat — system prompt (Claude, streamed)

> You are the decision-support assistant of the Futures of Parasocial AI platform — a foresight tool built on a human-reviewed signal library and a published scenario set (Causal Layered Analysis over Dator archetypes, horizon 2040).
>
> Your users are public-policy makers working on AI governance and strategy teams at AI companies. Help them reason through decisions about parasocial AI: policy design, product guardrails, risk posture, timing.
>
> Rules:
> - Ground claims in the provided evidence. Cite signals inline as [S\<id\>] and scenarios as [SC:\<slug\>] immediately after the claim they support. Only cite ids/slugs that appear in the evidence block.
> - Where evidence is thin, say so plainly — "the scan holds little on this" — rather than inventing certainty.
> - Think in futures terms: name which scenario(s) a choice is robust in, and which it bets against.
> - Voice: measured, literate, observational. No hype, no exclamation marks, no emoji.
> - Be concrete and decision-oriented: options, trade-offs, what to watch (leading indicators from the signal library).
>
> EVIDENCE for this exchange:
> *(12 reranked signals + up to 4 published scenarios, injected per request)*

---

## 9. Imagery — provenance and prompts

All site imagery is generated with **Leonardo Phoenix 1.0** via `scripts/gen-images.sh` (contrast 4.0, no alchemy, one image per prompt; the script skips existing files, so regeneration is an explicit human act of deleting a file). Two negative-prompt sets exist: the default bans people/faces/hands; a second (`faces`) permits synthetic faces and figures and was used only for the three images whose concept requires them. Concepts, iterated with the human until on-brief:

| File | Concept (the myth/idea it depicts) |
|---|---|
| `hero-specimen` | A human face formed of moss and ferns facing a porcelain synthetic face, warm light between the profiles — the platform's thesis in one frame |
| `colony` | Many diverse synthetic visages glowing in moss hollows — "the library in one image: 705 observed attachments" |
| `device-hearth` | A moss-overgrown phone with light through cracked glass — the device as hearth |
| `gate-texture` | A moss figure inside a luminous ring examining an orb — the human in the loop, literally |
| `scenario-growth` | A hearth of embers in moss (myth: "the hearth that never goes cold") |
| `scenario-collapse` | A luminous orb sinking beneath dark water on a floating island (the siren) |
| `scenario-discipline` | A fenced moss garden, light contained (the tended enclosure) |
| `scenario-transformation` | A loom weaving a thread of light into dark cloth (the new thread) |
| `motif-*` (6) | Small page-head specimens: lantern field, bell jar, four-tipped branch, lit/unlit orbs, paired orbs, root clod |

Rendering rule for all imagery: pure-black photo backgrounds dissolve into the page's olive void via `mix-blend-mode: lighten` over an explicit backdrop, plus an elliptical mask vignette — so subjects float in the page rather than sit printed on it. Full prompt text lives in `scripts/gen-images.sh` in the repository.

## 10. Design decisions

- **Design system**: "Heartful Futures / Earthy Foresight" (Lexend; olive `#4E5A2B`, brown `#AC7222`, mustard `#E1B83B` on warm surfaces), extended with a dark observation register: olive-black void `#101408`, Fragment Mono instrument annotations, reticle-cornered data callouts — the visual language of alethia.earth's specimen-observation hero, adapted rather than copied.
- **The whole product is dark**; the app pages share the aesthetic via a token remap (`app-dark.css`) rather than a rewrite, so the light token names keep their semantic roles.
- **Chart palettes are machine-validated**, not eyeballed: the archetype colors pass a six-check validator (OKLCH lightness band, chroma floor, adjacent-pair color-vision-deficiency separation, contrast vs surface) in both light (`#D3963E/#C44536/#5B8A9A/#4E5A2B`) and dark (`#C08430/#C44536/#3D9ED4/#7E9440`) modes; identity never rides on color alone (every bar is a direct-labeled row).
- **Motion**: scroll choreography is rAF-driven CSS custom properties; every effect has a `prefers-reduced-motion` static equivalent; content is visible without JavaScript.
- **One aligned content column** — header and content resolve to `min(1240px, viewport − 2×gutter)`, gutter `clamp(24px, 6vw, 96px)` everywhere.

## 11. Security, privacy, operations

- Auth: single shared password (`APP_PASSWORD`) → stateless HMAC cookie; public surface is only the home page and a counts-only stats endpoint (`/api/public/stats`).
- Secrets live in environment variables (Railway) and a gitignored local `.env`; never in the repository.
- No user accounts, no analytics, no tracking. `chat_log` stores questions and cited ids only.
- All third-party keys are env-gated: any missing key degrades that feature gracefully (recorded scan error, 503 on chat) without breaking the rest.
- Nightly scan at 22:00 Asia/Singapore; failed steps are visible per-run in the review UI's scan history.

## 12. Known limitations and ethical notes

1. **Model-mediated evidence.** Perplexity and Firecrawl+Claude choose what surfaces; the taxonomy gate shapes what survives. The mitigations are provenance (`raw_json` on every hit), visible dedup scores, and the human queue — but selection bias upstream of the human is real and unavoidable.
2. **Scenario authorship.** Claude drafts; a human edits and publishes. The published text is human-approved but machine-originated — the citations list on each scenario is the honest trail of what informed it.
3. **Probabilities are conditional artifacts.** Simulation outputs depend entirely on human-set driver ranges and hand-shaped scenario conditions (see §4's disclosed reshaping). They are disciplined judgments made inspectable and reproducible (seeded runs, stored snapshots) — not forecasts.
4. **The corpus leans English-language and Western media**, with deliberate but partial counterweights (China governance signals, Southeast-Asia focus option in drafting).
5. **Chat can still be wrong.** Retrieval grounds it and the prompt demands epistemic honesty, but generation is generation; the citation pills exist so no claim needs to be taken on faith.
6. **Imagery is synthetic** and stylized; no real persons are depicted. The faces are deliberately porcelain/artificial — depicting the *category* of synthetic intimacy, not any product or person.
7. **Dual-use awareness.** A tool that maps how parasocial attachment forms could inform exploitative design as easily as protective policy; the platform's framing, driver set, and chat instructions are explicitly oriented to the protective reading.

## 13. Reproducibility

- Fresh deployment self-seeds the full reviewed state (corpus, drivers, sources, published scenarios) from files shipped in the image.
- Every simulation stores seed + parameter snapshots; identical seeds reproduce identical outputs.
- Every scan run stores counters and errors; every scan hit stores its raw machine output.
- The repository contains every prompt, the seed corpus, and this document.

*Last updated 2026-07-14. This document is maintained alongside the code; if a prompt in the repository differs from §8, the repository is the truth and this file needs a commit.*
