// The retained source text behind a signal, shown wherever a signal is opened.
// Mirrors signal-note.js: `sourceText(s)` returns markup, `wireSourceText(root)`
// activates it. Collapsed and lazily fetched — a retained article runs to tens
// of thousands of characters and belongs behind a disclosure, not in the drawer
// by default.
import { api, esc } from "./api.js";

export function sourceText(s) {
  const chars = s.text_chars || 0;
  if (!chars) {
    return `<div class="src-text src-none"><span class="note-label">Source text</span>
      <p class="caption">Not retained — the fetcher could not reach a usable article for this URL.</p></div>`;
  }
  return `<details class="src-text" data-src-for="${s.id}">
    <summary><span class="note-label">Source text</span>
      <span class="src-meta">${chars.toLocaleString()} characters retained · checked against for verbatim quotes</span></summary>
    <div class="src-body"><p class="caption">Loading…</p></div>
  </details>`;
}

// The same comparison form the server uses (quotes.js normalise), so a
// quotation typed with curly quotes is found in text stored with straight ones.
const normalise = (s) => String(s || "")
  .normalize("NFKC")
  .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
  .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
  .replace(/[\u2010-\u2015\u2212]/g, "-")
  .replace(/\u2026/g, "...")
  .replace(/\s+/g, " ")
  .trim();

// When the drawer was opened from a quotation (`data-quote` on the drawer),
// the retained text opens by itself with those words marked and scrolled to.
// That is the guarantee made visible: the words, in the source, at the place.
export function wireSourceText(root) {
  const el = root.querySelector?.(".src-text[data-src-for]");
  if (!el || el._wired) return;
  el._wired = true;
  const wanted = normalise(root.dataset?.quote || root.closest?.("[data-quote]")?.dataset.quote || "");
  el.addEventListener("toggle", async () => {
    if (!el.open || el._loaded) return;
    el._loaded = true;
    const body = el.querySelector(".src-body");
    try {
      const t = await api(`/api/signals/${el.dataset.srcFor}/text`);
      const at = wanted ? t.text.indexOf(wanted) : -1;
      const prose = at >= 0
        ? `${esc(t.text.slice(0, at))}<mark class="vq-hit">${esc(t.text.slice(at, at + wanted.length))}</mark>${esc(t.text.slice(at + wanted.length))}`
        : t.text.split(/\n{2,}/).map((p) => esc(p)).join("</p><p>");
      body.innerHTML = `<p class="src-hash caption">sha256 ${esc(t.sha256.slice(0, 24))}… · retained ${esc((t.created_at || "").slice(0, 10))}${wanted ? (at >= 0 ? ` · quotation found at character ${at.toLocaleString()}` : " · quotation not found in this text") : ""}</p>
        <div class="src-scroll"><p>${prose}</p></div>`;
      const hit = body.querySelector(".vq-hit");
      if (hit) hit.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (e) {
      body.innerHTML = `<p class="caption">${esc(e.message)}</p>`;
      el._loaded = false;
    }
  });
  if (wanted) el.open = true;
}
