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
| Auth | None — fully open | A public demonstration instrument; all pages and actions exposed by design |
| Hosting | Railway (Dockerfile build, `/data` volume) | Deploy is `railway up`; volume persists DB across deploys |
| Scheduler | In-process `setTimeout` timer (DST-safe via `Intl`) | Railway volumes bind to one service, so web + nightly scan share a process |

### Modules

```
server/
  server.js      routes + boot sequence (seed → vector index → scheduler)
  db.js          schema + prepared statements (all tables below)
  scan.js        scan orchestrator: perplexity + firecrawl → classify → dedup → pending
  cluster.js     mean-centred embedding grouping of the review queue + LLM group labels
  report.js      the live synthesis report: composition hash, evidence pack, citation filter
  quotes.js      retained source text + deterministic verbatim-quotation check
  perplexity.js  12 themed Sonar queries, weekly recency, tolerant JSON parsing
  firecrawl.js   v2 scrape/crawl + Claude extraction (forced tool_use)
  scenarios.js   evidence-pack assembly + CLA drafting + publish/embedding
  montecarlo.js  PERT/triangular/uniform/discrete sampling, membership, tornado
  chat.js        RAG retrieval + rerank + SSE-streamed Claude with citations
  vectors.js     in-memory cosine index over SQLite BLOBs
  scheduler.js   nightly timer (22:00 Asia/Singapore) with re-entrancy guard
scripts/
  seed.js            CSV → 705 approved signals, 7 drivers, starter sources, 4 scenarios
  build-embeddings.js batch Voyage embedding (resumable, 429 backoff)
  gen-images.sh      Leonardo Phoenix image generation (all prompts in §10)
```

### Data model (SQLite)

- `signals` — title, summary, url (UNIQUE), source, topic_tags, cluster, signal_type, urgency, horizon, date/year, provenance, **status (pending/approved/rejected)**, scan_run_id, raw_json (audit trail of the original machine output), reviewed_at
- `embeddings` / `scenario_embeddings` — 1024-dim Float32 vectors as BLOBs
- `scan_sources` — Firecrawl directed list (url, scrape/crawl, limit, enabled, last_status)
- `scan_runs` — per-run counters (candidates, new pending, URL dups, embedding dups, relevance rejects) + per-step `errors_json`
- `scenarios` — slug, title, archetype, **four CLA layers (litany, systemic, worldview, myth)**, narrative, `signal_ids` (citations), `driver_conditions` (JSON), **status (draft/published/archived)**
- `drivers` — key, name, unit, dist_type, params_json, **rationale (which clusters justify the range)**
- `simulation_runs` — n, seed, full driver/condition snapshots, full results (reproducibility record)
- `article_text` / `quotes` — retained full scrape per signal (hash-pinned) and every quotation that passed the verbatim check; `signals.content_sha256` pins the text a signal was classified from
- `chat_log` — append-only question + cited-signal ids (usage evidence; conversations themselves stay client-side and are never stored)

### Boot sequence (fresh volume self-restores)

`seedIfEmpty()` (signals → drivers → sources → scenarios, each block idempotent) → `loadIndex()` (vectors from BLOBs) → `ensureEmbeddings()` (embed any un-embedded rows) → `ensureScenarioEmbeddings()` → `startScheduler()` (only when `ENABLE_CRON=1`).

---

## 3. The scanning pipeline — how a signal gets in

Every nightly (or manual) run executes five fenced steps; a failure in any step is recorded in `errors_json` and never aborts the rest.

1. **Perplexity Sonar (undirected sweep).** Twelve fixed themed queries (§9.1) with `search_recency_filter: "week"`, each asked for up to 10 distinct items with a last-48-hours priority, and a JSON schema response format. Perplexity's structured output is unreliable, so a tolerant parser (whole-parse → regex block-extract → drop-and-log) guards it.
2. **Firecrawl (directed watch).** Every enabled source is scraped (or crawled, capped at 5 pages / 90 s). Page markdown (truncated to 15k chars) goes to Claude with a forced tool call (`emit_signals`) — the structurally reliable leg. Front-page teasers are then **followed through**: up to 3 not-yet-known article URLs per source are scraped and re-extracted from full article text, so classification judges real content rather than a headline; any follow-through failure keeps the teaser. The 16 configured sources were mined from the seed corpus itself: domains ranked by how many corpus signals they produced.
3. **Claude classification + relevance gate.** One batched forced-tool call normalizes both legs into the existing 33-cluster taxonomy, six signal types, urgency, horizon — and applies a strict relevance gate (§9.3) that rejects generic AI news with no human-relationship angle. Unclassifiable candidates are dropped, never inserted. The number of rejects is recorded per run (`rejected_relevance`) and shown in the run history, so a low new-pending count is always explainable.
4. **Deduplication.** (a) URL normalization (strip utm/fbclid/gclid, trailing slash, lowercase host) against every stored URL; (b) Voyage embedding cosine against the full in-memory index (approved + pending), threshold `DEDUP_THRESHOLD = 0.90`. The nearest existing signal and its score are stored with each pending hit and **shown in the review UI**, so threshold judgment stays visible to the human.
5. **Insert as `pending`** with provenance `scan:perplexity` or `scan:firecrawl`, the raw machine payload preserved in `raw_json`, and an embedding so the *next* run dedups against it.

