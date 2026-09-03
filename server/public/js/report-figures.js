// Figures for the report.
//
// The report was arguing entirely in prose about quantities the platform
// already holds — cluster composition, the triangle's balance, how the four
// scenarios divide the space. Each figure here renders the number the
// neighbouring paragraph is talking about, from the live endpoint rather than
// from the model's sentence, so the picture cannot drift from the platform.

import { esc } from "./api.js";
import { hbar, segmentBar, ARCH_COLOR } from "./charts.js";

// The triangle page's own encoding, reused verbatim so the report reads as
// the same instrument rather than a second opinion (js/triangle.js:10-18).
const TRI = {
  pull:   { name: "Pull of the future",  color: "#E1B83B", dir: [0, -1] },
  push:   { name: "Push of the present", color: "#4E5A2B", dir: [-Math.sin(Math.PI / 3), 0.5] },
  weight: { name: "Weight of history",   color: "#AC7222", dir: [Math.sin(Math.PI / 3), 0.5] },
};
const CORNERS = ["pull", "push", "weight"];

const HORIZON_COLOR = { H1: "#4E5A2B", H2: "#AC7222", H3: "#E1B83B" };
const URGENCY_COLOR = { critical: "#A03325", high: "#C4713B", medium: "#AC9A4A", low: "#8E9A7B" };

// ---------------- the library's shape ----------------

export function evidenceFigure({ facets, overview }) {
  if (!facets || !overview) return "";
  const clusters = overview.clusters || [];
  const top = clusters.slice(0, 10);
  const tail = clusters.slice(10);
  const tailN = tail.reduce((a, c) => a + c.n, 0);
  const max = Math.max(...clusters.map((c) => c.n), 1);

  const horizons = ["H1", "H2", "H3"]
    .map((h) => ({ label: h, n: (facets.horizon.find((x) => x.v === h) || {}).n || 0, color: HORIZON_COLOR[h] }))
    .filter((p) => p.n);
  const urgencies = ["critical", "high", "medium", "low"]
    .map((u) => ({ label: u, n: (facets.urgency.find((x) => x.v === u) || {}).n || 0, color: URGENCY_COLOR[u] }))
    .filter((p) => p.n);

  return `
  <figure class="report-figure fig-evidence">
    <div class="fig-head">
      <h4>What the library is made of</h4>
      <p class="fig-sub">${overview.total} human-approved signals · ${clusters.length} clusters · ${overview.sources.distinct} distinct sources</p>
    </div>
    <div class="fig-split">
      <div>
        <p class="fig-label">Largest clusters</p>
        <div class="hbar-chart">${top.map((c) => hbar(c.v, c.n, max)).join("")}</div>
        ${tail.length ? `<p class="caption hbar-note">…plus ${tailN} signals across ${tail.length} smaller clusters.</p>` : ""}
      </div>
      <div class="fig-strips">
        <div>
          <p class="fig-label">Time horizon</p>
          ${segmentBar(horizons)}
          <p class="caption">H1 already unfolding before 2030 · H2 needs named developments · H3 stacked slow preconditions.</p>
        </div>
        <div>
          <p class="fig-label">Urgency</p>
          ${segmentBar(urgencies)}
        </div>
      </div>
    </div>
  </figure>`;
}

// ---------------- the triangle's balance ----------------

