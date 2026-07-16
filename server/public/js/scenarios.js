// Scenario strata — all four archetypes layered in ONE pinned composition
// (multilayer parallax): the stack is visible at once, and scrolling dollies
// the camera inward. The current layer flies apart past the camera while
// every deeper layer swells one step nearer. Vanilla rAF, no libraries.
import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";

const $ = (id) => document.getElementById(id);
const ORDER = ["growth", "collapse", "discipline", "transformation"];
const ROMAN = ["I", "II", "III", "IV"];
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

function stratumHTML(arch, meta, sc, i) {
  const cited = sc ? JSON.parse(sc.signal_ids || "[]").length : 0;
  // nearer strata paint over deeper ones
  return `<div class="stratum ${sc ? "" : "stratum-empty"}" data-i="${i}" data-arch="${arch}" style="z-index:${40 - i}">
    <figure class="stratum-figure">
      ${sc
        ? `<img src="/img/scenario-${arch}.jpg" alt="${esc(meta.name)} — the scenario's myth as a specimen photograph" onerror="this.style.display='none'">`
        : `<div class="empty-orb"></div>`}
    </figure>
    <div class="stratum-panel">
      <span class="chamber-arch">${esc(meta.name)} · stratum ${ROMAN[i]}</span>
      ${sc ? `
        <h2 class="stratum-title">${esc(sc.title)}</h2>
        <p class="stratum-summary">${esc(sc.summary)}</p>
        <blockquote class="stratum-myth">${esc(sc.myth)}</blockquote>
        <div class="chamber-actions">
          <a class="btn btn-sm" href="/scenario?id=${sc.id}">Enter this scenario</a>
          <span class="status-chip status-${esc(sc.status)}">${esc(sc.status)}</span>
          <span class="caption">${cited} cited signals</span>
        </div>`
      : `
        <h2 class="stratum-title">Not yet drafted</h2>
        <p class="stratum-summary">${esc(meta.logic)}</p>
        <div class="chamber-actions">
          <button class="btn btn-sm" data-draft="${arch}">Draft with Claude</button>
        </div>`}
    </div>
  </div>`;
}

// --- the camera engine: one global depth, every layer driven from it ---
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOutExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const easeInCubic = (x) => x * x * x;

function attachEngine() {
  const strata = $("strata");
  if (!strata) return;
  const stage = $("strataStage");
  const layers = [...stage.querySelectorAll(".stratum")];
  const rail = [...document.querySelectorAll("#strataRail span")];
  const index = $("strataIndex");
  const last = layers.length - 1;
  let ticking = false;
  function update() {
    ticking = false;
    const rect = strata.getBoundingClientRect();
    if (rect.bottom < -60 || rect.top > innerHeight + 60) return;
    const p = clamp01(-rect.top / (rect.height - innerHeight));
    const z = p * last; // camera depth in layer units; ends settled on the deepest

    layers.forEach((el, i) => {
      const d = i - z; // signed distance from the camera
      let s, o, br, bl, y, fx, px, pv;
      if (d >= 0) {
        // ahead: smaller, dimmer, softer, cascading up-left — a visible stack
        s = 1 / (1 + 0.42 * d);
        o = clamp01((2.6 - d) / 1.0);
        br = Math.max(0.16, 1 - 0.42 * Math.min(d, 1) - 0.15 * Math.max(0, d - 1));
        bl = Math.min(5, 1.8 * d);
        y = -120 * d;
        fx = -150 * d;
        px = 0;
        pv = easeOutExpo(clamp01(1 - d / 0.8));
      } else {
        // passed: flies apart past the camera — image right, words left
        const a = clamp01(-d / 0.55);
        s = 1 + 0.95 * a;
        o = 1 - a;
        br = 1;
        bl = 3.5 * a;
        y = 0;
        fx = 130 * a;
        px = -110 * a;
        pv = clamp01(1 - a * 1.25);
      }
      el.style.setProperty("--s", s.toFixed(4));
      el.style.setProperty("--o", o.toFixed(4));
      el.style.setProperty("--br", br.toFixed(4));
      el.style.setProperty("--bl", bl.toFixed(2) + "px");
      el.style.setProperty("--y", y.toFixed(1) + "px");
      el.style.setProperty("--fx", fx.toFixed(1) + "px");
      el.style.setProperty("--px", px.toFixed(1) + "px");
      el.style.setProperty("--pv", pv.toFixed(4));
      el.classList.toggle("now", Math.abs(d) < 0.5);
    });

    // a brief bloom at each hand-off, and a settle glow on arrival at the deepest
    const frac = z % 1;
    const pulse = z < last - 0.02 ? Math.pow(Math.sin(Math.PI * frac), 8) * 0.2 : 0;
    const settle = 0.5 * easeInCubic(clamp01((p - 0.88) / 0.12));
    stage.style.setProperty("--glow", (pulse + settle).toFixed(4));

    const cur = Math.min(last, Math.max(0, Math.round(z)));
    rail.forEach((el, i) => el.classList.toggle("now", i === cur));
    index.textContent = `${ROMAN[cur]} / IV`;
  }
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener("resize", update, { passive: true });
  update();
}

async function load() {
  const j = await api("/api/scenarios");
  const active = (arch) => j.scenarios.find((s) => s.archetype === arch && s.status !== "archived");
  $("chambers").innerHTML = `
    <section class="strata" id="strata">
      <div class="strata-stage" id="strataStage">
        <div class="strata-glow" aria-hidden="true"></div>
        ${ORDER.map((arch, i) => stratumHTML(arch, j.archetypes[arch], active(arch), i)).join("")}
        <span class="strata-index" id="strataIndex">I / IV</span>
        <div class="strata-rail" id="strataRail">
          ${ORDER.map((arch, i) => `<span data-l="${i}">${ROMAN[i]} ${esc(j.archetypes[arch].name)}</span>`).join("")}
        </div>
      </div>
    </section>`;
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