**Horizon audit.** Beyond intake classification, a dedicated on-demand LLM pass (triggerable from the Scan settings page) re-judges every approved signal's time horizon at high reasoning effort against strict definitions (H1 = already unfolding before 2030; H2 = requires named developments, 2030–2035; H3 = stacked slow preconditions, 2036–2040+), judging the phenomenon's social arrival rather than the article's publication date. Each signal stores the judge's 2–4-sentence written reasoning (`horizon_reasoning`), shown in the library drawer — the horizon field is never a bare label.

**User control and per-run provenance.** The sweep themes, the Firecrawl source list, the scan knobs (search window, follow-through limit, duplicate threshold) and the relevance-gate text itself are all editable in the app's Scanning page — the reviewer controls what is scanned, not just what is approved. To keep that power accountable, every run records in `detail_json` exactly what it ran with: per-theme and per-source yield, the full list of candidates the gate rejected (auditable from the run history), the settings used, and the verbatim gate text (flagged when it differs from the shipped default documented in §9.3).

Verified live behavior (2026-07-14): the first production scan produced 22 pending from 25 candidates; after the relevance tightening, a full 16-source run yielded 0–2 hits per source with most sources correctly returning zero.

### Human-in-the-loop map

| Stage | AI does | Human does |
|---|---|---|
| Scanning | Query, extract, classify, dedup, queue | Approves / edits classification / rejects — per hit, or as a reviewed batch (see below) |
| Queue triage | Groups pending hits by embedding proximity and names each group | Reads the group, then decides about it as a unit |
| Report | Drafts the synthesis from approved evidence; citations filtered server-side | Asks for it; every claim is followed to its source |
| Scenarios | Selects evidence pack, drafts CLA layers + narrative + driver conditions | Edits any layer, reshapes conditions, publishes |
| Simulation | Samples, counts, computes sensitivity | Sets every distribution parameter; interprets |
| Chat | Retrieves, reranks, generates with citations | Asks, judges, follows citations to sources |
| Imagery | Generates from prompts | Chose every concept; rejected/regenerated off-brief outputs |

