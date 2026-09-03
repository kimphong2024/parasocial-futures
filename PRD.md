# PRD — Futures of Parasocial AI, post-review iteration

Status: built · Branch: `iteration/build` off `297f5e6` · Written 2026-09-02, amended on implementation

This document responds to recorded advisor feedback from Simeon on 2026-09-02 (transcript and summary in
`../feedback/`). It specifies four workstreams. Nothing here is required — Simeon was explicit that the
platform is *"strong as it is"* — but three of the four address real gaps, and one of those is a live
operational failure rather than an enhancement.

---

## 1. The problem, stated honestly

### 1.1 What the advisor said

The headline note, made twice and framed as his own recurring struggle with AI tooling: when you can add
unlimited lenses of analysis, how do you deliver something a reader finds meaningful?

> "I love the way that you visualized everything… I thought the way that you pulled that together was really
> nice, but it's a cool visualization, and then it's hard to think of how to pull that forward more, or what
> would be the end engagement that a client would be able to do with that."
> — on the futures triangle, 00:46–02:50

> "Helping guide someone through how each of those components — whether it's the signals library to futures
> triangle, the scenarios and artifacts — some sort of cohesive part of the report that pulls all that
> together could be really cool."
> — 03:17–04:04

The platform has nine destinations and no argument. A visitor arrives in the middle of an instrument and is
left to assemble the thesis themselves.

### 1.2 What the instance actually shows

Probing the live deployment on 2026-09-02 turned that design critique into something sharper:

```
GET /api/health
signals 2292 · approved 940 · pending 1352 · rejected 0 · embedded 2292
lastScan  2026-09-01 · new_pending 40 · nightly, still running
GET /api/triangle
pull 240 · push 228 · weight 472 · unclassified 0 · writeup dated 2026-07-27
```

Every downstream component reads **approved** signals only — `triangleSignals`, `approvedSignals`, the
scenario evidence pack (`scenarios.js:76-120`), and chat retrieval (`chat.js:12-32`) all filter on
`status = 'approved'`. The approved corpus has been frozen at 940 since late July while the scanner added
roughly 40 signals a night. The triangle write-up has not regenerated because its composition hash has not
moved (`triangle.js:118-125`).

**The instrument has been running on a static corpus for five weeks.** That reframes the work: a synthesis
report is not "live" unless the queue moves. Simeon's headline note and the queue backlog are one problem,
not two, and they are specified here in that order.

---

## 2. Workstream 1 — The live synthesis report

**Route:** `/report` · **Priority:** 1 · **New top-level nav section**

### 2.1 Intent

One page that states what the library currently shows, what the triangle reads, where the scenario space
sits, what the odds are, what would change our mind, and what a reader should do about it — every claim
citable back to a signal or a published scenario, and the whole thing declaring itself stale when the
evidence moves beneath it.

This is the "so what" surface. It is the first thing a visitor sees after the home page, the thing you link
someone to, and the opening move of the showcase demo.

### 2.2 Design — reuse the pattern that already exists

`server/triangle.js:105-200` is the only persisted LLM-generated synthesis in the codebase, and its shape is
already correct: a `composition()` sha1 over the inputs, prose cached in the `settings` table, and
`regenerateWriteupIfStale()` firing on read. `server/report.js` mirrors it rather than inventing a mechanism.

**Amended on build (manual generation).** The original draft had the report regenerate in the background on read, mirroring `regenerateWriteupIfStale()`. That was changed before implementation: a high-effort model call behind an unauthenticated GET on a public site is a standing cost risk, so **reading never generates**. A human presses a button, at most once every ten minutes (`canGenerate()` returns a real 429). A report whose inputs have moved says so, and names which input moved.

**Staleness.** `composition()` returns a sha1 over:

| input | source |
|---|---|
| approved signal count + max approved id | `approvedSignals` (`db.js:207`) |
| the triangle write-up's own hash | `settings['triangle_writeup'].hash` |
| published scenario ids + max `updated_at` | `publishedScenarios` (`db.js:281`) |
| latest `simulation_runs.id` | `db.js:117-126` |
| max `drivers.updated_at` | `enabledDrivers` (`db.js:287`) |

Any input moving makes the report stale. `GET /api/report` returns the cached record immediately and reports
`stale: true` plus a `changed[]` list naming which inputs moved — it does not generate. The reader never
waits on the model, and the page always says how old what they are reading is and what has shifted under it.

**Storage.** `settings['live_report']`, following `triangle_writeup`. No new table.

**Generation.** `askTool` (`ai.js:14`) with a forced-tool schema at `effort: "high"`, mirroring
`WRITEUP_SCHEMA`. Sections, in the order they thread the instrument:

