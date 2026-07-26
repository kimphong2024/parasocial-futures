// Audit log — every human change on the site, recorded with detail.
// One middleware covers all mutating /api routes (present and future):
// entity-shaped paths get a before/after field diff; every entry carries
// a readable action name, a one-line summary, the request body, the
// caller's address and the response status.
import * as d from "./db.js";

// noise fields never worth diffing
const SKIP_FIELDS = new Set(["raw_json", "detail_json", "params_json_full", "updated_at", "reviewed_at", "note_updated_at", "horizon_judged_at", "published_at"]);
const CAP = 200;

const trunc = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > CAP ? s.slice(0, CAP) + "…" : s;
};

// entity path shapes → getter + label + name field
const ENTITIES = [
  { re: /^\/api\/(?:review\/)?signals\/(\d+)/, entity: "signal", get: (id) => d.getSignal.get(id), name: (r) => r.title },
  { re: /^\/api\/triangle\/signals\/(\d+)/, entity: "signal", get: (id) => d.getSignal.get(id), name: (r) => r.title },
  { re: /^\/api\/scenarios\/(\d+)/, entity: "scenario", get: (id) => d.getScenario.get(id), name: (r) => r.title },
  { re: /^\/api\/drivers\/(\d+)/, entity: "driver", get: (id) => d.getDriver.get(id), name: (r) => r.name || r.key },
  { re: /^\/api\/sources\/(\d+)/, entity: "source", get: (id) => d.getSource.get(id), name: (r) => r.url },
  { re: /^\/api\/themes\/(\d+)/, entity: "theme", get: (id) => d.getTheme.get(id), name: (r) => r.name },
  { re: /^\/api\/scan\/runs\/(\d+)/, entity: "scan_run", get: (id) => d.getScanRun?.get?.(id), name: (r) => `run ${r.id}` },
];

// method+path → readable action
const ACTIONS = [
  [/^PATCH \/api\/signals\/\d+\/note$/, "signal.note"],
  [/^POST \/api\/review\/approve-all$/, "review.approve-all"],
  [/^POST \/api\/review\/signals\/\d+\/approve$/, "review.approve"],
  [/^POST \/api\/review\/signals\/\d+\/reject$/, "review.reject"],
  [/^PATCH \/api\/review\/signals\/\d+$/, "review.edit"],
  [/^POST \/api\/horizons\/judge$/, "horizons.judge"],
  [/^POST \/api\/triangle\/classify$/, "triangle.classify-all"],
  [/^PATCH \/api\/triangle\/signals\/\d+$/, "triangle.reclassify"],
  [/^POST \/api\/triangle\/writeup$/, "triangle.writeup"],
  [/^POST \/api\/scan\/run$/, "scan.trigger"],
  [/^DELETE \/api\/scan\/runs\/\d+$/, "scan.run-delete"],
  [/^POST \/api\/sources$/, "source.add"],
  [/^PATCH \/api\/sources\/\d+$/, "source.edit"],
  [/^DELETE \/api\/sources\/\d+$/, "source.delete"],
  [/^POST \/api\/themes$/, "theme.add"],
  [/^PATCH \/api\/themes\/\d+$/, "theme.edit"],
  [/^DELETE \/api\/themes\/\d+$/, "theme.delete"],
  [/^PUT \/api\/scan\/settings$/, "scan.settings"],
  [/^POST \/api\/scenarios\/draft$/, "scenario.draft"],
  [/^PATCH \/api\/scenarios\/\d+$/, "scenario.edit"],
  [/^POST \/api\/scenarios\/\d+\/publish$/, "scenario.publish"],
  [/^POST \/api\/scenarios\/\d+\/archive$/, "scenario.archive"],
  [/^POST \/api\/scenarios\/\d+\/restore$/, "scenario.restore"],
  [/^POST \/api\/drivers$/, "driver.add"],
  [/^PATCH \/api\/drivers\/\d+$/, "driver.edit"],
  [/^DELETE \/api\/drivers\/\d+$/, "driver.delete"],
  [/^POST \/api\/simulation\/run$/, "simulation.run"],
];

function diffRows(before, after) {
  if (!before || !after) return null;
  const out = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (SKIP_FIELDS.has(k)) continue;
    const a = before[k], b2 = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b2)) out[k] = { from: trunc(a), to: trunc(b2) };
  }
  return Object.keys(out).length ? out : null;
}

export function auditMiddleware(req, res, next) {
  if (req.method === "GET" || !req.path.startsWith("/api/") || req.path === "/api/chat") return next();

  const key = `${req.method} ${req.path}`;
  const action = ACTIONS.find(([re]) => re.test(key))?.[1] || "api.write";
  const shape = ENTITIES.find((e) => e.re.test(req.path));
  const entityId = shape ? Number(req.path.match(shape.re)[1]) : null;
  let before = null;
  try { before = shape ? shape.get(entityId) || null : null; } catch { /* snapshot best-effort */ }

  const json = res.json.bind(res);
  res.json = (payload) => {
    try {
      let after = null;
      try { after = shape ? shape.get(entityId) || null : null; } catch { /* best-effort */ }
      const diff = diffRows(before, after);
      const nameRow = after || before;
      const name = shape && nameRow ? trunc(String(shape.name(nameRow) || "")).slice(0, 60) : null;
      const ok = res.statusCode < 400;
      let summary;
      if (!ok) summary = `${action} failed (${res.statusCode})`;
      else if (shape && name) summary = `${shape.entity} ${entityId} “${name}” — ${action}${diff ? ": " + Object.keys(diff).join(", ") + " changed" : ""}`;
      else summary = action.replace(".", " ");
      const detail = {};
      if (req.body && Object.keys(req.body).length) detail.body = trunc(JSON.stringify(req.body));
      if (diff) detail.diff = diff;
      d.insertAudit.run(d.now(), req.method, req.path, action, shape?.entity || null, entityId, summary, JSON.stringify(detail), req.ip || null, res.statusCode);
      d.pruneAudit.run();
    } catch (e) {
      console.warn("[audit] failed to record:", e.message);
    }
    return json(payload);
  };
  next();
}