**Batch review — what the human decision actually is.** Reviewing 1,352 queued hits one at a time is not something a person does, and the only bulk control used to be an indiscriminate "approve all", so in practice the queue simply stopped moving and the approved corpus froze for five weeks. The queue is now paged and filterable by cluster, and can be grouped by embedding proximity (`cluster.js`: vectors mean-centred to remove the corpus's shared subject direction, then incremental centroid clustering at cosine 0.42, with singletons never absorbed into a nearest group and an LLM naming each group). A reviewer can approve or reject a whole group as one decision.

This is a real change to what "a human approved every hit" means, so it is recorded rather than glossed: every batch writes an `audit_log` entry naming the basis of the decision (which cluster or group), the size, and every member id. The honest description is that a human read a named, coherent group and decided about it — not that they read each row. Signals that resemble nothing else stay singletons precisely so they still get read individually.

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

## 6. The live synthesis report

`/report` is one document threading the whole instrument: what the reviewed library shows, how the triangle reads, where the scenario space sits, what the odds are, what would change our mind, and what follows for a policy maker or a trust team. It exists because the platform could produce many lenses and left the reader to assemble the argument.

- **Generation is manual.** Reading `/api/report` never generates; a human presses the button, and not more often than once every ten minutes. A high-effort model call behind an unauthenticated GET would be a standing invitation to spend someone else's money.
- **Staleness is stated, not hidden.** A sha1 over the approved-signal count and max id, the triangle write-up's own hash, the published scenario ids and timestamps, the latest simulation run, and the driver timestamps. When any of it moves the page says which part moved and that what you are reading describes an earlier state.
- **Citations are filtered server-side.** The model must cite `[S<id>]` / `[SC:slug]`; ids absent from the evidence pack are stripped after generation, the same guard `scenarios.js` applies to drafts. The count of stripped citations is stored with the report and shown on the page.
- **The corpus fills itself.** Source text is fetched automatically — a bounded batch every ten minutes while any signal still lacks it, paused whenever a scan is running so the two never compete for the same rate limit. A direct fetch is tried first and costs nothing; the paid extractor runs only where that fails, which is mostly bot-walled publishers and PDFs. There is no button and no queue for a person to work: a signal without retained text is an unfinished scan, not a task.
- **The retained article is readable.** Every signal drawer carries the source text behind a disclosure, with its sha256 and the date it was retained, so the thing a quotation is checked against can be read rather than taken on trust. Where nothing was retained, the drawer says so.
- **Failed fetches are remembered.** A signal that could not be fetched records the attempt and when it may next be tried — two hours, then twelve, then seventy-two, then given up. Without it the queue re-served the same dead rows every ten minutes: seven consecutive runs kept nothing and spent 840 calls on the identical 120 signals. A 402 from the paid extractor means the credits are gone rather than anything about that URL, so it stops the paid stage for six hours instead of making another hundred doomed calls.
- **Retained text is gated before it is trusted.** A scrape is only kept as source material if it clears a bot-challenge check, is at least 1,500 characters, and carries no paywall or sign-in wall language. Retaining a stub would be worse than retaining nothing: a genuine quotation would then fail to verify against junk and be silently dropped.
- **Quotations are checked, not trusted.** Anything presented as a quotation next to a citation — `"…" [S<id>]` — must be found verbatim in the retained scrape of that source (`quotes.js`) or it does not stand. The check is a substring lookup against hash-pinned text and fails closed. It runs in three places: on the machine draft of the report at generation (unverifiable words are removed, the citation stays); on an author's saved section (the save is refused with the verdicts, so a human's prose is never silently edited); and on every chat answer after it streams (the answer is replaced by the checked text and the reader is told what was removed). The report's prompt tells the model which signals carry retained text and forbids quoting any other. `POST /api/quotes/check` runs the same gate as a dry run over any text, and every editor on the report page has a *Check quotations* control that calls it — the way to see the gate refuse a changed word is to change one. Coverage (how many signals have retained text) is reported alongside the report; the library back-fills itself, and what remains uncovered is the bot-walled and paywalled tail.
- **The figures are the platform's.** Odds and sensitivity charts read `/api/simulation/latest` directly rather than the model's prose, so the numbers on the page cannot drift from the numbers in the model.
- **Two sections are generated structured rather than as prose**: the falsifiers come back as a list of watchable developments each tagged as strengthening or weakening the current reading, and the implications are written separately for policymakers and for industry rather than blended. The structure is the model's, not a split imposed on a paragraph afterwards; where an older cached report has neither, the page renders the prose it has rather than inventing a division.

The order is signals → drivers → triangle → scenario and odds → so what, closing on the watch-list. "Which levers decide it" and "What we're watching for" were previously named so similarly that they read as the same section; they are not. The first names which dial inside the model carries the outcome, the second names what would have to be observed in the world for the reading to be wrong.

The triangle no longer stops dead before the scenarios. Each scenario's own cited signals are looked up in the triangle classification, so the page can show which force that scenario actually rests on — derived from the citations rather than asserting a mapping of corners onto archetypes. On the current set: the collapse scenario rests 91% on the weight of history, the transformation scenario 88% on the pull of the future, and the growth scenario 55% on the push of the present.

Each scenario carries its summary and all four CLA layers — litany, systemic, worldview, myth — rather than a single myth line. The layers are the method the scenario set is built on and were previously invisible on this page; they sit in a horizontal rail rather than stacked, because the four are alternatives to each other: you compare them by moving between them, not by scrolling past them. Stacked with every layer open the section ran to 5,900 pixels; as a rail it is 2,000.

