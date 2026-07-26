// Field notes — the reviewer's own card on any signal, rendered identically
// in every signal-detail surface. `noteCard(s)` returns the markup;
// `wireNoteCard(root)` wires add/edit/save within that container.
import { api, esc } from "./api.js";

const stamp = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function noteCard(s) {
  const note = (s.note || "").trim();
  return `
  <div class="note-card ${note ? "" : "note-empty"}" data-note-for="${s.id}" data-updated="${esc(s.note_updated_at || "")}">
    <div class="note-head">
      <span class="note-label">Field note</span>
      <span class="note-meta">${s.note_updated_at ? "edited " + esc(stamp(s.note_updated_at)) : ""}</span>
    </div>
    <div class="note-body">
      ${note
        ? `<p class="note-text">${esc(note)}</p><button class="note-edit">Edit</button>`
        : `<button class="note-add">＋ Add a note</button>`}
    </div>
  </div>`;
}

export function wireNoteCard(root) {
  const card = root.querySelector(".note-card");
  if (!card || card._wired) return;
  card._wired = true;
  const id = Number(card.dataset.noteFor);

  const display = (note, updated) => {
    card.classList.toggle("note-empty", !note);
    card.querySelector(".note-meta").textContent = updated ? "edited " + stamp(updated) : "";
    card.querySelector(".note-body").innerHTML = note
      ? `<p class="note-text">${esc(note)}</p><button class="note-edit">Edit</button>`
      : `<button class="note-add">＋ Add a note</button>`;
  };

  const edit = () => {
    const current = card.querySelector(".note-text")?.textContent || "";
    card.classList.remove("note-empty");
    card.querySelector(".note-body").innerHTML = `
      <textarea class="note-input" rows="4" placeholder="A hunch, a follow-up, a thread to pull…">${esc(current)}</textarea>
      <div class="note-actions">
        <button class="note-save">Save</button>
        <button class="note-cancel">Cancel</button>
        <span class="note-state caption"></span>
      </div>`;
    const ta = card.querySelector(".note-input");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.addEventListener("keydown", (e) => { if (e.key === "Escape") display(current, card.dataset.updated); });
    card.querySelector(".note-cancel").onclick = () => display(current, card.dataset.updated);
    card.querySelector(".note-save").onclick = async () => {
      const state = card.querySelector(".note-state");
      state.textContent = "saving…";
      try {
        const r = await api(`/api/signals/${id}/note`, { method: "PATCH", body: { note: ta.value } });
        card.dataset.updated = r.note_updated_at || "";
        display(r.note, r.note_updated_at);
        card.classList.add("note-saved");
        setTimeout(() => card.classList.remove("note-saved"), 900);
      } catch (e) {
        state.textContent = `could not save (${e.message}) — your draft is still here`;
      }
    };
  };

  card.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target.closest(".note-edit") || e.target.closest(".note-add")) edit();
  });
}
