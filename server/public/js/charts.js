// Hand-rolled SVG charts in the house palette. Marks follow the dataviz rules:
// thin bars with rounded data-ends anchored to the baseline, 2px surface gaps,
// direct labels in text ink (never series color), recessive axes, native
// <title> tooltips on every mark.
import { esc } from "./api.js";

// Colors resolve from CSS custom properties so the same chart code renders
// correctly on the light theme and the dark app theme (app-dark.css).
export const cssVar = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim() || fb;

export const ARCH_COLOR = {
  growth: cssVar("--arch-growth", "#D3963E"),
  collapse: cssVar("--arch-collapse", "#C44536"),
  discipline: cssVar("--arch-discipline", "#5B8A9A"),
  transformation: cssVar("--arch-transformation", "#4E5A2B"),
};

const INK = cssVar("--chart-ink", "#282E2A"),
  MID = cssVar("--chart-mid", "#656B5E"),
  DIM = cssVar("--chart-dim", "#6A6A5F"),
  GRID = cssVar("--chart-grid", "#EDEEE8"),
  SERIES = cssVar("--chart-series", "#4E5A2B");
const pct = (x) => (x * 100).toFixed(1) + "%";

// ---------------------------------------------------------------------------
// Chart text used to be drawn in viewBox units on a fixed 720-unit canvas that
// stretched to whatever the container was — about 1166px in the report, a 1.62x
// magnification. A 12.5-unit series label therefore rendered at 20px, the same
// size as a section heading, and a 37-character driver name needed 225 units
// against a 218-unit gutter, so it overflowed x=0 and was clipped.
//
// Charts now draw at the container's measured width, so one SVG unit is one CSS
// pixel and these sizes are the sizes you get. Label gutters are measured from
// the actual strings, and anything still too long is truncated with the full
// text kept in <title>.
// ---------------------------------------------------------------------------

const FONT = { label: 13, sub: 11, value: 13, axis: 11 };

let _mctx = null;
const measure = (text, size, weight = 400) => {
  if (!_mctx) _mctx = document.createElement("canvas").getContext("2d");
  const fam = getComputedStyle(document.body).fontFamily || "sans-serif";
  _mctx.font = `${weight} ${size}px ${fam}`;
  return _mctx.measureText(text).width;
};

function truncate(text, maxW, size, weight) {
  if (measure(text, size, weight) <= maxW) return text;
  let s = String(text);
  while (s.length > 1 && measure(s + "\u2026", size, weight) > maxW) s = s.slice(0, -1);
  return s.trim() + "\u2026";
}

// Gutter wide enough for the labels, capped so the plot keeps most of the width.
function gutterFor(labels, W, { size = FONT.label, weight = 600, pad = 14, cap = 0.4, min = 96 } = {}) {
  const widest = Math.max(0, ...labels.map((l) => measure(l, size, weight)));
  return Math.round(Math.max(min, Math.min(widest + pad, W * cap)));
}

