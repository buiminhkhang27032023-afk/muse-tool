"use strict";
/* URL prefix helpers for cPanel / Passenger mounts (e.g. MUSE_BASE=/muse).
 *
 * Passenger may strip the Application URL prefix before the request reaches Node,
 * or it may forward the full path. We support both:
 *   - Routes are registered at /login, /api/..., etc.
 *   - A middleware strips MUSE_BASE from the request URL when present.
 *   - Redirects, cookie Path, and HTML/JS links always use MUSE_BASE.
 */
const fs = require("fs");
const path = require("path");

function base() {
  let b = (process.env.MUSE_BASE || "").trim();
  if (!b || b === "/") return "";
  if (!b.startsWith("/")) b = "/" + b;
  return b.replace(/\/+$/, "");
}

function pref(p) {
  if (p == null || p === "") p = "/";
  if (!String(p).startsWith("/")) p = "/" + p;
  // Avoid double-prefixing when caller already passed /muse/...
  const b = base();
  if (b && (p === b || p.startsWith(b + "/"))) return p;
  return b + p;
}

function publicOrigin(req) {
  const proto = (req.protocol || "http").replace(/:$/, "");
  const host = req.get("host") || "localhost";
  return proto + "://" + host + base();
}

/** Express middleware: strip MUSE_BASE from req.url when the proxy did not.
 *
 * express-session refuses to READ a cookie whose Path does not prefix the
 * request's originalUrl. When Passenger already stripped /muse, originalUrl is
 * "/login" etc. — synthesize originalUrl under MUSE_BASE so Path=/muse cookies
 * still load, while routes stay registered at "/login".
 */
function stripBaseMiddleware(req, res, next) {
  const b = base();
  if (!b) return next();
  const raw = req.url || "/";
  if (raw === b || raw.startsWith(b + "/") || raw.startsWith(b + "?")) {
    req.url = raw.slice(b.length) || "/";
    if (!req.url.startsWith("/")) req.url = "/" + req.url;
  } else {
    // Passenger stripped the prefix before Node saw the request.
    const orig = req.originalUrl || raw;
    if (!orig.startsWith(b + "/") && orig !== b && !orig.startsWith(b + "?")) {
      req.originalUrl = b + (orig.startsWith("/") ? orig : "/" + orig);
    }
  }
  next();
}

/**
 * Render an HTML string for the mounted base.
 * Supports the light Jinja-like tags left in templates from the Python port:
 *   {{ (BASE or "")|tojson }}  {{ BASE }}  {{ token|tojson }}
 * Also injects window.__MUSE_BASE__ after <head> when missing.
 */
function renderHtml(html, extras) {
  const b = base();
  const token = extras && extras.token !== undefined ? extras.token : "";
  html = String(html)
    .replace(/\{\{\s*\(BASE or ""\)\|tojson\s*\}\}/g, JSON.stringify(b))
    .replace(/\{\{\s*BASE\s*\}\}/g, b)
    .replace(/\{\{\s*token\|tojson\s*\}\}/g, JSON.stringify(token));
  // lang.html references window.__MUSE_BASE__ without assigning it — always inject the assignment.
  if (!html.includes("window.__MUSE_BASE__=")) {
    const inject = "<script>window.__MUSE_BASE__=" + JSON.stringify(b) + ";</script>";
    const lower = html.toLowerCase();
    const idx = lower.indexOf("<head>");
    if (idx >= 0) {
      html = html.slice(0, idx + 6) + inject + html.slice(idx + 6);
    } else {
      html = inject + html;
    }
  }
  return html;
}

function sendHtmlFile(res, filePath, extras) {
  const html = fs.readFileSync(filePath, "utf-8");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderHtml(html, extras));
}

module.exports = {
  base,
  pref,
  publicOrigin,
  stripBaseMiddleware,
  renderHtml,
  sendHtmlFile,
};
