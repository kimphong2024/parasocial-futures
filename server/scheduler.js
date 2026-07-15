// In-process daily scheduler (Knowledge Hub pattern, ESM, in-process runScan).
// Railway volumes bind to one service, so web + cron share this process.
// OFF unless ENABLE_CRON=1 (Railway sets it; local stays off).
import { runScan } from "./scan.js";

const REFRESH_HOUR = parseInt(process.env.REFRESH_HOUR || "22", 10);
const REFRESH_TZ = process.env.REFRESH_TZ || "UTC";

let nextRun = null; // ISO timestamp of the next scheduled scan, null when cron is off
export const scheduleInfo = () => ({
  enabled: process.env.ENABLE_CRON === "1",
  hour: REFRESH_HOUR,
  tz: REFRESH_TZ,
  next_run_at: nextRun,
});

// Current hour/minute in the configured timezone (handles DST via Intl).
function nowParts() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: REFRESH_TZ, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hour = p.hour === "24" ? 0 : parseInt(p.hour, 10);
  return { hour, minute: parseInt(p.minute, 10), second: parseInt(p.second, 10) };
}

function msUntilNextRun() {
  const { hour, minute, second } = nowParts();
  const secsNow = hour * 3600 + minute * 60 + second;
  let delta = REFRESH_HOUR * 3600 - secsNow;
  if (delta <= 0) delta += 24 * 3600;
  return delta * 1000;
}

function scheduleNext() {
  const ms = msUntilNextRun();
  nextRun = new Date(Date.now() + ms).toISOString();
  console.log(`[scheduler] next scan in ${(ms / 3600000).toFixed(1)}h (${REFRESH_HOUR}:00 ${REFRESH_TZ})`);
  setTimeout(async () => {
    try {
      const run = await runScan("cron"); // runScan has its own re-entrancy guard
      console.log("[scheduler] scan finished:", run?.status ?? run?.reason);
    } catch (e) {
      console.error("[scheduler] scan failed:", e.message);
    }
    scheduleNext();
  }, ms);
}

export function startScheduler() {
  if (process.env.ENABLE_CRON !== "1") return false;
  console.log(`[scheduler] enabled — daily scan at ${REFRESH_HOUR}:00 ${REFRESH_TZ}`);
  scheduleNext();
  return true;
}
