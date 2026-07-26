import { api, esc } from "./api.js";
import { renderNav } from "./nav.js";
import { noteCard, wireNoteCard } from "./signal-note.js";

const id = new URLSearchParams(location.search).get("id");
const $ = (id) => document.getElementById(id);
let sc = null, editing = false;

const LAYERS = [
  ["litany", "Layer 1 — Litany", "cla-litany", "The visible surface of 2040: headlines, statistics, everyday observations."],
  ["systemic", "Layer 2 — Systemic Causes", "cla-systemic", "The structures producing the surface: economics, technology, regulation, demography."],
  ["worldview", "Layer 3 — Worldview", "cla-worldview", "The shared beliefs that make this world coherent to the people living in it."],
  ["myth", "Layer 4 — Myth and Metaphor", "cla-myth", "The deep story underneath."],
];

const condText = (c) => {
  if (c.op === "lte") return `${c.driver_key} ≤ ${c.value}`;
  if (c.op === "gte") return `${c.driver_key} ≥ ${c.value}`;
  if (c.op === "between") return `${c.driver_key} in [${c.lo}, ${c.hi}]`;
  return `${c.driver_key} ${c.op}`;
};

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOutExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));
const easeInCubic = (x) => x * x * x;
const RAIL = ["Litany", "Systemic", "Worldview", "Myth"];

// The CLA descent: one pinned stage, four layers passed through in depth
// order, the archetype image approaching the whole way down.
function descentHTML() {
  return `
    <section class="descent" id="descent">
      <div class="descent-stage" id="descentStage">
        <div class="descent-glow" aria-hidden="true"></div>
        <div class="descent-index" id="descentIndex">Layer I / IV</div>
        <svg class="descent-pyramid" id="descentPyramid" viewBox="0 0 420 470" role="group" aria-label="Causal Layered Analysis pyramid — four clickable layers">
          <g class="tier" data-l="0"><polygon points="210,6 302,112 118,112"/><text x="210" y="92">LITANY</text></g>
          <g class="tier" data-l="1"><polygon points="108,124 312,124 358,230 62,230"/><text x="210" y="184">SYSTEMIC</text></g>
          <g class="tier" data-l="2"><polygon points="56,242 364,242 400,348 20,348"/><text x="210" y="302">WORLDVIEW</text></g>
          <g class="tier" data-l="3"><polygon points="14,360 406,360 418,466 2,466"/><text x="210" y="420">MYTH</text></g>
        </svg>
        <div class="descent-right">
          <div class="descent-panels">
            ${LAYERS.map(([key, name, , hint], i) => `
              <div class="dlayer ${key === "myth" ? "dlayer-myth" : ""}" data-layer="${i}">
                <span class="dl-label">${name}</span>
                <h3>${esc(RAIL[i])}</h3>
                <p class="dl-text">${esc(sc[key])}</p>
                <p class="dl-hint">${hint}</p>
              </div>`).join("")}
          </div>
        </div>
      </div>
    </section>`;
}