| section | draws on | ~words |
|---|---|---|
| `state_of_evidence` | `/api/signals/overview` — cluster spread, source concentration, provenance | 180 |
| `triangle_reading` | the **cached** triangle prose; does not re-derive it | 150 |
| `scenario_space` | the four published scenarios' CLA layers + what separates them | 200 |
| `odds` | latest `simulation_runs` probabilities **and the residual** | 150 |
| `sensitivity` | the tornado rows — which drivers actually move the odds | 130 |
| `what_would_change_our_mind` | falsifiers: the signals that would break the current reading | 150 |
| `so_what` | implications for the two audiences named in `PRODUCT.md` | 200 |

The residual is not optional. It currently sits near 51% — futures matching no scenario — and
`TRANSPARENCY.md` §5 already treats it as a talking point rather than an embarrassment. A synthesis that
quietly drops it would be the exact failure the report exists to prevent.

**Citation discipline.** Every claim carries `[S<id>]` or `[SC:<slug>]`. The server strips ids absent from
the evidence pack before caching, exactly as `scenarios.js` does for `cited_signal_ids`. The client reuses
the pill renderer at `js/chat.js:11-12` — `[S123]` becomes `<span class="cite-pill" data-sig="123">`. No new
citation mechanism is introduced anywhere in this document.

### 2.3 API

```
GET  /api/report            → { report, hash, inputs, stale, changed[], generating, available }
POST /api/report/regenerate → { ok, started }   409 generating · 429 too soon · 503 no key
```

### 2.4 Files

**New** — `server/report.js`, `server/public/report.html`, `server/public/js/report.js`.

**Edited** — `server/server.js` (two API routes; static route in the block at `server.js:486-488`);
`server/public/js/nav.js` (one `SECTIONS` entry, top-level "Report", no children — the pending badge logic
at `nav.js:52-58` needs no change).

**Reused, not rebuilt** — `probabilityBars()` and `tornado()` from `js/charts.js:26,51` for the odds and
sensitivity figures; `api()`/`esc()`/`fmtDate()` from `js/api.js`; the `.card`, `.citation`, `.field-label`,
`.tag`, `.caption` classes from `css/style.css`.

### 2.5 Acceptance

- The report renders from live data, and every claim resolves to a real signal or published scenario.
- Approving a signal in review changes the composition hash, and the page then reports itself stale and names
  the approved library as the input that moved.
- With `ANTHROPIC_API_KEY` unset the page serves the cached report with a visible staleness note, consistent
  with the graceful-degradation posture in `README.md`.
- The odds section states the residual.

---

## 3. Workstream 2 — Queue triage

**Route:** `/review` · **Priority:** 1 — this is a live failure, not an enhancement

### 3.1 The actual problem

`pendingSignals` (`db.js:217`) carries no `LIMIT`:

```sql
SELECT * FROM signals WHERE status = 'pending' ORDER BY created_at DESC, id DESC
```

`GET /api/review/queue` (`server.js:177`) ships all 1,352 pending rows to the browser at once, each with a
resolved nearest-neighbour lookup, and `js/review.js` renders a full editable card for every one. The only
bulk action is `POST /api/review/approve-all` (`server.js:187`), wired to a single confirm dialog.

So the reviewer's real choice is **1,352 individual decisions, or one indiscriminate mass-approve**. That is
why nothing has been reviewed since July, and it is the most likely explanation for `rejected = 0` across
2,292 signals. The reject route itself is sound (`server.js:201-206`, identical in shape to approve) — it has
simply never been a usable option at this scale.

Simeon hit the same wall on a tool of his own:

> "I ended up just having it do auto clustering… I started experimenting with clustering algorithms because I
> was like, I cannot — I'm never gonna triage all these scan hits. It's just gonna be impossible."
> — 10:46–11:16

### 3.2 Phase 1 — facet batching

Nearly free, because the query layer already supports it. `facets('pending')` (`db.js:236`) returns cluster
counts for pending rows today; `querySignals` (`db.js:220`) already filters by status and cluster with
`LIMIT`/`OFFSET`.

- `GET /api/review/queue` gains `cluster`, `page`, `limit` (default 40, max 200) and returns `total`.
- `review.html` gains a cluster rail — every pending cluster with its count, ordered by size.
- `POST /api/review/batch { ids[], action }` where `action` is `approve` or `reject`, capped per request.
- `POST /api/review/approve-all` is **removed**, not kept alongside. Leaving an indiscriminate escape hatch
  next to a considered one guarantees the escape hatch wins at 1,352 items.

A reviewer can then take "Digital Resurrection & Grief" — 22 of a 200-row sample — as one considered pass
rather than 22 unrelated decisions.

### 3.3 Phase 2 — embedding clustering