// Draw at the container's real width, and redraw when that changes. One
// observer per element; repeated calls replace the draw function.
function responsive(el, draw) {
  el._draw = draw;
  const run = () => {
    const w = Math.max(260, Math.round(el.clientWidth || el.parentElement?.clientWidth || 640));
    if (w === el._cw) return;
    el._cw = w;
    el.innerHTML = el._draw(w);
  };
  el._cw = null;
  run();
  if (!el._ro && typeof ResizeObserver !== "undefined") {
    el._ro = new ResizeObserver(run);
    el._ro.observe(el);
  }
}

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
  responsive(el, (W) => {
    // On a phone the label gutter would leave the bars a sliver and the names
    // truncated to a stub; stack the label above its bar instead.
    const stacked = W < 420;
    const ROW = stacked ? 66 : 46, BAR = 22, TOP = stacked ? 34 : 8;
    const H = items.length * ROW + 26;
    // Reserve exactly what the value strings need, then give the label gutter
    // whatever is left over. Fixed reservations overflowed narrow screens.
    const VALW = Math.ceil(Math.max(...items.map((i) => measure(pct(i.value), FONT.value, 700)))) + 14;
    const MINPLOT = 56;
    let LAB = stacked ? 0 : gutterFor(items.map((i) => i.label), W);
    if (!stacked && LAB + VALW + MINPLOT > W) LAB = Math.max(56, W - VALW - MINPLOT);
    const plotW = Math.max(MINPLOT, W - LAB - VALW);
    const max = Math.max(0.0001, ...items.map((i) => i.value));
    const scale = (v) => (v / Math.max(max, 0.5)) * plotW;
    const grid = [0.25, 0.5].filter((g) => g <= Math.max(max, 0.5));
    const summary = items.map((i) => `${i.label} ${pct(i.value)}`).join(", ");
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Scenario probabilities: ${esc(summary)}">
      ${grid.map((g) => `<line x1="${LAB + scale(g)}" y1="4" x2="${LAB + scale(g)}" y2="${H - 22}" stroke="${GRID}" stroke-width="1"/>
        <text x="${LAB + scale(g)}" y="${H - 7}" font-size="${FONT.axis}" fill="${DIM}" text-anchor="middle">${g * 100}%</text>`).join("")}
      ${items.map((it, i) => {
        const y = i * ROW + TOP, w = Math.max(2, scale(it.value));
        const room = stacked ? W - 4 : LAB - 14;
        const label = truncate(it.label, room, FONT.label, 600);
        const sub = truncate(it.sublabel || "", room, FONT.sub, 400);
        const head = stacked
          ? `<text x="0" y="${i * ROW + 12}" font-size="${FONT.label}" font-weight="600" fill="${INK}" dominant-baseline="middle">${esc(label)}${sub ? `<tspan font-size="${FONT.sub}" font-weight="400" fill="${DIM}" dx="8">${esc(sub)}</tspan>` : ""}</text>`
          : `<text x="${LAB - 14}" y="${y + BAR / 2 - 3}" font-size="${FONT.label}" font-weight="600" fill="${INK}" text-anchor="end" dominant-baseline="middle">${esc(label)}</text>
          ${sub ? `<text x="${LAB - 14}" y="${y + BAR / 2 + 13}" font-size="${FONT.sub}" fill="${DIM}" text-anchor="end" dominant-baseline="middle">${esc(sub)}</text>` : ""}`;
        return `<g>
          <title>${esc(it.label)}${it.sublabel ? ` (${esc(it.sublabel)})` : ""}: ${pct(it.value)}</title>
          ${head}
          <path d="M${LAB},${y} h${w - 4} a4,4 0 0 1 4,4 v${BAR - 8} a4,4 0 0 1 -4,4 h${4 - w} z" fill="${it.color}"/>
          <text x="${LAB + w + 10}" y="${y + BAR / 2}" font-size="${FONT.value}" font-weight="700" fill="${MID}" dominant-baseline="middle">${pct(it.value)}</text>
        </g>`;
      }).join("")}
    </svg>`;
  });
}

// Tornado: rows = [{name, low, high, delta}] — diverging bars around 0 delta.
// Cool = probability falls with the driver, warm = rises.
export function tornado(el, rows) {
  responsive(el, (W) => {
    const stacked = W < 420;
    const ROW = stacked ? 56 : 38, BAR = 20, TOP = stacked ? 26 : 8;
    const H = rows.length * ROW + 30;
    const fmt = (d) => (d >= 0 ? "+" : "") + pct(d);
    const VALW = Math.ceil(Math.max(...rows.map((r) => measure(fmt(r.delta), FONT.value, 700)))) + 14;
    // Driver names are long; give them room but never more than 44% of the
    // chart, and truncate what still will not fit rather than letting it clip.
    // On a phone the name sits above its bar and the plot takes the width.
    const MINPLOT = 56;
    let LAB = stacked ? 0 : gutterFor(rows.map((r) => r.name), W, { weight: 400, cap: 0.44, min: 90 });
    const reserved = (rows.some((r) => r.delta < 0) ? VALW : 8) + (rows.some((r) => r.delta >= 0) ? VALW : 8);
    if (!stacked && LAB + reserved + MINPLOT > W) LAB = Math.max(48, W - reserved - MINPLOT);
    // The zero line sits where the data puts it, not at the midpoint. A
    // symmetric axis gave half the plot to a -1.5% worst case while +53.8%
    // fought for the other half. Both sides still share one px-per-point
    // scale, so bars stay directly comparable.
    const maxPos = Math.max(0, ...rows.map((r) => r.delta));
    const maxNeg = Math.max(0, ...rows.map((r) => -r.delta));
    const range = maxPos + maxNeg || 1;
    const x0 = LAB + (maxNeg > 0 ? VALW : 8);
    const x1 = W - (maxPos > 0 ? VALW : 8);
    const plotW = Math.max(MINPLOT, x1 - x0);
    const mid = x0 + plotW * (maxNeg / range);
    const scale = (v) => (v / range) * plotW;
    const summary = rows.map((r) => `${r.name} ${fmt(r.delta)}`).join(", ");
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Driver sensitivity: ${esc(summary)}">
      <line x1="${mid}" y1="4" x2="${mid}" y2="${H - 24}" stroke="${GRID}" stroke-width="1.5"/>
      <text x="${mid}" y="${H - 8}" font-size="${FONT.axis}" fill="${DIM}" text-anchor="middle">no effect</text>
      ${rows.map((r, i) => {
        const y = i * ROW + TOP;
        const w = Math.max(2, Math.abs(scale(r.delta)));
        const rising = r.delta >= 0;
        const x = rising ? mid : mid - w;
        const color = rising ? ARCH_COLOR.growth : ARCH_COLOR.discipline;
        const name = truncate(r.name, stacked ? W - 4 : LAB - 14, FONT.label, 400);
        const path = rising
          ? `M${x},${y} h${w - 4} a4,4 0 0 1 4,4 v${BAR - 8} a4,4 0 0 1 -4,4 h${4 - w} z`
          : `M${x + w},${y} h${4 - w} a4,4 0 0 0 -4,4 v${BAR - 8} a4,4 0 0 0 4,4 h${w - 4} z`;
        return `<g>
          <title>${esc(r.name)}: P moves from ${pct(r.low)} (low tercile) to ${pct(r.high)} (high tercile), delta ${r.delta >= 0 ? "+" : ""}${pct(r.delta)}</title>
          ${stacked
            ? `<text x="0" y="${i * ROW + 10}" font-size="${FONT.label}" fill="${INK}" dominant-baseline="middle">${esc(name)}</text>`
            : `<text x="${LAB - 14}" y="${y + BAR / 2}" font-size="${FONT.label}" fill="${INK}" text-anchor="end" dominant-baseline="middle">${esc(name)}</text>`}
          <path d="${path}" fill="${color}"/>
          <text x="${rising ? mid + w + 10 : mid - w - 10}" y="${y + BAR / 2}" font-size="${FONT.value}" font-weight="700" fill="${MID}" text-anchor="${rising ? "start" : "end"}" dominant-baseline="middle">${fmt(r.delta)}</text>
        </g>`;
      }).join("")}
    </svg>`;
  });
}

// Small density preview from 24 histogram bins. Single series → single hue.
export function densityPreview(el, bins, { unit = "" } = {}) {
  responsive(el, (W) => {
    const H = 90, PADB = 18;
    const maxC = Math.max(1, ...bins.map((b) => b.count));
    const bw = W / bins.length;
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Distribution preview">
      ${bins.map((b, i) => {
        const h = Math.max(1, (b.count / maxC) * (H - PADB - 6));
        const y = H - PADB - h;
        return `<g><title>${b.x0} to ${b.x1}${unit ? " " + unit : ""}: ${b.count}</title>
          <rect x="${i * bw + 1}" y="${y}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2" fill="${SERIES}" opacity="0.85"/></g>`;
      }).join("")}
      <line x1="0" y1="${H - PADB}" x2="${W}" y2="${H - PADB}" stroke="${GRID}" stroke-width="1"/>
      <text x="2" y="${H - 5}" font-size="${FONT.axis}" fill="${DIM}">${bins[0]?.x0 ?? ""}</text>
      <text x="${W - 2}" y="${H - 5}" font-size="${FONT.axis}" fill="${DIM}" text-anchor="end">${bins[bins.length - 1]?.x1 ?? ""}</text>
    </svg>`;
  });
}