// An equilateral triangle with each corner weighted by its signal count, and
// a marker at the weighted centroid. The marker is the honest part: it shows
// which force the library currently leans toward, and how far, rather than
// asking the reader to compare three numbers in a sentence.
export function triangleFigure(counts) {
  if (!counts) return "";
  const total = CORNERS.reduce((a, c) => a + (counts[c] || 0), 0);
  if (!total) return "";

  // Geometry is sized from the largest possible disc (16 + 30) plus two lines
  // of label, so the apex count can never clip the top of the viewBox — it did
  // at CY 208, which swallowed the top of the digits.
  const MAX_DISC = 46, LABEL_STACK = 46;
  const W = 460, R = 140, CX = W / 2;
  const CY = R + MAX_DISC + LABEL_STACK + 4;                 // apex clears the top
  const H = CY + R * 0.5 + MAX_DISC + LABEL_STACK + 8;       // base clears the bottom
  const pt = (c) => [CX + TRI[c].dir[0] * R, CY + TRI[c].dir[1] * R];
  const verts = Object.fromEntries(CORNERS.map((c) => [c, pt(c)]));
  const poly = CORNERS.map((c) => verts[c].join(",")).join(" ");

  // Weighted centroid — where the balance of evidence actually sits.
  const cx = CORNERS.reduce((a, c) => a + verts[c][0] * (counts[c] / total), 0);
  const cy = CORNERS.reduce((a, c) => a + verts[c][1] * (counts[c] / total), 0);

  const maxN = Math.max(...CORNERS.map((c) => counts[c]));
  const disc = (n) => 16 + 30 * Math.sqrt(n / maxN);

  const dominant = CORNERS.reduce((a, c) => (counts[c] > counts[a] ? c : a), CORNERS[0]);

  return `
  <figure class="report-figure fig-triangle">
    <div class="fig-head">
      <h4>Where the balance sits</h4>
      <p class="fig-sub">${total} classified signals · the marker is the weighted centre of the evidence</p>
    </div>
    <div class="fig-triangle-body">
      <svg viewBox="0 0 ${W} ${H}" role="img"
           aria-label="Futures triangle. ${CORNERS.map((c) => `${TRI[c].name}: ${counts[c]} signals`).join(". ")}. The weighted centre leans toward ${TRI[dominant].name}.">
        <polygon points="${poly}" fill="none" stroke="var(--creamLine, #E2DBC2)" stroke-width="1.5"/>
        ${CORNERS.map((c) => `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${verts[c][0].toFixed(1)}" y2="${verts[c][1].toFixed(1)}"
             stroke="${TRI[c].color}" stroke-width="1" opacity="0.35"/>`).join("")}
        ${CORNERS.map((c) => {
          const [x, y] = verts[c], r = disc(counts[c]);
          const below = TRI[c].dir[1] > 0;
          return `<g>
            <circle cx="${x}" cy="${y}" r="${r}" fill="${TRI[c].color}" opacity="0.16"/>
            <circle cx="${x}" cy="${y}" r="4" fill="${TRI[c].color}"/>
            <text x="${x}" y="${y + (below ? r + 26 : -r - 24)}" text-anchor="middle"
                  class="tri-fig-n" fill="var(--ink,#131309)">${counts[c]}</text>
            <text x="${x}" y="${y + (below ? r + 43 : -r - 7)}" text-anchor="middle"
                  class="tri-fig-name" fill="var(--chart-mid,#6B6852)">${esc(TRI[c].name)}</text>
          </g>`;
        }).join("")}
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="none" stroke="var(--ink,#131309)" stroke-width="1.5"/>
        <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3" fill="var(--ink,#131309)"/>
      </svg>
      <p class="fig-read">The centre of gravity pulls toward <strong>${esc(TRI[dominant].name.toLowerCase())}</strong> —
        ${counts[dominant]} of ${total} classified signals. A triangle in balance would put the marker dead centre;
        this one does not, and that asymmetry is the finding.</p>
    </div>
  </figure>`;
}


// ---------------- the triangle, handed to the fork ----------------

// The triangle section used to stop, and the scenarios used to start, with
// nothing between them. This is the join, and it is derived rather than
// asserted: each scenario's own cited signals are looked up in the triangle
// classification, so the bar shows which force that scenario actually rests
// on rather than a tidy mapping of corners onto archetypes.
export function triangleBridge(mix) {
  if (!mix || !mix.length) return "";
  const rows = mix.filter((m) => m.classified > 0);
  if (!rows.length) return "";
  return `
  <figure class="report-figure fig-bridge">
    <div class="fig-head">
      <h4>Which force each scenario rests on</h4>
      <p class="fig-sub">every scenario's own citations, looked up in the triangle classification</p>
    </div>
    <ul class="bridge-list">
      ${rows.map((m) => {
        const parts = CORNERS.map((c) => ({ label: TRI[c].name.split(" ")[0], n: m.mix[c], color: TRI[c].color }));
        const lead = CORNERS.reduce((a, c) => (m.mix[c] > m.mix[a] ? c : a), CORNERS[0]);
        return `<li class="bridge-row">
          <div class="bridge-id">
            <span class="bridge-arch" style="--sc:${ARCH_COLOR[m.archetype] || "#6B7264"}">${esc(m.archetype)}</span>
            <h5>${esc(m.title)}</h5>
          </div>
          <div class="bridge-bar">${segmentBar(parts, { total: m.classified })}</div>
          <p class="bridge-read">rests on <strong>${esc(TRI[lead].name.toLowerCase())}</strong> · ${m.classified} of ${m.cited} citations classified</p>
        </li>`;
      }).join("")}
    </ul>
  </figure>`;
}

