// Monte Carlo engine over the driver model. Pure JS, seeded, in-request
// (10k samples x ~7 drivers runs in single-digit milliseconds).
//
// Distributions: PERT (default — Beta scaled to [min,max] via lambda=4),
// triangular, uniform, discrete. Scenario membership = conjunction of
// conditions over sampled driver values. Sensitivity = tercile split:
// P(scenario | driver in top third) - P(scenario | driver in bottom third).

// mulberry32 — small seeded PRNG, good enough for simulation charts.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Marsaglia–Tsang gamma sampler (shape >= 0 handled via boost for shape < 1).
function gammaSample(rng, shape) {
  if (shape < 1) {
    const u = rng();
    return gammaSample(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // Box–Muller normal
      const u1 = rng() || 1e-12, u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function betaSample(rng, alpha, beta) {
  const x = gammaSample(rng, alpha);
  const y = gammaSample(rng, beta);
  return x / (x + y);
}

export function makeSampler(dist_type, params) {
  const p = typeof params === "string" ? JSON.parse(params) : params;
  switch (dist_type) {
    case "pert": {
      const { min, mode, max } = p;
      const range = max - min;
      if (range <= 0) return () => min;
      const lambda = p.lambda ?? 4;
      const alpha = 1 + lambda * (mode - min) / range;
      const beta = 1 + lambda * (max - mode) / range;
      return (rng) => min + range * betaSample(rng, alpha, beta);
    }
    case "triangular": {
      const { min, mode, max } = p;
      const range = max - min;
      if (range <= 0) return () => min;
      const fc = (mode - min) / range;
      return (rng) => {
        const u = rng();
        return u < fc
          ? min + Math.sqrt(u * range * (mode - min))
          : max - Math.sqrt((1 - u) * range * (max - mode));
      };
    }
    case "uniform": {
      const { min, max } = p;
      return (rng) => min + (max - min) * rng();
    }
    case "discrete": {
      const { values, probs } = p;
      const cum = [];
      let acc = 0;
      for (const pr of probs) { acc += pr; cum.push(acc); }
      return (rng) => {
        const u = rng() * acc;
        for (let i = 0; i < cum.length; i++) if (u <= cum[i]) return values[i];
        return values[values.length - 1];
      };
    }
    default:
      throw new Error("unknown dist_type " + dist_type);
  }
}

const matches = (conds, sample) =>
  conds.every((c) => {
    const v = sample[c.driver_key];
    if (v === undefined) return false;
    if (c.op === "lte") return v <= c.value;
    if (c.op === "gte") return v >= c.value;
    if (c.op === "between") return v >= c.lo && v <= c.hi;
    if (c.op === "in") return (c.values || []).includes(v);
    return false;
  });

function percentile(sorted, q) {
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// drivers: rows from the drivers table; scenarios: [{id, slug, title, archetype, conditions:[..]}]
export function simulate({ drivers, scenarios, n = 10000, seed = 42 }) {
  const t0 = performance.now();
  const rng = mulberry32(seed);
  const samplers = drivers.map((d) => ({ key: d.key, sample: makeSampler(d.dist_type, d.params_json) }));

  // Sample the driver space.
  const cols = Object.fromEntries(samplers.map((s) => [s.key, new Float64Array(n)]));
  const membership = scenarios.map(() => new Uint8Array(n));
  const sample = {};
  for (let i = 0; i < n; i++) {
    for (const s of samplers) { const v = s.sample(rng); cols[s.key][i] = v; sample[s.key] = v; }
    scenarios.forEach((sc, j) => { if (matches(sc.conditions, sample)) membership[j][i] = 1; });
  }

  // Scenario probabilities + residual (samples matching no scenario).
  const probs = membership.map((m) => {
    let c = 0;
    for (let i = 0; i < n; i++) c += m[i];
    return c / n;
  });
  let residualCount = 0;
  for (let i = 0; i < n; i++) {
    let any = 0;
    for (let j = 0; j < membership.length; j++) any |= membership[j][i];
    residualCount += 1 - any;
  }

  // Driver stats + histograms (24 bins).
  const driverStats = drivers.map((d) => {
    const col = cols[d.key];
    const sorted = Float64Array.from(col).sort();
    let mean = 0;
    for (let i = 0; i < n; i++) mean += col[i];
    mean /= n;
    const lo = sorted[0], hi = sorted[n - 1];
    const BINS = 24, width = (hi - lo) / BINS || 1;
    const counts = new Array(BINS).fill(0);
    for (let i = 0; i < n; i++) counts[Math.min(BINS - 1, Math.floor((col[i] - lo) / width))]++;
    return {
      key: d.key, name: d.name, unit: d.unit,
      mean: round(mean), p10: round(percentile(sorted, 0.1)), p50: round(percentile(sorted, 0.5)), p90: round(percentile(sorted, 0.9)),
      histogram: counts.map((count, b) => ({ x0: round(lo + b * width), x1: round(lo + (b + 1) * width), count })),
    };
  });

  // Tornado: tercile split per scenario x driver.
  const tornado = {};
  scenarios.forEach((sc, j) => {
    const rows = drivers.map((d) => {
      const col = cols[d.key];
      const sorted = Float64Array.from(col).sort();
      const t1 = sorted[Math.floor(n / 3)], t2 = sorted[Math.floor((2 * n) / 3)];
      let loHit = 0, loN = 0, hiHit = 0, hiN = 0;
      for (let i = 0; i < n; i++) {
        if (col[i] <= t1) { loN++; loHit += membership[j][i]; }
        else if (col[i] >= t2) { hiN++; hiHit += membership[j][i]; }
      }
      const low = loN ? loHit / loN : 0, high = hiN ? hiHit / hiN : 0;
      return { key: d.key, name: d.name, low: round(low), high: round(high), delta: round(high - low) };
    });
    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    tornado[sc.slug] = rows;
  });

  return {
    n, seed, duration_ms: Math.round(performance.now() - t0),
    scenarios: scenarios.map((sc, j) => ({ id: sc.id, slug: sc.slug, title: sc.title, archetype: sc.archetype, probability: round(probs[j]) })),
    residual: round(residualCount / n),
    drivers: driverStats,
    tornado,
  };
}

const round = (x) => Math.round(x * 10000) / 10000;

// Small preview used by the driver editor: sample 2000 points → 24 bins.
export function previewDistribution(dist_type, params, n = 2000) {
  const rng = mulberry32(7);
  const sampler = makeSampler(dist_type, params);
  const vals = new Float64Array(n);
  for (let i = 0; i < n; i++) vals[i] = sampler(rng);
  const sorted = Float64Array.from(vals).sort();
  const lo = sorted[0], hi = sorted[n - 1];
  const BINS = 24, width = (hi - lo) / BINS || 1;
  const counts = new Array(BINS).fill(0);
  for (let i = 0; i < n; i++) counts[Math.min(BINS - 1, Math.floor((vals[i] - lo) / width))]++;
  return counts.map((count, b) => ({ x0: round(lo + b * width), x1: round(lo + (b + 1) * width), count }));
}
