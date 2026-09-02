// Hand-rolled SVG charts in the house palette. Marks follow the dataviz rules:
// thin bars with rounded data-ends anchored to the baseline, 2px surface gaps,
// direct labels in text ink (never series color), recessive axes, native
// <title> tooltips on every mark.
import { esc } from "./api.js";

// Colors resolve from CSS custom properties so the same chart code renders
// correctly on the light theme and the dark app theme (app-dark.css).
const cssVar = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim() || fb;

export const ARCH_COLOR = {
  growth: cssVar("--arch-growth", "#D3963E"),
  collapse: cssVar("--arch-collapse", "#C44536"),
  discipline: cssVar("--arch-discipline", "#5B8A9A"),
  transformation: cssVar("--arch-transformation", "#4E5A2B"),
};

const INK = cssVar("--chart-ink", "#282E2A"),
  MID = cssVar("--chart-mid", "#6B7264"),
  DIM = cssVar("--chart-dim", "#9A9A8A"),
  GRID = cssVar("--chart-grid", "#EDEEE8"),
  SERIES = cssVar("--chart-series", "#4E5A2B");
const pct = (x) => (x * 100).toFixed(1) + "%";

// Direct-labeled magnitude bar. Was private to dashboard.js; shared now that
// the report draws the same library composition.
export function hbar(label, n, max, { cls = "", title = "", data = "" } = {}) {
  const w = Math.max(0.6, (n / max) * 100);
  return `<div class="hbar ${cls}" ${data} title="${esc(title || `${label} — ${n} signals`)}">
    <span class="hbar-label">${esc(label)}</span>
    <span class="hbar-track"><span class="hbar-fill" style="width:${w.toFixed(1)}%"></span></span>
    <span class="hbar-value">${n}</span>
  </div>`;
}

