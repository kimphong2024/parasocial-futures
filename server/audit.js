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

// short value for inline prose
const brief = (v, n = 60) => {
  let x = v === null || v === undefined ? "—" : String(v);
  x = x.replace(/\s+/g, " ").trim();
  return x.length > n ? x.slice(0, n) + "…" : x;
};
const FORCE = { pull: "Pull of the future", push: "Push of the present", weight: "Weight of history" };
const diffPhrase = (diff, max = 3) => {
  if (!diff) return "";
  const parts = Object.entries(diff).slice(0, max).map(([k, v]) => `${k}: “${brief(v.from, 40)}” → “${brief(v.to, 40)}”`);
  const extra = Object.keys(diff).length - max;
  return parts.join("; ") + (extra > 0 ? `; and ${extra} more field${extra > 1 ? "s" : ""}` : "");
};

// descriptive one-line summaries per action
function describe(action, { entityId, name, before, after, diff, body }) {
  const sig = name ? `signal ${entityId} “${name}”` : `signal ${entityId}`;
  switch (action) {
    case "signal.note": {
      const to = (after?.note || "").trim();
      const from = (before?.note || "").trim();
      if (!from && to) return `Added a field note to ${sig}: “${brief(to)}”`;
      if (from && !to) return `Cleared the field note on ${sig} (was: “${brief(from)}”)`;
      return `Edited the field note on ${sig} — now: “${brief(to)}”`;
    }
    case "triangle.reclassify": {
      const from = FORCE[before?.triangle] || before?.triangle || "unclassified";
      const to = FORCE[after?.triangle] || body?.triangle || "?";
      if (!diff) return `Left ${sig} where it was (${to}) — no change`;
      return `Moved ${sig} from ${from} to ${to} on the triangle board`;
    }
    case "review.approve": return `Approved pending ${sig} into the library`;
    case "review.reject": return `Rejected pending ${sig} from the review queue`;
    case "review.edit": return `Edited pending ${sig}${diff ? " — " + diffPhrase(diff) : ""}`;
    case "review.approve-all": return "Approved every pending scan hit into the library";
    case "horizons.judge": return "Started a full horizon audit over the approved library";
    case "triangle.classify-all": return "Started a triangle re-audit (re-judging classifications)";
    case "triangle.writeup": return "Requested a fresh triangle synthesis";
    case "scan.trigger": return "Triggered a manual scan run";
    case "scan.run-delete": return `Deleted scan run record ${entityId}`;
    case "source.add": return `Added scan source ${brief(body?.url || "", 80)}`;
    case "source.edit": {
      if (diff?.enabled) return `${after?.enabled ? "Enabled" : "Disabled"} scan source ${brief(name, 60)}`;
      return `Edited scan source ${brief(name, 60)}${diff ? " — " + diffPhrase(diff) : ""}`;
    }
    case "source.delete": return `Deleted scan source ${brief(name || body?.url || String(entityId), 60)}`;
    case "theme.add": return `Added sweep theme “${brief(body?.name || "", 50)}”`;
    case "theme.edit": {
      if (diff?.enabled) return `${after?.enabled ? "Enabled" : "Disabled"} sweep theme “${brief(name, 50)}”`;
      if (diff?.query) return `Rewrote the query of sweep theme “${brief(name, 50)}”`;
      return `Edited sweep theme “${brief(name, 50)}”${diff ? " — " + diffPhrase(diff) : ""}`;
    }
    case "theme.delete": return `Deleted sweep theme “${brief(name || String(entityId), 50)}”`;
    case "scan.settings": return `Changed scan settings — ${brief(JSON.stringify(body || {}), 140)}`;
    case "scenario.draft": return `Drafted a new scenario (${brief(body?.archetype || "archetype unset", 30)})`;
    case "scenario.edit": return `Edited scenario ${entityId} “${name}”${diff ? " — " + diffPhrase(diff) : ""}`;
    case "scenario.publish": return `Published scenario ${entityId} “${name}” — now live in simulation and chat`;
    case "scenario.archive": return `Archived scenario ${entityId} “${name}”`;
    case "scenario.restore": return `Restored scenario ${entityId} “${name}” from the archive`;
    case "driver.add": return `Added driver “${brief(body?.name || body?.key || "", 50)}”`;
    case "driver.edit": return `Edited driver “${name}”${diff ? " — " + diffPhrase(diff) : ""}`;
    case "driver.delete": return `Deleted driver “${name || entityId}”`;
    case "simulation.run": return `Ran a simulation${body?.n ? ` (${body.n} samples${body.seed ? ", seed " + body.seed : ""})` : ""}`;
    default: return null;
  }
}

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
      if (!ok) {
        summary = `Attempted ${action.replace(".", " ")}${shape && name ? ` on ${shape.entity} ${entityId} “${name}”` : ""} — failed with status ${res.statusCode}`;
      } else {
        summary = describe(action, { entityId, name, before, after, diff, body: req.body })
          || (shape && name
            ? `${shape.entity} ${entityId} “${name}” — ${action}${diff ? ": " + diffPhrase(diff) : ""}`
            : action.replace(".", " "));
      }
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