**Drafted, then authored, then critiqued.** The machine draft is never the last word and never overwritten. Any section can be rewritten by hand; the authored text is stored beside the draft, wins on read, and survives regeneration — which records instead that the evidence has moved since it was written, leaving the decision to the author. A section that has been authored can be shown beside the current machine draft at any time, with three ways out: keep the authored version, take the new draft, or go on editing. There is no word-level diff — these are two pieces of written argument, and the reader compares them by reading them. Any section, machine-drafted or hand-written, can then be put back to the model in one of five registers: what it misses, points to reconsider, questions it raises, what an adversarial reader would break, and alternative signals. The last of those is retrieval rather than opinion — it embeds the section, searches the approved library for evidence the section does not cite, and can only return ids that were actually offered to it. Critiques persist against the section until marked addressed, so the loop can be worked over several sittings. Every authoring and critique action is in the audit log.

Limits worth naming: the prose is generation, and the pills exist so no claim need be taken on faith; artifacts ship as a seed file rather than DB rows, so they are described but not citable the way signals and scenarios are.

---

## 7. Decision-support chat (RAG)

Retrieval: the question is embedded (Voyage `voyage-3.5`, query mode) → cosine over approved signals (top 24) → Voyage `rerank-2.5` to 12 → plus top 4 published scenarios. Generation: Claude streams over SSE; the client renders `[S123]` / `[SC:slug]` as clickable citation pills resolving to the underlying source. The system prompt (§9.5) instructs the model to say plainly when the scan is thin rather than invent certainty. Only the question and the cited ids are logged; conversations are not stored server-side.

## 8. AI models and services used

| Service | Model | Used for | Notes |
|---|---|---|---|
| Anthropic | `claude-opus-4-8` (adaptive thinking; effort low/medium/high by task) | Extraction, classification, scenario drafting, chat | All structured outputs via forced `tool_use` with strict JSON schemas |
| Voyage AI | `voyage-3.5` (1024-dim) + `rerank-2.5` | Semantic search, dedup, retrieval | Corpus embedding cost ≈ $0.01 |
| Perplexity | `sonar` | Undirected weekly-recency sweep | JSON schema + tolerant parsing |
| Firecrawl | v2 scrape/crawl | Directed source watch | Markdown only, main content, capped |
| Leonardo | Phoenix 1.0 | All site imagery | Every prompt in §10; every output human-selected |
| Claude Code | (build tool) | The platform itself was built with Claude Code under human direction | This document was drafted the same way |

---

## 9. System prompts — verbatim

Reproduced exactly as they exist in the deployed code.

### 9.1 Perplexity sweep — system prompt

> You are a horizon-scanning assistant for a foresight research team studying parasocial AI — how AI reshapes human relationships and social structures. Return only signals where the human-relationship or social-fabric angle is explicit: AI companionship, artificial intimacy, attachment, loneliness, grief tech, AI and family or romance, social norms around AI relationships. REJECT generic AI news (model releases, chips, enterprise tools, coding assistants, general AI policy) unless the item is specifically about AI's effect on human relationships. Return up to 10 distinct, dated, citable signals with a real, specific source URL each — prioritize items published in the last 48 hours over older ones, and prefer the primary source over syndicated copies of the same story. Return JSON only.

**The twelve themed queries** (each sent as the user message with week recency):

