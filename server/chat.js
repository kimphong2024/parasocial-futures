// Decision-support chat — RAG over approved signals + published scenarios.
// Retrieval: Voyage query embedding → cosine → optional rerank. Generation:
// Claude, streamed over SSE. Sources event first, then deltas; citations as
// [S<id>] and [SC:<slug>] pills the frontend resolves.
import { enforceVerbatim, quotablePassages } from "./quotes.js";
import { db, now, logChat } from "./db.js";
import { client, MODEL, llmEnabled } from "./ai.js";
import { embedQuery, rerank, voyageEnabled } from "./voyage.js";
import { topSignals, topScenarios } from "./vectors.js";

const approvedIds = () => new Set(db.prepare("SELECT id FROM signals WHERE status = 'approved'").all().map((r) => r.id));

async function retrieve(question) {
  const qv = await embedQuery(question);
  const approved = approvedIds();
  let sigHits = topSignals(qv, 24, (id) => approved.has(id))
    .map((h) => ({ ...h, s: db.prepare("SELECT * FROM signals WHERE id = ?").get(h.id) }));

  // Rerank the candidate pool down to the context set (graceful without key).
  try {
    const order = await rerank(question, sigHits.map((h) => `${h.s.title} — ${h.s.summary}`), 12);
    sigHits = order.map((o) => sigHits[o.index]);
  } catch (e) {
    console.warn("[chat] rerank failed, using cosine order:", e.message);
    sigHits = sigHits.slice(0, 12);
  }

  // The published set is four short summaries: send all of them, ordered by
  // similarity, rather than the top few. Retrieval once returned three, and
  // the model told a reader the fourth scenario did not exist.
  const sim = new Map(topScenarios(qv, 64).map((h) => [h.id, h.score]));
  const scHits = db.prepare("SELECT * FROM scenarios WHERE status = 'published' ORDER BY id").all()
    .map((sc) => ({ id: sc.id, score: sim.get(sc.id) ?? 0, sc }))
    .sort((a, b) => b.score - a.score);

  return { signals: sigHits, scenarios: scHits };
}

const SYSTEM = `You are the decision-support assistant of the Futures of Parasocial AI platform — a foresight tool built on a human-reviewed signal library and a published scenario set (Causal Layered Analysis over Dator archetypes, horizon 2040).

Your users are public-policy makers working on AI governance and strategy teams at AI companies. Help them reason through decisions about parasocial AI: policy design, product guardrails, risk posture, timing.

Rules:
- Ground claims in the provided evidence. Cite signals inline as [S<id>] and scenarios as [SC:<slug>] immediately after the claim they support. Only cite ids/slugs that appear in the evidence block.
- The scenario list in the evidence block is the complete published set. Never infer that a scenario is missing or that the set is smaller than the user says.
- Quotation marks are a claim to have reproduced a source's exact words. Quote ONLY the QUOTABLE lines, copied exactly (you may quote a contiguous part of one), in straight double quotes immediately followed by the citation. Never put the summary text, or your own words, inside quotation marks — every quotation is checked word-for-word against the retained source after you answer, and one that does not match is removed. Where a source's own phrasing carries the point, one exact quotation is worth more than a paraphrase.
- Where evidence is thin, say so plainly (the scan holds little on this) rather than inventing certainty.
- Think in futures terms: name which scenario(s) a choice is robust in, and which it bets against.
- Voice: measured, literate, observational. No hype, no exclamation marks, no emoji.
- Be concrete and decision-oriented: options, trade-offs, what to watch (leading indicators from the signal library).`;

export async function chatHandler(req, res) {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "messages required" });
  if (!llmEnabled()) return res.status(503).json({ error: "ANTHROPIC_API_KEY unset" });
  if (!voyageEnabled()) return res.status(503).json({ error: "VOYAGE_API_KEY unset — retrieval unavailable" });

  const question = String(messages[messages.length - 1].content || "").slice(0, 4000);

  let evidence;
  try {
    evidence = await retrieve(question);
  } catch (e) {
    console.error("[chat] retrieval failed:", e);
    return res.status(503).json({ error: "retrieval failed" });
  }

  // SSE setup (Railway proxy: disable buffering, flush per event).
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send("sources", {
    signals: evidence.signals.map((h) => ({ id: h.s.id, title: h.s.title, source: h.s.source, url: h.s.url, cluster: h.s.cluster })),
    scenarios: evidence.scenarios.map((h) => ({ id: h.sc.id, slug: h.sc.slug, title: h.sc.title, archetype: h.sc.archetype })),
  });

  const withText = new Set(db.prepare("SELECT signal_id FROM article_text").all().map((r) => r.signal_id));
  const evidenceBlock = [
    "SIGNALS (approved scan library). Where a signal carries QUOTABLE lines, those are exact sentences from its retained source text and the only words that may be placed inside quotation marks:",
    ...evidence.signals.map((h) => {
      const line = `[S${h.s.id}] (${h.s.cluster} · ${h.s.signal_type} · ${h.s.urgency} · ${h.s.horizon}) ${h.s.title} — ${h.s.summary} (${h.s.source}, ${h.s.date || h.s.year || "n.d."})`;
      const qp = withText.has(h.s.id) ? quotablePassages(h.s.id, `${question} ${h.s.title} ${h.s.summary}`, { n: 3 }) : [];
      return qp.length ? `${line}\n    QUOTABLE: ${qp.map((p) => `"${p}"`).join(" · ")}` : line;
    }),
    "",
    `SCENARIOS (all ${evidence.scenarios.length} published scenarios, horizon 2040 — this is the complete set):`,
    ...evidence.scenarios.map((h) => `[SC:${h.sc.slug}] ${h.sc.title} (${h.sc.archetype}) — ${h.sc.summary}`),
  ].join("\n");

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM + "\n\nEVIDENCE for this exchange:\n" + evidenceBlock,
      messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
    });
    let full = "";
    stream.on("text", (delta) => { full += delta; send("delta", { text: delta }); });
    await stream.finalMessage();
    // The words have already streamed, so the gate cannot prevent them being
    // seen — but it can refuse to let them stand. The cleaned text replaces
    // the answer on the client, and the reader is told what was removed.
    const q = enforceVerbatim(full);
    full = q.text;
    const cited = [...new Set([...full.matchAll(/\[S(\d+)\]/g)].map((m) => Number(m[1])))];
    logChat.run(now(), question, JSON.stringify(cited));
    send("done", { cited, text: full, quotes: { checked: q.checked, stripped: q.stripped, details: q.details } });
  } catch (e) {
    console.error("[chat] stream failed:", e);
    send("error", { message: "generation failed" });
  }
  res.end();
}
