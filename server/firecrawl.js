// Firecrawl v2 — directed scanning of configured sources. Each source is
// scraped (single page) or crawled (bounded), then Claude extracts candidate
// signals from the markdown via forced tool_use (the structurally reliable leg).
// Front-page teasers are followed through: up to FOLLOW_LIMIT not-yet-known
// article URLs per source are scraped so classification sees real article
// text instead of a headline teaser.
import { askTool, llmEnabled } from "./ai.js";

const KEY = (process.env.FIRECRAWL_API_KEY || "").trim();
const BASE = "https://api.firecrawl.dev/v2";
export const DEFAULT_FOLLOW_LIMIT = Number(process.env.FOLLOW_LIMIT || 3);
export const firecrawlEnabled = () => !!KEY;

async function fc(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`firecrawl ${path} ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

async function scrape(url) {
  const j = await fc("/scrape", { url, formats: ["markdown"], onlyMainContent: true });
  const page = j.data || j;
  return [{ url: page.metadata?.sourceURL || url, markdown: page.markdown || "" }];
}

async function crawl(url, limit) {
  const start = await fc("/crawl", { url, limit, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } });
  const jobUrl = start.url || (start.id ? `${BASE}/crawl/${start.id}` : null);
  if (!jobUrl) throw new Error("firecrawl crawl: no job id");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 4000));
    const r = await fetch(jobUrl, { headers: { authorization: "Bearer " + KEY } });
    if (!r.ok) throw new Error(`firecrawl poll ${r.status}`);
    const j = await r.json();
    if (j.status === "completed")
      return (j.data || []).map((p) => ({ url: p.metadata?.sourceURL || url, markdown: p.markdown || "" }));
    if (j.status === "failed") throw new Error("firecrawl crawl failed");
  }
  throw new Error("firecrawl crawl: timed out after 90s");
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short factual headline of the signal" },
          summary: { type: "string", description: "1-2 sentence factual summary" },
          url: { type: "string", description: "Direct URL of the article/study, not the section page" },
          source: { type: "string", description: "Publication or organisation name" },
          date: { type: "string", description: "Publication date if visible, ISO-ish, else empty" },
        },
        required: ["title", "summary", "url", "source"],
      },
    },
  },
  required: ["signals"],
};

async function extractSignals(sourceName, pageUrl, markdown) {
  const { signals } = await askTool({
    system: "You are a horizon-scanning analyst for a foresight project on parasocial AI — AI companions, artificial intimacy, human-AI relationships, grief tech, AI romance fraud, sycophancy as a relationship dynamic, and how AI reshapes social structures like friendship, romance, family and community. Extract ONLY items where the human-relationship or social-fabric angle is explicit. Strictly ignore generic AI/tech coverage: model releases, benchmarks, chips, enterprise tooling, coding assistants, robotics without a social-companionship role, and AI policy that is not about relationships or companionship. Ignore navigation, ads, and off-topic items. Most pages on general tech sites will yield ZERO relevant signals — returning an empty list is the normal outcome, not a failure.",
    prompt: `Source: ${sourceName}\nPage: ${pageUrl}\n\nPage content (markdown):\n\n${markdown.slice(0, 15000)}`,
    toolName: "emit_signals",
    schema: EXTRACT_SCHEMA,
    effort: "medium",
  });
  return (signals || []).filter((s) => s.title && /^https?:\/\//.test(s.url || ""));
}

// Follow front-page teasers into their articles: scrape up to FOLLOW_LIMIT
// not-yet-known article URLs and re-extract from full text, enriching the
// teaser in place. Any failure keeps the teaser — the follow-through can only
// add fidelity, never lose a candidate.
async function followArticles(src, sigs, isKnown, followLimit) {
  let credits = followLimit;
  for (const s of sigs) {
    if (credits <= 0) break;
    if (s.url === src.url || (isKnown && isKnown(s.url))) continue; // already in the library — dedup will drop it anyway
    credits--;
    try {
      const [article] = await scrape(s.url);
      if (!article.markdown.trim()) continue;
      const rich = (await extractSignals(src.name, article.url, article.markdown))[0];
      if (rich) {
        s.title = rich.title;
        s.summary = rich.summary;
        if (rich.date) s.date = rich.date;
        s.url = article.url;
      }
    } catch { /* keep the teaser */ }
  }
}

// sources: rows from scan_sources. isKnown(url) → true if the URL is already
// in the signal library (lets the follow-through skip spending scrape credits
// on articles dedup would drop). Returns { candidates, errors, perSource }.
export async function firecrawlScan(sources, isKnown, followLimit = DEFAULT_FOLLOW_LIMIT) {
  const candidates = [], errors = [], perSource = {};
  if (!KEY) return { candidates, errors: [{ step: "firecrawl", message: "FIRECRAWL_API_KEY unset" }], perSource };
  if (!llmEnabled()) return { candidates, errors: [{ step: "firecrawl", message: "ANTHROPIC_API_KEY unset (needed for extraction)" }], perSource };
  for (const src of sources) {
    try {
      const pages = src.kind === "crawl" ? await crawl(src.url, src.crawl_limit) : await scrape(src.url);
      let found = 0;
      for (const page of pages) {
        if (!page.markdown.trim()) continue;
        const sigs = await extractSignals(src.name, page.url, page.markdown);
        if (src.kind !== "crawl" && followLimit > 0) await followArticles(src, sigs, isKnown, followLimit);
        candidates.push(...sigs.map((s) => ({ ...s, source_id: src.id })));
        found += sigs.length;
      }
      perSource[src.id] = { ok: true, found };
    } catch (e) {
      errors.push({ step: "firecrawl", source: src.name, message: e.message });
      perSource[src.id] = { ok: false, error: e.message };
    }
  }
  return { candidates, errors, perSource };
}