const ROMAN = ["I", "II", "III", "IV"];
function attachDescent() {
  const descent = document.getElementById("descent");
  if (!descent || reduced) return;
  const stage = document.getElementById("descentStage");
  const layers = [...stage.querySelectorAll(".dlayer")];
  const rail = [...stage.querySelectorAll(".descent-pyramid .tier")];
  rail.forEach((tier, i) => tier.addEventListener("click", () => {
    // centre of layer i within the pinned track
    const track = descent.offsetHeight - innerHeight;
    scrollTo({ top: descent.offsetTop + Math.round(((i + 0.42) / 4) * track), behavior: reduced ? "auto" : "smooth" });
  }));
  const index = document.getElementById("descentIndex");
  const panels = stage.querySelector(".descent-panels");
  // how far each layer's text overflows its window — re-measured on resize
  let overflows = layers.map(() => 0);
  const measure = () => {
    // pad past the bottom fade so the last line lands fully readable
    const pad = panels.clientHeight * 0.16;
    overflows = layers.map((el) => { const o = el.scrollHeight - panels.clientHeight; return o > 0 ? o + pad : 0; });
  };
  measure();
  addEventListener("resize", measure, { passive: true });
  let ticking = false;
  function update() {
    ticking = false;
    const rect = descent.getBoundingClientRect();
    if (rect.bottom < -60 || rect.top > innerHeight + 60) return;
    const p = clamp01(-rect.top / (rect.height - innerHeight));
    // the destination approaches: brighter and nearer with depth
    stage.style.setProperty("--breveal", (0.1 + 0.8 * easeOutExpo(clamp01(p / 0.22))).toFixed(4));
    stage.style.setProperty("--bscale", (1 + 0.38 * p).toFixed(4));
    stage.style.setProperty("--glow", (0.7 * easeInCubic(clamp01((p - 0.78) / 0.22))).toFixed(4));
    const nowIdx = Math.min(3, Math.floor(p * 4));
    layers.forEach((el, i) => {
      const s = clamp01(p * 4 - i);
      const e = easeOutExpo(clamp01(s / 0.22));
      const x = i === 3 ? 0 : easeInCubic(clamp01((s - 0.78) / 0.22));
      // a layer taller than its window glides through it mid-segment
      const glide = overflows[i] * clamp01((s - 0.38) / (i === 3 ? 0.55 : 0.3));
      el.style.setProperty("--e", e.toFixed(4));
      el.style.setProperty("--x", x.toFixed(4));
      el.style.setProperty("--ty", glide.toFixed(1) + "px");
      el.classList.toggle("now", i === nowIdx);
    });
    rail.forEach((el, i) => el.classList.toggle("now", i === nowIdx));
    index.textContent = `Layer ${ROMAN[nowIdx]} / IV`;
  }
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener("resize", update, { passive: true });
  update();
}

function headerHTML() {
  return `
    <div class="page-head flex-between" style="margin:0;padding:0">
      <div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="tag tag-olive">${esc(sc.archetype)}</span>
          <span class="status-chip status-${esc(sc.status)}">${esc(sc.status)}</span>
          <span class="caption">horizon ${sc.horizon_year}</span>
        </div>
        ${editing
          ? `<input id="e-title" value="${esc(sc.title)}" style="font-size:26px;font-weight:800;width:100%;margin-top:12px">`
          : `<h2 class="mt-2">${esc(sc.title)}</h2>`}
        ${editing
          ? `<textarea id="e-summary" rows="3" class="mt-2">${esc(sc.summary)}</textarea>`
          : `<p class="subtitle mt-2">${esc(sc.summary)}</p>`}
        ${editing ? "" : `<div class="scroll-hint" style="margin-top:14px"><span class="tick"></span>Scroll to descend through the layers</div>`}
        <div class="divider mt-4"></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${editing
          ? `<button class="btn" id="save">Save changes</button><button class="btn btn-secondary" id="cancel">Cancel</button>`
          : `<button class="btn btn-secondary" id="edit">Edit</button>
             ${sc.status === "draft" ? `<button class="btn" id="publish">Publish</button>` : ""}
             ${sc.status !== "archived" ? `<button class="btn-danger btn" id="archive">Archive</button>` : ""}
             <a class="btn btn-secondary btn-sm" href="/scenario-config" style="align-self:center">All scenarios</a>`}
      </div>
    </div>`;
}

function belowHTML(conds) {
  return `
    <section class="card chart-block mt-6">
      <h4>Narrative — a day in this 2040</h4>
      ${editing
        ? `<textarea id="e-narrative" rows="14">${esc(sc.narrative)}</textarea>`
        : `<p style="white-space:pre-wrap">${esc(sc.narrative)}</p>`}
    </section>

    <section class="card chart-block">
      <h4>Where this scenario lives in the driver space</h4>
      <p class="caption mb-4">The simulation counts a sampled future as belonging to this scenario when all conditions hold.</p>
      ${editing
        ? `<textarea id="e-conditions" rows="6">${esc(JSON.stringify(conds, null, 2))}</textarea>
           <p class="caption mt-2">JSON: [{"driver_key", "op": "lte" | "gte" | "between", "value" | "lo" + "hi"}]</p>`
        : (conds.length
            ? `<div style="display:flex;gap:8px;flex-wrap:wrap">${conds.map((c) => `<span class="tag tag-mustard">${esc(condText(c))}</span>`).join("")}</div>`
            : `<p class="caption">No conditions set — this scenario will not appear in simulations.</p>`)}
    </section>

    <section class="card chart-block">
      <h4>Evidence — cited signals (${sc.cited.length})</h4>
      <p class="caption mb-4">Signals from the approved library that anchored this draft.</p>
      ${sc.cited.map((s) => `
        <div class="citation mt-2" style="cursor:pointer" data-sig="${s.id}">
          <div class="quote">${esc(s.title)} — ${esc(s.summary).slice(0, 160)}${s.summary.length > 160 ? "…" : ""}</div>
          <div class="source">S${s.id} · ${esc(s.cluster)} · ${esc(s.source || "")}</div>
        </div>`).join("") || `<p class="caption">No citations recorded.</p>`}
    </section>`;
}