All 2,292 signals are embedded (`embedded 2292` in health), and the machinery exists: `similarTo()`
(`vectors.js:79`) and the kNN edge construction at `server.js:103-126`, which already builds a K=4 /
min-cosine-0.45 graph over approved signals and caches it.

New `server/cluster.js`:

- **Amended on build (the threshold guess was wrong, and wrong in an instructive way).** Grouping on raw
  cosine does not work at any threshold: the corpus is one subject, so pairwise similarity averages 0.666 with
  a 99.9th percentile of 0.854, and every setting yields either one blob or nothing. The fix is to mean-centre
  the vectors first — subtracting the queue's mean removes the shared "this is about parasocial AI" direction
  and leaves what actually distinguishes signals. In centred space the same pairs average 0.000 and a
  threshold of **0.42** gives coherent, nameable groups. The drafted 0.60–0.70 range was guessed against the
  wrong geometry entirely.
- Incremental centroid ("leader") clustering rather than true agglomerative — average-linkage in spirit,
  O(n · groups), and unlike single-linkage it cannot chain two themes together through a bridge signal.
- Singletons stay singletons; they are the interesting ones and must not be swept into a nearest group.
- One `askTool` call labels each group and names what its members share.
- `GET /api/review/groups` → groups with representative signal, member ids, size, and intra-group cohesion.
- Batch action applies per group, reusing the Phase 1 endpoint.

This surfaces themes the 33-cluster taxonomy does not have a name for — which is the point Simeon was making,
and something facet batching structurally cannot do.

### 3.4 Guardrail — this is the method claim, not a UX detail

Human-in-the-loop review is the platform's central argument. `TRANSPARENCY.md` §3 states that a human
"approves / edits classification / rejects each hit", and §12.1 rests the honesty of the whole corpus on it.
Batch approval changes what that sentence means.

Therefore, shipping with batch approval requires, in the same change:

1. Every batch writes to `audit_log` via `server/audit.js` — the batch's basis (cluster or group id), its
   size, and the member ids. The audit trail is what keeps "a human approved this cluster" an inspectable
   claim rather than a vague one.
2. `TRANSPARENCY.md` §3 and the human-in-the-loop table are edited to describe batch review accurately.
3. The `/review` UI states the unit of decision on screen — the reviewer should never be unclear about
   whether they are approving one signal or two hundred.

Without these, the method silently degrades from "a human approved every hit" to "a human approved a cluster
label" while the documentation still claims the former. That is a worse outcome than a backlog.

### 3.5 Acceptance

- A reviewer clears a 200-signal cluster in one considered decision, recorded in the audit log with its basis.
- Queue response time is bounded by page size, not by backlog size.
- `TRANSPARENCY.md` §3 and its human-in-the-loop table describe what the code actually does.
- Rejecting works and is used — `rejected > 0` after the first real triage session.

---

## 4. Workstream 3 — Hash-anchored verbatim citation

**Priority:** 3 · **Optional** — and the PRD should be read as saying so

### 4.1 Scope it the way the advisor scoped it

Simeon's written feedback mentioned hashing; on the call he explained it and then, unprompted, narrowed it.
Asked directly whether the existing Voyage embeddings and RAG fall short:

> "Not necessarily… if you're running it through an embedding model, you're probably okay. Something like the
> signals library that you've got — embeddings and vector search with RAG — is probably adequate."
> — 06:59–07:54

> "Quotations is probably the most important area where I've seen it, but it may not apply as much to your
> work."
> — 08:17–09:12

Hashing earns its place for **word-for-word quotation**, not for retrieval correctness. This section exists so
a future reader does not mistake it for a defect being fixed. Nothing in the current citation path is broken.

### 4.2 What the mechanism actually is

The idea worth keeping is not the hash — it is that the guarantee should be **deterministic rather than
model-dependent**:

> "You basically have judges and deterministic code on the back end where it requires the LLM to use the
> hashes whenever it references something. So that way you can guarantee that it is referring back to
> something that's definitely in your database."
> — 04:44–05:54

The codebase already applies this shape once: `scenarios.js` strips citations not present in the evidence
pack, server-side, after generation. The quotation case extends the same principle from *which source* to
*which words*.

### 4.3 Design

- Add `signals.content_sha256` (guarded `ALTER TABLE`, following the migration block at `db.js:152-160`).
- Add a `quotes` table: `signal_id`, `text`, `sha256`, `start_offset`, `end_offset`, `created_at`.
- Populate during Firecrawl follow-through. `scan.js` already scrapes full article text so classification
  judges real content rather than a headline (`TRANSPARENCY.md` §3.2), and currently discards that text after
  extraction. Storing candidate quotations at that moment costs one write.
