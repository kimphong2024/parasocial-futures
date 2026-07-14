// Single shared password → stateless HMAC-signed cookie (Apple Books pattern).
// Auth is OFF when APP_PASSWORD is unset (local dev).
import crypto from "node:crypto";

const PASSWORD = process.env.APP_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const PROD = process.env.NODE_ENV === "production";

const token = () => crypto.createHmac("sha256", SECRET).update("parasocial-futures-v1").digest("hex");
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";")
  .map((s) => s.trim().split("=")).filter((p) => p[0]).map((p) => [p[0], decodeURIComponent(p[1] || "")]));

export const authed = (req) => !PASSWORD || parseCookies(req).sid === token();

export function loginHandler(req, res) {
  if (!PASSWORD || req.body?.password === PASSWORD) {
    res.setHeader("Set-Cookie", `sid=${token()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000${PROD ? "; Secure" : ""}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Wrong password" });
}

const PUBLIC = (p) =>
  p === "/" || p === "/transparency" || p === "/favicon.svg" || p === "/login" || p === "/api/login" ||
  p === "/api/public/stats" || p === "/js/home.js" ||
  p.startsWith("/css/") || p.startsWith("/img/");

export function authMiddleware(req, res, next) {
  if (authed(req) || PUBLIC(req.path)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "auth required" });
  return res.redirect("/login");
}