function render() {
  const conds = JSON.parse(sc.driver_conditions || "[]");
  const main = $("main");
  if (editing) {
    // Editing works on the flat layers — a form has no business being pinned.
    main.className = "container";
    main.innerHTML = `
      ${headerHTML()}
      <div id="err"></div>
      ${LAYERS.map(([key, name, cls, hint]) => `
        <section class="cla-band ${cls}">
          <span class="label">${name}</span>
          <textarea id="e-${key}" rows="5">${esc(sc[key])}</textarea>
          <p class="caption mt-2">${hint}</p>
        </section>`).join("")}
      ${belowHTML(conds)}`;
  } else {
    // Reading is the descent: header bar, then the pinned journey inward,
    // then the narrative and evidence back in normal flow.
    main.className = "";
    main.innerHTML = `
      <div class="scenario-hero" style="--hero-img:url('/img/scenario-${esc(sc.archetype)}.jpg')">
        <div class="scenario-bar">${headerHTML()}<div id="err"></div></div>
      </div>
      ${descentHTML()}
      <div class="container">${belowHTML(conds)}</div>`;
    attachDescent();
  }
  wire();
}

function wire() {
  $("edit")?.addEventListener("click", () => { editing = true; render(); });
  $("cancel")?.addEventListener("click", () => { editing = false; render(); });
  $("save")?.addEventListener("click", async () => {
    let conds;
    try { conds = JSON.parse($("e-conditions").value); }
    catch { $("err").innerHTML = `<div class="error-note">Driver conditions are not valid JSON.</div>`; return; }
    const patch = {
      title: $("e-title").value, summary: $("e-summary").value,
      litany: $("e-litany").value, systemic: $("e-systemic").value,
      worldview: $("e-worldview").value, myth: $("e-myth").value,
      narrative: $("e-narrative").value, driver_conditions: conds,
    };
    await api("/api/scenarios/" + sc.id, { method: "PATCH", body: patch });
    editing = false;
    await load();
  });
  $("publish")?.addEventListener("click", async () => {
    await api(`/api/scenarios/${sc.id}/publish`, { method: "POST" });
    await load();
  });
  $("archive")?.addEventListener("click", async () => {
    await api(`/api/scenarios/${sc.id}/archive`, { method: "POST" });
    location.href = "/scenarios";
  });
  document.querySelectorAll("[data-sig]").forEach((el) =>
    el.addEventListener("click", async () => {
      const s = await api("/api/signals/" + el.dataset.sig);
      $("drawer").innerHTML = `
        <button class="drawer-close" id="dclose" aria-label="Close">&times;</button>
        <span class="tag tag-olive">${esc(s.cluster)}</span>
        <h3 style="font-size:20px" class="mt-4">${esc(s.title)}</h3>
        <p class="mt-2">${esc(s.summary)}</p>
        <div class="citation mt-4">
          <div class="quote">${esc(s.source || "")} · ${s.year || ""}</div>
          <div class="source"><a href="${esc(s.url)}" target="_blank" rel="noopener">source link</a></div>
        </div>
        ${noteCard(s)}`;
      wireNoteCard($("drawer"));
      document.body.classList.add("drawer-open");
      $("dclose").addEventListener("click", () => document.body.classList.remove("drawer-open"));
    }));
}

async function load() {
  sc = await api("/api/scenarios/" + id);
  document.title = `${sc.title} — Futures of Parasocial AI`;
  render();
}

$("backdrop").addEventListener("click", () => document.body.classList.remove("drawer-open"));
renderNav("/scenarios");
load();