- A quotation renders in the report or chat **only** if it resolves to a stored hash. A deterministic
  post-generation validator strips or flags anything unresolvable, mirroring the `cited_signal_ids` filter.

### 4.4 Acceptance

Any rendered quotation resolves to a stored hash, or it does not render. No exceptions, no soft-fail.

---

## 5. Workstream 4 — Showcase demo path

**Not a product feature.** Recorded here so it is not re-litigated.

Settled on the call **[11:18–13:00]**: **10 minutes, demo only, no slides.** The session is 45 minutes across
three students plus Simeon's introduction; he expects some latitude if there is interest. He will frame the
class context himself — *"I'll make sure to tee up that everybody was free to design their own project"* — so
none of that needs stage time. `present.html` stays in the repo but is not used.

The route:

| # | Page | The beat |
|---|---|---|
| 1 | `/report` | The argument, stated. Everything after this is evidence for it. |
| 2 | `/signals` or `/map` | What it rests on — 940 reviewed signals, and how they were reviewed. |
| 3 | `/triangle` | Pull 240 · push 228 · weight 472, and why weight dominating is reactive rather than decisive. |
| 4 | `/scenarios` | Four archetypes, CLA-structured, cited. |
| 5 | `/simulation` | The odds — **and the residual**, which is the honest and more interesting half. |
| 6 | `/chat` | One live question, answered with citations. |

Prerequisites: the queue drained so the numbers on screen are current (Workstream 2 gates this), and a
fallback for a dead connection — `/chat` returns 503 without its keys, so it cannot be the finale on
conference wifi. Have a recorded fallback or end on `/simulation`.

---

## 6. Risks and open items

**6.1 The app is light; the docs said it was dark — resolved.** `TRANSPARENCY.md` §11 states *"the whole product is
dark"* via an `app-dark.css` token remap, and `css/app-dark.css` exists and describes itself as *"Loaded ONLY
by app pages (+ login)"*. **No HTML file links it.** Verified locally and against the live `/review`, which
loads only `style.css`, `fib.css`, `motion.css`. `DESIGN.md`'s light-app description is the accurate one. The
dark theme was written and never wired up, and that claim was wrong on a point of fact. Resolved by
correcting `TRANSPARENCY.md` §11 rather than wiring the theme: the report page follows the light app register
with every other page, and the dormant sheet is now described as dormant.

(The same file's "+ login" reference is also stale: `TRANSPARENCY.md` §12 records that there is no auth.)

**6.2 No auth, by design — resolved.** Every endpoint is publicly writable (`TRANSPARENCY.md` §12). `POST /api/report/regenerate` is a
high-effort LLM call exposed to the internet, as is `POST /api/scan/run` today. Resolved by making generation
manual and rate-limited to one run per ten minutes, and by ensuring the read path never generates. The wider
question of authentication on a public write surface is untouched and remains open.

**6.3 Batch approval weakens the method claim** unless §3.4 ships with it. Listed twice on purpose.

**6.4 Artifacts cannot be cited like the rest.** `server/seed/artifacts.json` is a filesystem seed file, not
DB rows, joined to scenarios by `archetype` rather than slug (`server.js:356`) — and the seed's growth entry
is `the-warm-layer` while the published DB scenario is `the-normal-layer`. The report can reference artifacts
narratively but cannot cite them the way it cites signals and scenarios. Say so in the report's own method
note rather than papering over it.

**6.5 The corpus is five weeks stale.** Until the queue moves, the report will synthesise a July library and
present it as current. If Workstream 1 ships before Workstream 2, the staleness note is not a nicety — it is
the difference between an honest instrument and a misleading one.

---

## 7. Sequencing

| Phase | Contents | Rationale |
|---|---|---|
| 1 | WS2 Phase 1 — facet batching, pagination, batch endpoint, audit + `TRANSPARENCY.md` edit | Unblocks the corpus. Everything downstream is stale until this lands. |
| 2 | WS1 — the synthesis report | The advisor's headline note. Reads better against a current corpus. |
| 3 | WS2 Phase 2 — embedding clustering | Surfaces what the taxonomy misses. Wants a drained queue to tune against. |
| 4 | WS3 — verbatim hashing | Optional. Explicitly downgraded by the advisor. |

Workstream 4 is not a build phase; it is a checklist for the day.

---

## 8. What this document is not

It is not a commitment to build all of it. Simeon's closing note **[13:11–13:28]**:

> "It's strong as it is, so don't — if any of that stuff trips you up, or you're busy with life and you don't
> wanna touch this, it's really no problem at all."

The branch exists so the working build stays untouched while these are tried. That was the plan put to him on
the call, and his answer was *"I think that is a very, very smart approach."*
