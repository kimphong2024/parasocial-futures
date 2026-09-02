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

// ---------------- how the four scenarios divide the space ----------------

// Rows, not a card grid: the probability bar is the differentiator, and four
// equal boxes would flatten exactly the difference the section is about.
export function scenarioLedger(scenarios, sim) {
  if (!scenarios || !scenarios.length) return "";
  const prob = Object.fromEntries((sim?.scenarios || []).map((s) => [s.slug, s.probability]));
  const maxP = Math.max(...Object.values(prob), sim?.residual || 0, 0.01);

  const row = (s) => {
    const p = prob[s.slug];
    return `<li class="sc-row" style="--sc:${ARCH_COLOR[s.archetype] || "#6B7264"}">
      <div class="sc-id">
        <span class="sc-arch">${esc(s.archetype)}</span>
        <h5>${esc(s.title)}</h5>
      </div>
      <p class="sc-myth">${esc(s.myth || s.summary || "")}</p>
      <div class="sc-prob">
        ${p != null ? `<span class="sc-bar"><span style="width:${(p / maxP * 100).toFixed(1)}%"></span></span>
        <span class="sc-pct">${(p * 100).toFixed(1)}%</span>` : `<span class="sc-pct sc-none">—</span>`}
      </div>
    </li>`;
  };

  const res = sim?.residual;
  return `
  <figure class="report-figure fig-scenarios">
    <div class="fig-head">
      <h4>The four archetypes, and what falls outside them</h4>
      <p class="fig-sub">Dator's archetypes structured with Causal Layered Analysis — the line shown is each scenario's myth</p>
    </div>
    <ul class="sc-ledger">
      ${scenarios.map(row).join("")}
      ${res != null ? `<li class="sc-row sc-residual" style="--sc:#8A8778">
        <div class="sc-id"><span class="sc-arch">residual</span><h5>No scenario fits</h5></div>
        <p class="sc-myth">Sampled futures matching none of the four. Reported rather than hidden — it is the measure of what the archetypes do not cover.</p>
        <div class="sc-prob">
          <span class="sc-bar"><span style="width:${(res / maxP * 100).toFixed(1)}%"></span></span>
          <span class="sc-pct">${(res * 100).toFixed(1)}%</span>
        </div>
      </li>` : ""}
    </ul>
  </figure>`;
}
