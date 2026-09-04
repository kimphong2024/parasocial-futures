// Verbatim quotation, guaranteed deterministically.
//
// The signal library's retrieval is embeddings + rerank, and that is adequate
// for finding the right source — the advisor who suggested hashing said so
// himself. What embeddings cannot do is guarantee that words presented inside
// quotation marks are the words that were actually written. Similarity has no
// opinion about a changed number or a dropped "not".
//
// So: when the scanner follows through to a full article, the text is retained
// and hash-pinned. A quotation may then be rendered only if it is found in that
// retained text. The check is a substring lookup, not a model judgment, and it
// fails closed — an unverifiable quotation is stripped rather than flagged and
// shown. Nothing about this is probabilistic.

import { createHash } from "node:crypto";
import * as d from "./db.js";

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Comparison form: collapse whitespace and normalise the punctuation that
// differs between a scrape and a model's reproduction of it. Deliberately
// conservative — case and words are never touched, so a changed word or number
// still fails.
// HTML entities the scrapers leave behind — numeric (&#8221;) and the named
// handful that survive a crude tag strip. A quotation is typed with the real
// character, so the retained text must hold the real character too, or every
// sentence containing a curly quote or an ampersand is refused for nothing.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201D", ldquo: "\u201C", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013" };
export const decodeEntities = (s) => String(s || "")
  .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d{1,7});/g, (_m, n) => String.fromCodePoint(+n))
  .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);

export const normalise = (s) => decodeEntities(s)
  .normalize("NFKC")
  .replace(/[‘’‛′]/g, "'")
  .replace(/[“”‟″]/g, '"')
  .replace(/[‐-―−]/g, "-")
  .replace(/…/g, "...")
  .replace(/\s+/g, " ")
  .trim();

const MIN_QUOTE_CHARS = 25;

// A 200-character floor was the only gate, which let paywall stubs and bot
// challenges through. Retaining one as authoritative source text is worse than
// retaining nothing: a genuine quotation then fails to verify against junk and
// is silently stripped from the report. Ported from RECOLLECTX's parse-url
// extractor, which learned these the hard way across NYT/HBR/Reuters.
const BOT_CHALLENGE = /enable javascript and cookies|are you a robot|verifying you are human|checking your browser|access denied|request blocked|cloudflare|captcha/i;
const PAYWALL_GATE = /subscribe to (access|read|continue)|already a subscriber|create a free account|to continue reading|sign in to (read|continue)|become a subscriber|unlock this article|subscribe to (the )?[a-z ]{3,24} to read/i;

// Exported so the same judgment can be reused by a backfill.
export function articleTextVerdict(text) {
  const clean = normalise(text);
  if (!clean) return { ok: false, reason: "empty", clean: "" };
  if (BOT_CHALLENGE.test(clean.slice(0, 1200))) return { ok: false, reason: "bot challenge page", clean };
  // 1500 rather than 200: HBR "Summary." blocks and newsletter footers clear a
  // few hundred characters and are not articles.
  if (clean.length < 1500) return { ok: false, reason: `too short (${clean.length} chars)`, clean };
  if (PAYWALL_GATE.test(clean)) return { ok: false, reason: "paywall gate", clean };
  return { ok: true, clean };
}

export function storeArticleText(signalId, text) {
  const v = articleTextVerdict(text);
  if (!v.ok) return null;
  const hash = sha256(v.clean);
  d.putArticleText.run(signalId, v.clean, hash, v.clean.length, d.now());
  d.setSignalContentHash.run(hash, signalId);
  return hash;
}

