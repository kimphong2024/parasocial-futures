// CLA iceberg — the four layers of Causal Layered Analysis as a clickable
// iceberg: litany above the waterline, everything that produces it below.
// The panel reads the chosen published scenario's actual layer text.
import { api, esc } from "./api.js";

const $ = (id) => document.getElementById(id);

const LAYERS = {
  litany: {
    name: "Litany",
    depth: "Above the waterline",
    def: "The visible surface of a future: headlines, statistics, product launches, everyday observations. What everyone can see — and the only layer most conversations ever touch.",
  },
  systemic: {
    name: "Systemic causes",
    depth: "Just below the surface",
    def: "The economic, technological, regulatory and demographic structures that produce the litany. Change here moves the surface; arguing only at the surface changes little.",
  },
  worldview: {
    name: "Worldview",
    depth: "Deeper water",
    def: "The shared beliefs and discourses that make the systems legitimate — what the people inside this future hold to be normal, desirable, or inevitable.",
  },
  myth: {
    name: "Myth & metaphor",
    depth: "The deep story",
    def: "The civilisational story underneath it all — the hearth, the golem, the mirror. The hardest layer to see and the strongest: futures change when their myth changes.",
  },
};

let scenarios = [], current = null, activeLayer = "litany";

function renderPanel() {
  const meta = LAYERS[activeLayer];
  const text = current?.[activeLayer === "myth" ? "myth" : activeLayer] || "";
  $("icebergPanel").innerHTML = `
    <span class="caption" style="font-family:var(--font-mono);letter-spacing:1.5px;text-transform:uppercase">${esc(meta.depth)}</span>
    <h4>${esc(meta.name)}</h4>
    <p class="caption iceberg-def">${esc(meta.def)}</p>
    ${current ? `
      <div class="iceberg-quote">
        <span class="caption" style="color:var(--textDim)">${esc(current.title)} — this layer:</span>
        <p ${activeLayer === "myth" ? 'style="font-style:italic"' : ""}>${esc(text)}</p>
      </div>
      <a class="caption" href="/scenario?id=${current.id}">Descend through this scenario in full →</a>` : ""}`;
  document.querySelectorAll(".iceband").forEach((b) =>
    b.classList.toggle("active", b.dataset.layer === activeLayer));
}

async function boot() {
  try {
    const j = await api("/api/scenarios?status=published");
    scenarios = j.scenarios;
    $("icebergScenario").innerHTML =
      scenarios.map((s, i) => `<option value="${s.id}" ${i === 0 ? "selected" : ""}>${esc(s.title)} (${esc(s.archetype)})</option>`).join("") ||
      `<option value="">— definitions only —</option>`;
    current = scenarios[0] || null;
  } catch {
    $("icebergScenario").innerHTML = `<option value="">— definitions only —</option>`;
  }
  renderPanel();
  $("icebergScenario").addEventListener("change", (e) => {
    current = scenarios.find((s) => s.id === +e.target.value) || null;
    renderPanel();
  });
  $("icebergSvg").addEventListener("click", (e) => {
    const band = e.target.closest(".iceband");
    if (!band) return;
    activeLayer = band.dataset.layer;
    renderPanel();
  });
}

boot();
