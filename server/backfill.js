// Backfilling retained source text for the whole library.
//
// The verbatim gate can only check a quotation against text we kept, and text
// was only ever kept for signals scanned after that shipped. This walks the
// library and fetches the rest.
//
// Two stages, cheapest first — the shape RECOLLECTX's parse-url extractor
// arrived at. A direct fetch with a browser user-agent and a Google referer
// costs nothing and clears most general publishers; Firecrawl is paid, so it
// only runs where the free path failed the acceptance gate. Roughly a fifth of
// the library is bot-blocked (Axios, Forbes, LessWrong measured), which is
// where the spend goes.
//
// Every stored row is a checkpoint: the queue is "signals with no article_text",
// so an interrupted run resumes by simply starting again.

import * as d from "./db.js";
import { articleTextVerdict, storeArticleText } from "./quotes.js";
import { scrape as firecrawlScrapeOne, firecrawlEnabled } from "./firecrawl.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const DIRECT_TIMEOUT_MS = 15_000;
const DIRECT_CONCURRENCY = 4;

// Paragraph text only. Crude next to Readability, but the acceptance gate is
// what decides whether the result is usable — if this under-extracts, the
// verdict fails and Firecrawl gets its turn. Under-extraction costs a credit;
// it never stores junk.
function htmlToText(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|nav|header|footer|aside|form|svg|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const paras = [...stripped.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  const body = paras.length ? paras.join("\n\n") : stripped;
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function directFetch(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), DIRECT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      // The Google referer is not a trick for its own sake: soft paywalls
      // routinely serve full text to search referrals.
      headers: { "user-agent": UA, referer: "https://www.google.com/", accept: "text/html,*/*" },
    });
    if (!r.ok) return { ok: false, reason: `http ${r.status}` };
    const ct = r.headers.get("content-type") || "";
    if (!/html|text/i.test(ct)) return { ok: false, reason: `content-type ${ct.split(";")[0]}` };
    return { ok: true, text: htmlToText(await r.text()) };
  } catch (e) {
    return { ok: false, reason: e.name === "AbortError" ? "timeout" : e.message.slice(0, 60) };
  } finally {
    clearTimeout(t);
  }
}

// ---------------- run state ----------------

let state = null;
export const backfillStatus = () => (state ? { ...state, running: state.running } : { running: false, idle: true });

const blank = (target) => ({
  running: true,
  aborted: false,
  started_at: new Date().toISOString(),
  finished_at: null,
  target,
  done: 0,
  stored: 0,
  direct_hits: 0,
  firecrawl_hits: 0,
  firecrawl_calls: 0,
  skipped: 0,
  reasons: {},
  errors: [],
});

const note = (reason) => { state.reasons[reason] = (state.reasons[reason] || 0) + 1; };

export function abortBackfill() {
  if (state?.running) { state.aborted = true; return true; }
  return false;
}

/**
 * limit — how many signals to attempt this run (resumable; call again for more).
 * useFirecrawl — false to run the free pass only, spending nothing.
 */
export async function runBackfill({ limit = 200, useFirecrawl = true } = {}) {
  if (state?.running) return { skipped: true, reason: "backfill already running" };
  const rows = d.signalsMissingText.all(limit);
  state = blank(rows.length);
  if (!rows.length) { state.running = false; state.finished_at = new Date().toISOString(); return state; }

  // Stage 1 — free direct fetches, a few at a time so we stay polite.
  const needsPaid = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length && !state.aborted) {
      const row = rows[cursor++];
      const res = await directFetch(row.url);
      if (res.ok) {
        const verdict = articleTextVerdict(res.text);
        if (verdict.ok) {
          try {
            storeArticleText(row.id, res.text);
            state.stored++; state.direct_hits++;
          } catch (e) { state.errors.push({ id: row.id, message: e.message.slice(0, 80) }); }
          state.done++;
          continue;
        }
        needsPaid.push({ ...row, why: verdict.reason });
      } else {
        needsPaid.push({ ...row, why: res.reason });
      }
      state.done++;
    }
  };
  await Promise.all(Array.from({ length: DIRECT_CONCURRENCY }, worker));

  // Stage 2 — Firecrawl only for what the free pass could not get. Serial,
  // because fc() paces and backs off globally.
  if (useFirecrawl && firecrawlEnabled() && !state.aborted) {
    for (const row of needsPaid) {
      if (state.aborted) break;
      state.firecrawl_calls++;
      try {
        const [page] = await firecrawlScrapeOne(row.url);
        const verdict = articleTextVerdict(page?.markdown || "");
        if (verdict.ok) {
          storeArticleText(row.id, page.markdown);
          state.stored++; state.firecrawl_hits++;
        } else {
          state.skipped++; note(verdict.reason);
        }
      } catch (e) {
        state.skipped++; note("firecrawl: " + e.message.slice(0, 40));
      }
    }
  } else {
    for (const row of needsPaid) { state.skipped++; note(row.why); }
  }

  state.running = false;
  state.finished_at = new Date().toISOString();
  state.remaining = d.countMissingText.get().n;
  return state;
}