// Returns { ok, start, end, sha256 } or { ok: false, reason }. `record`
// writes a verified quotation to the quotes table; a dry run does not.
export function verifyQuote(signalId, quote, { record = true } = {}) {
  const q = normalise(quote);
  if (q.length < MIN_QUOTE_CHARS) return { ok: false, reason: "too short to verify" };
  const row = d.getArticleText.get(signalId);
  if (!row) return { ok: false, reason: "no retained source text for this signal" };
  const start = row.text.indexOf(q);
  if (start < 0) return { ok: false, reason: "not found in the retained source text" };
  const rec = { ok: true, start, end: start + q.length, sha256: sha256(q) };
  if (record) d.putQuote.run(signalId, q, rec.sha256, rec.start, rec.end, d.now());
  return rec;
}

// A quoted span attributed to a source: it ends at the quote mark immediately
// preceding a [S<id>] citation, which is what makes it a claim about that
// source's actual words. The inner match is lazy and admits nested quote marks
// on purpose — a quotation that itself contains a quotation ("...described as
// a “meaningful attachment” to...") must still be checked in full, and an
// earlier version of this pattern let exactly that case through unexamined.
//
// Scare quotes and terms of art carry no citation and are deliberately left
// alone; they are not claims to have reproduced anyone's words.
const QUOTED = /["“]([\s\S]{25,400}?)["”]\s*(?:\([^)]*\))?\s*\[S(\d+)\]/g;

// Strip any attributed quotation that does not resolve to retained source
// text. Returns the cleaned text plus what was removed, for the audit line.
export function enforceVerbatim(text, { record = true } = {}) {
  if (typeof text !== "string" || (!text.includes('"') && !text.includes("“"))) {
    return { text, checked: 0, stripped: 0, details: [], verdicts: [] };
  }
  let checked = 0, stripped = 0;
  const details = [], verdicts = [];
  const out = text.replace(QUOTED, (match, quote, id) => {
    checked++;
    const v = verifyQuote(+id, quote, { record });
    const verdict = { signal_id: +id, quote: quote.slice(0, 160), ok: !!v.ok };
    if (v.ok) { verdicts.push({ ...verdict, sha256: v.sha256, start: v.start, end: v.end }); return match; }
    stripped++;
    verdicts.push({ ...verdict, reason: v.reason });
    details.push({ signal_id: +id, quote: quote.slice(0, 120), reason: v.reason });
    // Keep the citation, drop the words. The claim can still be followed to
    // its source; it just no longer pretends to be verbatim.
    return `[S${id}]`;
  });
  return { text: out, checked, stripped, details, verdicts };
}

// The same gate over a value that may be structured — an authored watch-list
// is an array of objects, and a quotation inside one of its fields must be
// checked too. Strings are gated in place; the shape is returned unchanged.
export function enforceVerbatimDeep(value, opts = {}) {
  let checked = 0, stripped = 0;
  const details = [], verdicts = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const r = enforceVerbatim(v, opts);
      checked += r.checked; stripped += r.stripped;
      details.push(...r.details); verdicts.push(...r.verdicts);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const text = walk(value);
  return { text, checked, stripped, details, verdicts };
}

export const verbatimCoverage = () => d.countArticleText.get().n;

// Retained rows stored before entities were decoded still carry &#8221; and
// friends. Re-normalise them once at boot; the hash follows the text.
export function repairRetainedText() {
  const rows = d.db.prepare("SELECT signal_id, text FROM article_text WHERE text LIKE '%&#%' OR text LIKE '%&amp;%' OR text LIKE '%&quot;%' OR text LIKE '%&rsquo;%' OR text LIKE '%&nbsp;%' OR text LIKE '%&ldquo;%' OR text LIKE '%&rdquo;%'").all();
  const upd = d.db.prepare("UPDATE article_text SET text = ?, sha256 = ?, chars = ? WHERE signal_id = ?");
  let n = 0;
  for (const r of rows) {
    const clean = normalise(r.text);
    if (clean === r.text) continue;
    const hash = sha256(clean);
    upd.run(clean, hash, clean.length, r.signal_id);
    d.setSignalContentHash.run(hash, r.signal_id);
    n++;
  }
  if (n) console.log(`[quotes] decoded HTML entities in ${n} retained source text(s)`);
  return n;
}
