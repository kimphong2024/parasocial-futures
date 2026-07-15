// Shared shell: triad bar + header + nav with pending-review badge.
import { api } from "./api.js";

const LINKS = [
  ["/signals", "Signals"],
  ["/review", "Review"],
  ["/scenarios", "Scenarios"],
  ["/simulation", "Simulation"],
  ["/chat", "Chat"],
  ["/sources", "Scanning"],
];

export async function renderNav(active) {
  const header = document.createElement("div");
  header.innerHTML = `
    <div class="triad-bar"></div>
    <header class="site-header">
      <div class="site-header-inner">
        <a href="/signals" style="text-decoration:none">
          <div class="brand">
            <span class="label">Foresight Capstone · 2040</span>
            <span class="brand-title">Futures of Parasocial AI</span>
          </div>
        </a>
        <nav class="site-nav">
          ${LINKS.map(([href, name]) =>
            `<a href="${href}" class="${href === active ? "active" : ""}" data-nav="${name.toLowerCase()}">${name}</a>`).join("")}
        </nav>
      </div>
    </header>`;
  document.body.prepend(header);
  try {
    const h = await api("/api/health");
    const pending = (h.pending || 0) + (h.drafts || 0);
    if (pending > 0) {
      const a = header.querySelector('[data-nav="review"]');
      a.insertAdjacentHTML("beforeend", `<span class="nav-badge">${pending}</span>`);
    }
    return h;
  } catch { return null; }
}
