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

// How long before a failed signal is worth trying again, by attempt number.
// After the last tier it is given up on: a 404 is not going to become a 200,
// and re-serving it forever is how 840 calls were spent on nothing.
const RETRY_AFTER_H = [2, 12, 72];
const nextTry = (attempts) => {
  const h = RETRY_AFTER_H[attempts];        // attempts is the count BEFORE this one
  return h === undefined ? null : new Date(Date.now() + h * 3600_000).toISOString();
};

// Firecrawl answering 402 means the credits are gone; every further call this
// run is guaranteed to fail the same way. Stop asking, and stop asking for a
// while afterwards.
const PAID_COOLDOWN_MS = 6 * 3600_000;
let paidBlockedUntil = 0;
let paidBlockedReason = "";
const paidBlocked = () => Date.now() < paidBlockedUntil;

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
    // A PDF is not a failure, it is the paid stage's job — Firecrawl parses
    // them. arxiv alone accounts for 47 signals, and papers are exactly the
    // sources worth quoting exactly.
    if (/pdf/i.test(ct)) return { ok: false, reason: "pdf — needs parsing" };
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
  paid_blocked: false,
  paid_blocked_reason: "",
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

// ---------------- automatic draining ----------------

// A signal without retained source text is an unfinished scan, not a task for
// a person. The corpus fills itself: a bounded batch every interval, skipped
// while a scan is running so the two never compete for Firecrawl's rate limit.
const DRAIN_INTERVAL_MS = Number(process.env.BACKFILL_INTERVAL_MS || 10 * 60 * 1000);
const DRAIN_BATCH = Number(process.env.BACKFILL_BATCH || 120);

export function startBackfillDrainer(isBusy = () => false) {
  const tick = async () => {
    if (state?.running || isBusy()) return;
    // Only signals actually due — a queue that is entirely backed off or given
    // up on is not work, and running anyway is what caused the waste.
    const due = d.countRetryable.get(d.now()).n;
    if (!due) return;
    try {
      const r = await runBackfill({ limit: DRAIN_BATCH });
      console.log(`[backfill] drained ${r.stored}/${r.target} (${r.direct_hits} free, ${r.firecrawl_hits} paid) — ${r.remaining} left`);
      // The audit log is the record of the platform, and this is the platform
      // acting on its own. It runs without a request, so the audit middleware
      // never sees it — the row is written here instead, which also gives the
      // run history somewhere to live across restarts.
      const top = Object.entries(r.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, n]) => `${n} ${k}`).join(", ");
      d.insertAudit.run(
        d.now(), "SYSTEM", "/api/quotes/backfill", "quotes.drain", "corpus", null,
        `Fetched source text for ${r.stored} of ${r.target} signals (${r.direct_hits} direct, ${r.firecrawl_hits} via Firecrawl from ${r.firecrawl_calls} calls) — ${r.remaining} still without text${top ? `. Unrecoverable: ${top}` : ""}`,
        JSON.stringify({ stored: r.stored, target: r.target, direct: r.direct_hits, firecrawl: r.firecrawl_hits, calls: r.firecrawl_calls, remaining: r.remaining, reasons: r.reasons }),
        null, 200,
      );
    } catch (e) {
      console.error("[backfill] drain failed:", e.message);
      try {
        d.insertAudit.run(d.now(), "SYSTEM", "/api/quotes/backfill", "quotes.drain", "corpus", null,
          `Source-text fetch failed — ${e.message.slice(0, 140)}`, "{}", null, 500);
      } catch { /* logging must never take the drainer down */ }
    }
  };
  setTimeout(tick, 90_000);            // let boot settle first
  setInterval(tick, DRAIN_INTERVAL_MS);
  console.log(`[backfill] drainer on — ${DRAIN_BATCH} signals every ${Math.round(DRAIN_INTERVAL_MS / 60000)} min while any remain`);
}

/**
 * limit — how many signals to attempt this run (resumable; call again for more).
 * useFirecrawl — false to run the free pass only, spending nothing.
 */
export async function runBackfill({ limit = 200, useFirecrawl = true } = {}) {
  if (state?.running) return { skipped: true, reason: "backfill already running" };
  const rows = d.signalsMissingText.all(d.now(), limit);
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
            d.clearTextAttempt.run(row.id);
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
  const fail = (row, reason) => {
    const prior = d.getTextAttempt.get(row.id)?.attempts || 0;
    d.recordTextAttempt.run(row.id, d.now(), String(reason).slice(0, 160), nextTry(prior));
    state.skipped++; note(reason);
  };

  if (useFirecrawl && firecrawlEnabled() && !state.aborted && !paidBlocked()) {
    for (const row of needsPaid) {
      if (state.aborted) break;
      if (paidBlocked()) { fail(row, row.why); continue; }
      state.firecrawl_calls++;
      try {
        const [page] = await firecrawlScrapeOne(row.url);
        const verdict = articleTextVerdict(page?.markdown || "");
        if (verdict.ok) {
          storeArticleText(row.id, page.markdown);
          d.clearTextAttempt.run(row.id);
          state.stored++; state.firecrawl_hits++;
        } else {
          fail(row, verdict.reason);
        }
      } catch (e) {
        const msg = e.message || String(e);
        // 402 payment required / 401 unauthorised are account-level, not
        // about this URL. Retrying the other 119 is pure waste.
        if (/\b(402|401)\b/.test(msg)) {
          paidBlockedUntil = Date.now() + PAID_COOLDOWN_MS;
          paidBlockedReason = /402/.test(msg) ? "Firecrawl credits exhausted (402)" : "Firecrawl rejected the key (401)";
          state.paid_blocked = true;
          state.paid_blocked_reason = paidBlockedReason;
          console.warn(`[backfill] ${paidBlockedReason} — pausing paid fetches for 6h`);
          fail(row, paidBlockedReason);
        } else {
          fail(row, "firecrawl: " + msg.slice(0, 60));
        }
      }
    }
  } else {
    if (paidBlocked()) { state.paid_blocked = true; state.paid_blocked_reason = paidBlockedReason; }
    for (const row of needsPaid) fail(row, paidBlocked() ? paidBlockedReason : row.why);
  }

  state.running = false;
  state.finished_at = new Date().toISOString();
  state.remaining = d.countMissingText.get().n;
  state.retryable = d.countRetryable.get(d.now()).n;
  state.given_up = d.countGivenUp.get().n;
  return state;
}