// ---------------- how the four scenarios divide the space ----------------

// Each scenario as a block rather than a row: the myth line alone was a label,
// not a scenario. Summary carries what it is, the four CLA layers carry how it
// is structured — litany, systemic, worldview, myth — which is the method the
// scenario set is actually built on and was invisible on this page.
const CLA = [
  ["litany", "Litany", "the visible 2040 surface"],
  ["systemic", "Systemic", "the causes underneath"],
  ["worldview", "Worldview", "the beliefs that hold it up"],
  ["myth", "Myth", "the story it tells itself"],
];

export function scenarioLedger(scenarios, sim, slot = () => "") {
  if (!scenarios || !scenarios.length) return "";
  const prob = Object.fromEntries((sim?.scenarios || []).map((s) => [s.slug, s.probability]));
  const maxP = Math.max(...Object.values(prob), sim?.residual || 0, 0.01);

  const block = (s) => {
    const p = prob[s.slug];
    return `<article class="sc-block" style="--sc:${ARCH_COLOR[s.archetype] || "#6B7264"}" aria-label="${esc(s.title)}">
      <header class="sc-top">
        <div class="sc-id">
          <span class="sc-arch">${esc(s.archetype)}</span>
          <h5>${esc(s.title)}</h5>
        </div>
        <div class="sc-prob">
          ${p != null ? `<span class="sc-bar"><span style="width:${(p / maxP * 100).toFixed(1)}%"></span></span>
          <span class="sc-pct">${(p * 100).toFixed(1)}%</span>` : `<span class="sc-pct sc-none">—</span>`}
        </div>
      </header>
      ${slot(s)}
      ${s.summary ? `<p class="sc-summary">${esc(s.summary)}</p>` : ""}
      ${CLA.some(([k]) => s[k]) ? `
      <details class="cla-wrap" open>
        <summary>Causal Layered Analysis — litany, systemic, worldview, myth</summary>
        <dl class="cla">
          ${CLA.filter(([k]) => s[k]).map(([k, label, gloss]) => `
            <dt><span class="cla-label">${label}</span><span class="cla-gloss">${gloss}</span></dt>
            <dd>${esc(s[k])}</dd>`).join("")}
        </dl>
      </details>` : ""}
    </article>`;
  };

  const res = sim?.residual;
  return `
  <figure class="report-figure fig-scenarios">
    <div class="fig-head">
      <h4>The four archetypes, and what falls outside them</h4>
      <p class="fig-sub">Dator's archetypes, each structured with Causal Layered Analysis</p>
    </div>
    <div class="sc-rail-wrap">
      <div class="sc-rail" data-drag-scroll data-lenis-prevent role="region" aria-label="The four scenarios, side by side" tabindex="0">
        ${scenarios.map(block).join("")}
      </div>
      <div class="sc-rail-nav">
        <button type="button" class="sec-btn" data-rail="prev" aria-label="Previous scenario">←</button>
        <span class="sc-rail-dots">${scenarios.map((sc, i) =>
          `<button type="button" class="sc-dot" data-rail-to="${i}" aria-label="${esc(sc.title)}" title="${esc(sc.title)}"><i style="background:${ARCH_COLOR[sc.archetype] || "#6B7264"}"></i></button>`).join("")}</span>
        <button type="button" class="sec-btn" data-rail="next" aria-label="Next scenario">→</button>
      </div>
    </div>
    ${res != null ? `<div class="sc-residual-note">
      <span class="sc-arch" style="--sc:#8A8778">residual</span>
      <p><strong>${(res * 100).toFixed(1)}%</strong> of sampled futures match none of the four. Reported rather than hidden — it is the measure of what the archetypes do not cover.</p>
    </div>` : ""}
  </figure>`;
}