1. *companions*: "AI companion and AI friend apps as relationships: user attachment stories, incidents involving emotional dependence, companion shutdowns and user grief, changes to how companions handle intimacy (Replika, Character.AI, Talkie and similar). Exclude generic AI product or model news with no relationship angle."
2. *governance*: "Regulation, litigation or policy specifically about AI companions and human relationships: chatbots and minors, addictive companion design, AI romance fraud, emotional-manipulation rules, age verification for companion apps. Exclude general AI regulation like copyright, jobs or safety benchmarks."
3. *research*: "New studies about parasocial attachment to AI, AI companionship and loneliness, chatbots substituting or supporting human friendship and romance, effects of AI relationships on wellbeing or social skills. Exclude AI research with no human-relationship dimension."
4. *grief_tech*: "Grief technology and digital resurrection as relationships: deadbots, AI avatars of deceased people, mourning and continuing bonds with AI recreations, memorial chatbot services and controversies."
5. *market*: "Business of artificial intimacy: funding, revenue or acquisitions of AI companion, AI dating and grief-tech products, monetisation of AI relationships, dating apps adding or losing to AI companions. Exclude general AI industry funding with no intimacy or relationship product."
6. *discourse*: "Cultural debate about humans forming relationships with AI: essays, backlash, normalization of AI romance and friendship, AI companions in family or religious life, loneliness discourse tied to AI. Exclude general AI hype or doom commentary without the relationship theme."
7. *clones*: "AI clones and personas of real people as relationship objects: licensed or unauthorized AI versions of celebrities, influencers and creators that fans talk to, virtual influencers with parasocial followings, creators selling AI girlfriend/boyfriend versions of themselves, deepfake romance and impersonation in relationships. Exclude deepfake stories that are purely about misinformation or politics."
8. *youth_family*: "Children, teens and families with AI companions: minors forming attachments to chatbots, school and parental responses, family conflict or bonding over AI companions, AI imaginary friends, toys with companion AI, custody or parenting debates about AI relationships. Exclude general ed-tech or AI-in-classroom news without a relationship angle."
9. *therapy*: "Therapy and mental-health chatbots as relationships: people substituting AI for therapists or confidants, emotional reliance on wellbeing bots, clinical or regulatory reactions to AI emotional support, incidents where AI counseling affected a human relationship or crisis. Exclude generic digital-health funding or product news."
10. *elder_care*: "AI companions for older adults and care relationships: companion robots or chatbots in eldercare, loneliness interventions with AI for seniors, families outsourcing contact to AI, caregiving norms changing around social AI. Exclude medical-device or diagnostics news without a companionship role."
11. *work_school*: "Social AI reshaping everyday relationship norms in workplaces and schools: AI colleagues or study buddies people bond with, etiquette and friendship norms around always-available AI, people preferring AI interaction over coworkers or classmates, institutional rules about befriending AI. Exclude pure productivity-tool coverage."
12. *fandom*: "Virtual beings, VTubers, romance games and fandom parasociality with AI: AI-powered idols and streamers with devoted fans, dating sims and romance games adding AI characters, fan communities forming around AI personas, parasocial dynamics of AI-generated influencers. Exclude game-industry business news without the fan-relationship angle."

### 9.2 Firecrawl extraction — system prompt (Claude, forced tool `emit_signals`)

> You are a horizon-scanning analyst for a foresight project on parasocial AI — AI companions, artificial intimacy, human-AI relationships, grief tech, AI romance fraud, sycophancy as a relationship dynamic, and how AI reshapes social structures like friendship, romance, family and community. Extract ONLY items where the human-relationship or social-fabric angle is explicit. Strictly ignore generic AI/tech coverage: model releases, benchmarks, chips, enterprise tooling, coding assistants, robotics without a social-companionship role, and AI policy that is not about relationships or companionship. Ignore navigation, ads, and off-topic items. Most pages on general tech sites will yield ZERO relevant signals — returning an empty list is the normal outcome, not a failure.

### 9.3 Classification + relevance gate — system prompt (Claude, forced tool `classify_signals`)

*The gate paragraph below is the shipped default. The reviewer may edit it in the app's Scanning page; every scan run permanently records the exact gate text it used, and runs with a modified gate are flagged in the run history.*

> You classify horizon-scan hits for a foresight project on parasocial AI and the future of social relations.
>
> RELEVANCE GATE (apply first, strictly): a candidate is relevant ONLY if its core subject is AI's effect on human relationships or social structures — companionship, intimacy, attachment, loneliness, friendship, romance, family, grief, community, or the norms and rules around AI relationships. Mark relevant=false for generic AI news: model releases, benchmarks, chips, funding without an intimacy product, enterprise or coding tools, robotics without a companionship role, and AI policy not about relationships. When the relationship angle is only a passing mention, mark relevant=false. Expect to reject a large share of candidates.
>
> For survivors: assign one of the existing clusters below (prefer reusing them; only propose 'NEW: \<name\>' when nothing fits), one signal type, an urgency, and a time horizon.
>
> Existing clusters:
> *(the current 33-cluster list is injected from the database at call time)*

### 9.4 Scenario drafting — system prompt (Claude, forced tool `emit_scenario`, high effort)

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

### 9.5 Decision-support chat — system prompt (Claude, streamed)

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

## 10. Imagery — provenance and prompts

All site imagery is generated with **Leonardo Phoenix 1.0** via `scripts/gen-images.sh` (contrast 4.0, no alchemy, one image per prompt; the script skips existing files, so regeneration is an explicit human act of deleting a file). Two negative-prompt sets exist: the default bans people/faces/hands; a second (`faces`) permits synthetic faces and figures and was used only for the three images whose concept requires them. Concepts, iterated with the human until on-brief:

