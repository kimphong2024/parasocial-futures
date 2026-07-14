// Scenario depth chambers — one pinned act per archetype, driven by the same
// rAF scroll grammar as the home hero: reveal → report → dive through.
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const ORDER = ["growth", "collapse", "discipline", "transformation"];
const ROMAN = ["I", "II", "III", "IV"];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const condText = (c) => {
  if (c.op === "lte") return `${c.driver_key.replaceAll("_", " ")} ≤ ${c.value}`;
  if (c.op === "gte") return `${c.driver_key.replaceAll("_", " ")} ≥ ${c.value}`;
  if (c.op === "between") return `${c.driver_key.replaceAll("_", " ")} ∈ [${c.lo}, ${c.hi}]`;
  return c.driver_key;
};

function chamberHTML(arch, meta, sc, i) {
  const conds = sc ? JSON.parse(sc.driver_conditions || "[]").slice(0, 3) : [];
  const cited = sc ? JSON.parse(sc.signal_ids || "[]").length : 0;
  return `<section class="chamber ${sc ? "" : "chamber-empty"}" data-arch="${arch}">
    <div class="chamber-stage">
      <figure class="chamber-figure">
        ${sc
          ? `<img src="/img/scenario-${arch}.jpg" alt="${esc(meta.name)} — the scenario's myth as a specimen photograph" onerror="this.style.display='none'">`
          : `<div class="empty-orb"></div>`}
      </figure>
      <div class="chamber-glow" aria-hidden="true"></div>
      <span class="chamber-index">${ROMAN[i]} / IV</span>

      <div class="chamber-titleblock">
        <span class="chamber-arch">${esc(meta.name)}</span>
        ${sc ? `
          <h2 class="chamber-title">${esc(sc.title)}</h2>
          <p class="chamber-summary">${esc(sc.summary)}</p>
          <div class="chamber-actions">
            <a class="btn btn-sm" href="/scenario?id=${sc.id}">Read the full scenario</a>
            <span class="status-chip status-${esc(sc.status)}">${esc(sc.status)}</span>
          </div>`
        : `
          <h2 class="chamber-title">Not yet drafted</h2>
          <p class="chamber-summary">${esc(meta.logic)}</p>
          <div class="chamber-actions">
            <button class="btn btn-sm" data-draft="${arch}">Draft with Claude</button>
          </div>`}
      </div>

      ${sc ? `
        <blockquote class="chamber-myth">${esc(sc.myth)}<span class="mono-src">Layer 4 · myth and metaphor</span></blockquote>
        <div class="chamber-annos">
          ${conds.map((c) => `<div class="reticle"><span class="ret"></span><span class="k">Holds when</span><span class="v">${esc(condText(c))}</span></div>`).join("")}
          <div class="reticle"><span class="ret"></span><span class="k">Evidence</span><span class="v">${cited} cited signals</span></div>
        </div>` : ""}
    </div>
  </section>`;
}

// --- scroll engine (shared grammar with the home hero) ---
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOutExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const easeInCubic = (x) => x * x * x;
const ANNO_STARTS = [0.34, 0.44, 0.54, 0.64];

function attachEngine() {
  const chambers = [...document.querySelectorAll(".chamber")];
  if (!chambers.length) return;
  let ticking = false;
  function update() {
    ticking = false;
    for (const ch of chambers) {
      const stage = ch.querySelector(".chamber-stage");
      const rect = ch.getBoundingClientRect();
      if (rect.bottom < -60 || rect.top > innerHeight + 60) continue;
      const track = rect.height - innerHeight;
      const p = clamp01(-rect.top / track);
      const lit = easeOutExpo(clamp01(p / 0.4));
      const settle = 1.08 - 0.08 * clamp01(p / 0.4);
      const zoom = 1 + 1.6 * easeInCubic(clamp01((p - 0.7) / 0.3));
      stage.style.setProperty("--reveal", (0.06 + 0.94 * lit).toFixed(4));
      stage.style.setProperty("--scale", (settle * zoom).toFixed(4));
      stage.style.setProperty("--rise", easeOutExpo(clamp01((p - 0.16) / 0.16)).toFixed(4));
      stage.style.setProperty("--myth", easeOutExpo(clamp01((p - 0.30) / 0.14)).toFixed(4));
      stage.style.setProperty("--ui", (1 - clamp01((p - 0.72) / 0.12)).toFixed(4));
      stage.style.setProperty("--glow", (0.85 * easeInCubic(clamp01((p - 0.82) / 0.18)) * (1 - clamp01((p - 0.96) / 0.04))).toFixed(4));
      stage.style.setProperty("--exit", (1 - clamp01((p - 0.93) / 0.06)).toFixed(4));
      ch.querySelectorAll(".chamber-annos .reticle").forEach((el, i) =>
        el.style.setProperty("--o", easeOutExpo(clamp01((p - ANNO_STARTS[i]) / 0.10)).toFixed(4)));
    }
  }
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener("resize", update, { passive: true });
  update();
}

async function load() {
  const j = await api("/api/scenarios");
  const active = (arch) => j.scenarios.find((s) => s.archetype === arch && s.status !== "archived");
  $("chambers").innerHTML = ORDER.map((arch, i) => chamberHTML(arch, j.archetypes[arch], active(arch), i)).join("");
  $("draftButtons").innerHTML = ORDER.map((arch) =>
    `<button class="btn btn-secondary btn-sm" data-draft="${arch}">Draft ${esc(j.archetypes[arch].name)}</button>`).join("");
  if (!reduced) attachEngine();
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-draft]");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Drafting… (about a minute)";
  $("err").innerHTML = "";
  try {
    const sc = await api("/api/scenarios/draft", { method: "POST", body: { archetype: btn.dataset.draft, focus: $("focus")?.value.trim() || "" } });
    location.href = "/scenario?id=" + sc.id;
  } catch (err) {
    $("err").innerHTML = `<div class="error-note">Draft failed: ${esc(err.message)}</div>`;
    btn.disabled = false;
    btn.textContent = "Draft with Claude";
  }
});

renderNav("/scenarios");
load();
