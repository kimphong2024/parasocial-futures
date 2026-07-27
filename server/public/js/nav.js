// Shared shell: triad bar + header + two-row nav (sections + sub-nav).
// Five sections; a child page lights its parent in the top row and itself
// in the sub-row. The pending-review count rides on "Signal review", with
// a dot on Signals so the queue is visible from anywhere.
import { api } from "./api.js";

const SECTIONS = [
  { path: "/signals", label: "Signals", children: [["/map", "Signal map"], ["/radar", "Signal radar"], ["/review", "Signal review"], ["/sources", "Scan settings"]] },
  { path: "/triangle", label: "Futures Triangle", children: [["/triangle-config", "Triangle configure"]] },
  { path: "/drivers", label: "Drivers", children: [["/driver-config", "Driver configure"]] },
  { path: "/scenarios", label: "Scenarios", children: [["/scenario-config", "Scenario configure"], ["/simulation", "Scenario simulation"]] },
  { path: "/artifacts", label: "Artifacts", children: [] },
  { path: "/chat", label: "Chat", children: [] },
  { path: "/activity", label: "Activity", children: [] },
  { path: "/reference", label: "Method", children: [] },
];

const sectionOf = (path) =>
  SECTIONS.find((s) => s.path === path || s.children.some(([p]) => p === path)) ||
  (path === "/scenario" ? SECTIONS[2] : null);

export async function renderNav(active) {
  const section = sectionOf(active);
  const header = document.createElement("div");
  header.innerHTML = `
    <div class="triad-bar"></div>
    <header class="site-header">
      <div class="site-header-inner">
        <a href="/" style="text-decoration:none">
          <div class="brand">
            <span class="brand-title"><span class="mark">Throuple with AI</span></span>
          </div>
        </a>
        <nav class="site-nav">
          ${SECTIONS.map((s) =>
            `<a href="${s.path}" class="${s === section ? "active" : ""}" data-nav="${s.path}">${s.label}</a>`).join("")}
        </nav>
      </div>
      ${section && section.children.length ? `
      <div class="site-subnav">
        <div class="site-subnav-inner">
          <a href="${section.path}" class="${active === section.path ? "active" : ""}">${section.label} home</a>
          ${section.children.map(([p, name]) =>
            `<a href="${p}" class="${p === active ? "active" : ""}" data-nav="${p}">${name}</a>`).join("")}
        </div>
      </div>` : ""}
    </header>`;
  document.body.prepend(header);
  try {
    const h = await api("/api/health");
    const pending = (h.pending || 0) + (h.drafts || 0);
    if (pending > 0) {
      header.querySelector('[data-nav="/review"]')?.insertAdjacentHTML("beforeend", `<span class="nav-badge">${pending}</span>`);
      header.querySelector('[data-nav="/signals"]')?.insertAdjacentHTML("beforeend", `<span class="nav-dot" title="${pending} awaiting review"></span>`);
    }
    return h;
  } catch { return null; }
}