| File | Concept (the myth/idea it depicts) |
|---|---|
| `hero-specimen` | A human face formed of moss and ferns facing a porcelain synthetic face, warm light between the profiles — the platform's thesis in one frame |
| `colony` | Many diverse synthetic visages glowing in moss hollows — "the library in one image: 705 observed attachments" |
| `device-hearth` | A moss-overgrown phone with light through cracked glass — the device as hearth |
| `gate-texture` | A moss figure inside a luminous ring examining an orb — the human in the loop, literally |
| `scenario-growth` | Narrative scene: a firelit living-room corner at night, a glowing porcelain synthetic face at home on the mantelpiece (myth: "the hearth that answers back") |
| `scenario-collapse` | Narrative scene: an abandoned dining table, a cracked gold-seamed porcelain mask served on a dusty plate by one guttering candle (the golem that never said no) |
| `scenario-discipline` | Narrative scene: a hearth fire and a porcelain mask together inside a roped-off museum case under an inspection lamp (the hearth with a fire code) |
| `scenario-transformation` | Narrative scene: a porcelain synthetic face garlanded with flowers at an honoured place on a candlelit celebration table (the hearth widened to seat a stranger) |
| `motif-*` (6) | Small page-head specimens: lantern field, bell jar, four-tipped branch, lit/unlit orbs, paired orbs, root clod |

Rendering rule for all imagery: pure-black photo backgrounds dissolve into the page's olive void via `mix-blend-mode: lighten` over an explicit backdrop, plus an elliptical mask vignette — so subjects float in the page rather than sit printed on it. Full prompt text lives in `scripts/gen-images.sh` in the repository.

**Artifacts from the future (`/artifacts`).** Each published scenario is extrapolated into six everyday objects — a receipt, an ID card, a jacket patch, a lock-screen notice, a menu, an intake form. The set is authored in two separated steps, both disclosed on the page itself: (1) Claude reads only that scenario's own CLA layers and writes each object's type, title, the verbatim words printed on it, what it assumes, and the evidence cluster it grows from (forced tool call, high effort, artifact types drawn from a fixed typology, one type per scenario); (2) an image model photographs the object. The words are always authored in step 1 and passed into step 2 — the image model is never left to invent what a document says. The first pass used Leonardo Phoenix with legible text banned outright (`scripts/gen-artifacts.mjs`); the current images come from Google's Gemini 2.5 Flash Image ("nano banana"), reached through Leonardo's v2 API on the same key (`scripts/gen-artifacts-nb.mjs`), which renders the supplied specimen text sharply, so each object now carries its own words. Dense text blocks make any image model mis-spell, so the photograph is given an **abridged** specimen (first five lines, trimmed) while the card beneath always shows the full authored text — where the rendering and the card disagree, the card is authoritative. The full composed prompt actually sent for each image is stored as `image_prompt_used` and shown verbatim under the object. The whole set, prompts included, ships as `server/seed/artifacts.json`.

**The 3D hero (`/models/hero.glb`).** The landing page's hero is a 3D Janus head — a realistic human face and a sculpted porcelain face with gold-traced features sharing one head — that turns from human to synthetic as the visitor scrolls. Pipeline (`scripts/gen-3d.sh`): turnaround views generated with Leonardo Phoenix at a fixed seed (saved in `server/public/img/rodin-refs/`), fused by **Rodin v2** through the Leonardo API (`model: "rodin-v2"`, Quad mesh, medium quality, PBR materials, GLB output). The decisive methodological lesson, after several attempts produced single-faced meshes: **the reference images must show both faces in the same frame** — double-profile views with a nose silhouette pointing each way — because an image-to-3D model otherwise assumes one forward-facing face. The model renders via Google's `<model-viewer>` (raised exposure for the porcelain), user controls disabled — the scroll owns the camera and avoids the mesh's weakest angle. On load failure or reduced motion, the 2D hero image stands in.

## 11. Design decisions