// One proportional bar split into named segments — for showing the shape of a
// facet (horizons, urgencies, types) at a glance rather than as a sentence.
// parts = [{label, n, color}]. Segments below 7% drop their inline label and
// keep it in the legend, so narrow slivers never overlap.
// Label ink is chosen per segment by relative luminance, not fixed to white.
// Measured across the horizon and urgency ramps, this keeps every inline
// label between 4.6:1 and 9.9:1; a fixed white label failed on five of the
// seven segment colours.
const relLum = (hex) => {
  const h = hex.replace("#", "");
  const v = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const labelInk = (bg) => (relLum(bg) < 0.18 ? "#FFFEF9" : "#131309");

export function segmentBar(parts, { total } = {}) {
  const sum = total || parts.reduce((a, p) => a + p.n, 0) || 1;
  const seg = parts.map((p) => {
    const share = p.n / sum;
    return `<span class="segbar-part" style="flex:${share};background:${p.color};color:${labelInk(p.color)}" title="${esc(p.label)} — ${p.n} (${(share * 100).toFixed(0)}%)">
      ${share >= 0.07 ? `<span class="segbar-inline">${(share * 100).toFixed(0)}%</span>` : ""}
    </span>`;
  }).join("");
  const key = parts.map((p) =>
    `<span class="segbar-key"><i style="background:${p.color}"></i>${esc(p.label)} <b>${p.n}</b></span>`).join("");
  return `<div class="segbar"><div class="segbar-track">${seg}</div><div class="segbar-legend">${key}</div></div>`;
}

// Horizontal probability bars: items = [{label, sublabel, value (0..1), color}]
export function probabilityBars(el, items) {
  const W = 720, ROW = 44, LAB = 230, PAD = 8;
  const H = items.length * ROW + 24;
  const plotW = W - LAB - 70;
  const max = Math.max(0.0001, ...items.map((i) => i.value));
  const scale = (v) => (v / Math.max(max, 0.5)) * plotW;
  const gridLines = [0.25, 0.5].filter((g) => g <= Math.max(max, 0.5));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Scenario probabilities">
    ${gridLines.map((g) => `<line x1="${LAB + scale(g)}" y1="4" x2="${LAB + scale(g)}" y2="${H - 20}" stroke="${GRID}" stroke-width="1"/>
      <text x="${LAB + scale(g)}" y="${H - 6}" font-size="10" fill="${DIM}" text-anchor="middle">${g * 100}%</text>`).join("")}
    ${items.map((it, i) => {
      const y = i * ROW + PAD, bh = ROW - PAD - 10, w = Math.max(2, scale(it.value));
      return `<g>
        <title>${esc(it.label)}: ${pct(it.value)}</title>
        <text x="${LAB - 12}" y="${y + bh / 2 + 1}" font-size="12.5" font-weight="600" fill="${INK}" text-anchor="end" dominant-baseline="middle">${esc(it.label)}</text>
        <text x="${LAB - 12}" y="${y + bh / 2 + 15}" font-size="9.5" fill="${DIM}" text-anchor="end" dominant-baseline="middle">${esc(it.sublabel || "")}</text>
        <path d="M${LAB},${y} h${w - 4} a4,4 0 0 1 4,4 v${bh - 8} a4,4 0 0 1 -4,4 h${4 - w} z" fill="${it.color}"/>
        <text x="${LAB + w + 8}" y="${y + bh / 2 + 1}" font-size="12" font-weight="700" fill="${MID}" dominant-baseline="middle">${pct(it.value)}</text>
      </g>`;
    }).join("")}
  </svg>`;
}

// Tornado: rows = [{name, low, high, delta}] — diverging bars around 0 delta.
// Cool = probability falls with the driver, warm = rises.
export function tornado(el, rows) {
  const W = 720, ROW = 36, LAB = 230;
  const H = rows.length * ROW + 30;
  const plotW = W - LAB - 80;
  const maxAbs = Math.max(0.0001, ...rows.map((r) => Math.abs(r.delta)));
  const mid = LAB + plotW / 2;
  const scale = (v) => (v / maxAbs) * (plotW / 2);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Driver sensitivity">
    <line x1="${mid}" y1="4" x2="${mid}" y2="${H - 22}" stroke="${GRID}" stroke-width="1.5"/>
    <text x="${mid}" y="${H - 6}" font-size="10" fill="${DIM}" text-anchor="middle">no effect</text>
    ${rows.map((r, i) => {
      const y = i * ROW + 6, bh = ROW - 14;
      const w = Math.max(2, Math.abs(scale(r.delta)));
      const rising = r.delta >= 0;
      const x = rising ? mid : mid - w;
      const color = rising ? ARCH_COLOR.growth : ARCH_COLOR.discipline;
      const end = rising
        ? `M${x},${y} h${w - 4} a4,4 0 0 1 4,4 v${bh - 8} a4,4 0 0 1 -4,4 h${4 - w} z`
        : `M${x + w},${y} h${4 - w} a4,4 0 0 0 -4,4 v${bh - 8} a4,4 0 0 0 4,4 h${w - 4} z`;
      return `<g>
        <title>${esc(r.name)}: P moves from ${pct(r.low)} (low tercile) to ${pct(r.high)} (high tercile), delta ${r.delta >= 0 ? "+" : ""}${pct(r.delta)}</title>
        <text x="${LAB - 12}" y="${y + bh / 2 + 1}" font-size="12" fill="${INK}" text-anchor="end" dominant-baseline="middle">${esc(r.name)}</text>
        <path d="${end}" fill="${color}"/>
        <text x="${rising ? mid + w + 8 : mid - w - 8}" y="${y + bh / 2 + 1}" font-size="11" font-weight="700" fill="${MID}" text-anchor="${rising ? "start" : "end"}" dominant-baseline="middle">${r.delta >= 0 ? "+" : ""}${pct(r.delta)}</text>
      </g>`;
    }).join("")}
  </svg>`;
}

// Small density preview from 24 histogram bins. Single series → single hue.
export function densityPreview(el, bins, { unit = "" } = {}) {
  const W = 320, H = 90, PADB = 18;
  const maxC = Math.max(1, ...bins.map((b) => b.count));
  const bw = W / bins.length;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Distribution preview">
    ${bins.map((b, i) => {
      const h = Math.max(1, (b.count / maxC) * (H - PADB - 6));
      const y = H - PADB - h;
      return `<g><title>${b.x0} to ${b.x1}${unit ? " " + unit : ""}: ${b.count}</title>
        <rect x="${i * bw + 1}" y="${y}" width="${bw - 2}" height="${h}" rx="2" fill="${SERIES}" opacity="0.85"/></g>`;
    }).join("")}
    <line x1="0" y1="${H - PADB}" x2="${W}" y2="${H - PADB}" stroke="${GRID}" stroke-width="1"/>
    <text x="2" y="${H - 5}" font-size="9" fill="${DIM}">${bins[0]?.x0 ?? ""}</text>
    <text x="${W - 2}" y="${H - 5}" font-size="9" fill="${DIM}" text-anchor="end">${bins[bins.length - 1]?.x1 ?? ""}</text>
  </svg>`;
}
