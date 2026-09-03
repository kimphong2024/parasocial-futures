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
export const normalise = (s) => String(s || "")
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

// Returns { ok, start, end, sha256 } or { ok: false, reason }.
export function verifyQuote(signalId, quote) {
  const q = normalise(quote);
  if (q.length < MIN_QUOTE_CHARS) return { ok: false, reason: "too short to verify" };
  const row = d.getArticleText.get(signalId);
  if (!row) return { ok: false, reason: "no retained source text for this signal" };
  const start = row.text.indexOf(q);
  if (start < 0) return { ok: false, reason: "not found in the retained source text" };
  const rec = { ok: true, start, end: start + q.length, sha256: sha256(q) };
  d.putQuote.run(signalId, q, rec.sha256, rec.start, rec.end, d.now());
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
export function enforceVerbatim(text) {
  if (typeof text !== "string" || (!text.includes('"') && !text.includes("“"))) {
    return { text, checked: 0, stripped: 0, details: [] };
  }
  let checked = 0, stripped = 0;
  const details = [];
  const out = text.replace(QUOTED, (match, quote, id) => {
    checked++;
    const v = verifyQuote(+id, quote);
    if (v.ok) return match;
    stripped++;
    details.push({ signal_id: +id, quote: quote.slice(0, 120), reason: v.reason });
    // Keep the citation, drop the words. The claim can still be followed to
    // its source; it just no longer pretends to be verbatim.
    return `[S${id}]`;
  });
  return { text: out, checked, stripped, details };
}

export const verbatimCoverage = () => d.countArticleText.get().n;