- **Design system**: "Heartful Futures / Earthy Foresight" (Lexend; olive `#4E5A2B`, brown `#AC7222`, mustard `#E1B83B` on warm surfaces), extended with a dark observation register: olive-black void `#101408`, Fragment Mono instrument annotations, reticle-cornered data callouts — the visual language of alethia.earth's specimen-observation hero, adapted rather than copied.
- **The app pages are light; the home page carries the dark acts.** A dark token remap for the app (`css/app-dark.css`) was written but is not linked by any page, so it is presently dormant code rather than a shipped theme — an earlier version of this document claimed the whole product was dark, which was not true of what deploys. The `/report` page follows the light app register with the rest.
- **Chart palettes are machine-validated**, not eyeballed: the archetype colors pass a six-check validator (OKLCH lightness band, chroma floor, adjacent-pair color-vision-deficiency separation, contrast vs surface) in both light (`#D3963E/#C44536/#5B8A9A/#4E5A2B`) and dark (`#C08430/#C44536/#3D9ED4/#7E9440`) modes; identity never rides on color alone (every bar is a direct-labeled row).
- **Motion**: scroll choreography is rAF-driven CSS custom properties; app-wide motion (smooth scrolling via a vendored Lenis, clip-path mask-wipe reveals with incremental-delay staggers, two easing tokens, drag-to-scroll strips) adapts the interaction language studied from weareepoch.com's public site, re-implemented in vanilla CSS/JS. Every effect has a `prefers-reduced-motion` static equivalent; content is visible without JavaScript.
- **One aligned content column** — header and content resolve to `min(1240px, viewport − 2×gutter)`, gutter `clamp(24px, 6vw, 96px)` everywhere.

## 12. Security, privacy, operations

- Auth: none — the platform is fully open by design. Every page and every action (review, driver and scenario editing, scan controls, simulation) is publicly reachable and writable; the trade-off is accepted knowingly for a public demonstration instrument.
- Secrets live in environment variables (Railway) and a gitignored local `.env`; never in the repository.
- No user accounts, no analytics, no tracking. `chat_log` stores questions and cited ids only.
- All third-party keys are env-gated: any missing key degrades that feature gracefully (recorded scan error, 503 on chat) without breaking the rest.
- Nightly scan at 22:00 Asia/Singapore; failed steps are visible per-run in the review UI's scan history.

## 13. Known limitations and ethical notes

1. **Model-mediated evidence.** Perplexity and Firecrawl+Claude choose what surfaces; the taxonomy gate shapes what survives. The mitigations are provenance (`raw_json` on every hit), visible dedup scores, and the human queue — but selection bias upstream of the human is real and unavoidable.
2. **Scenario authorship.** Claude drafts; a human edits and publishes. The published text is human-approved but machine-originated — the citations list on each scenario is the honest trail of what informed it.
3. **Probabilities are conditional artifacts.** Simulation outputs depend entirely on human-set driver ranges and hand-shaped scenario conditions (see §4's disclosed reshaping). They are disciplined judgments made inspectable and reproducible (seeded runs, stored snapshots) — not forecasts.
4. **The corpus leans English-language and Western media**, with deliberate but partial counterweights (China governance signals, Southeast-Asia focus option in drafting).
5. **Batch review trades depth for motion.** Grouping lets the queue move again, but a group decision is a decision about a group. The audit log records the basis and every member id so the trade is inspectable, and singletons are never batched — but a signal approved inside a coherent group of thirteen has had less individual attention than one approved on its own, and the corpus should be read with that in mind.
6. **Verbatim checking is partial by construction.** Quotations are verified against retained source text, and text is only retained for signals scanned after this shipped; earlier scrapes were discarded after classification. An unverifiable quotation is stripped rather than shown, so the failure mode is a missing quote rather than a wrong one — but the guarantee covers a growing minority of the library, not all of it.
7. **Chat can still be wrong.** Retrieval grounds it and the prompt demands epistemic honesty, but generation is generation; the citation pills exist so no claim needs to be taken on faith.
8. **Imagery is synthetic** and stylized; no real persons are depicted. The faces are deliberately porcelain/artificial — depicting the *category* of synthetic intimacy, not any product or person.
9. **Dual-use awareness.** A tool that maps how parasocial attachment forms could inform exploitative design as easily as protective policy; the platform's framing, driver set, and chat instructions are explicitly oriented to the protective reading.

## 14. Reproducibility

- Fresh deployment self-seeds the full reviewed state (corpus, drivers, sources, published scenarios) from files shipped in the image.
- Every simulation stores seed + parameter snapshots; identical seeds reproduce identical outputs.
- Every scan run stores counters and errors; every scan hit stores its raw machine output.
- The repository contains every prompt, the seed corpus, and this document.

*Last updated 2026-09-02. This document is maintained alongside the code; if a prompt in the repository differs from §9, the repository is the truth and this file needs a commit.*
