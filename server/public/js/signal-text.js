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

export function wireSourceText(root) {
  const el = root.querySelector?.(".src-text[data-src-for]");
  if (!el || el._wired) return;
  el._wired = true;
  el.addEventListener("toggle", async () => {
    if (!el.open || el._loaded) return;
    el._loaded = true;
    const body = el.querySelector(".src-body");
    try {
      const t = await api(`/api/signals/${el.dataset.srcFor}/text`);
      body.innerHTML = `<p class="src-hash caption">sha256 ${esc(t.sha256.slice(0, 24))}… · retained ${esc((t.created_at || "").slice(0, 10))}</p>
        <div class="src-scroll">${t.text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("")}</div>`;
    } catch (e) {
      body.innerHTML = `<p class="caption">${esc(e.message)}</p>`;
      el._loaded = false;
    }
  });
}
