"use strict";
/* Chế độ chạy trên tên miền: đăng nhập, mã cho cầu nối, và kho dữ liệu của làng (công vụ, nhật ký, tường hoa).
 *
 * Bật bằng biến môi trường MUSE_PUBLIC=1. Không bật thì chạy như cũ trên máy, không cần đăng nhập.
 *   MUSE_PASSWORD  mật khẩu đăng nhập Triều Đình (không đặt thì tự sinh lần đầu, lưu ở data/password.txt)
 *   MUSE_DATA      thư mục lưu dữ liệu (mặc định <gốc>/data)
 *   MUSE_HTTPS=1   khi chạy sau HTTPS (Caddy, Cloudflare...) để cookie đăng nhập chỉ đi qua HTTPS
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const session = require("express-session");

const HERE = path.dirname(path.dirname(__filename)); // gốc project node/
const PUBLIC = process.env.MUSE_PUBLIC === "1";
const DATA_DIR = process.env.MUSE_DATA || path.join(HERE, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const COLLECTIONS = ["cong_vu", "nhat_ky", "hoa_vien"];
const MAX_DOCS = 600;
const DB_FILE = path.join(DATA_DIR, "db.json");

function readOrMake(name, maker) {
  const p = path.join(DATA_DIR, name);
  try {
    const v = fs.readFileSync(p, "utf-8").trim();
    if (v) return v;
  } catch (_) { /* chưa có file */ }
  const v = maker();
  fs.writeFileSync(p, v, "utf-8");
  return v;
}

const SECRET = readOrMake("secret.key", () => crypto.randomBytes(32).toString("hex"));
const PASSWORD = process.env.MUSE_PASSWORD || readOrMake("password.txt", () => crypto.randomBytes(9).toString("base64url"));
const BRIDGE_TOKEN = crypto.createHash("sha256").update(PASSWORD + "|muse-bridge").digest("hex").slice(0, 32);

const LOGIN_HTML = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Đăng nhập Triều Đình</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#140d0a;color:#f3e6d6;font-family:system-ui,"Segoe UI",sans-serif}
form{width:min(360px,90vw);background:#241a14;border:1px solid #4a3a2c;border-radius:18px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{margin:0 0 4px;font-size:22px;color:#e0a43f}p{margin:0 0 18px;color:#b9a390;font-size:13px}
input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid #5a4636;background:#1b120e;color:inherit;font-size:15px}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:10px;background:#b3202c;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.e{color:#ff8a80;font-size:13px;margin-top:10px;min-height:16px}</style></head><body>
<form method="post"><h1>🐉 Triều Đình Rồng Tiên</h1><p>Nhập mật khẩu để vào.</p>
<input type="password" name="password" placeholder="Mật khẩu" autofocus required>
<input type="hidden" name="next" value="{{NEXT}}"><button>Vào triều</button><div class="e">{{ERR}}</div></form></body></html>`;

function safeNext(n) {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/";
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a), "utf-8");
  const bb = Buffer.from(String(b), "utf-8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function bridgeTokenForPage(req) {
  if (!PUBLIC) return "";
  return req.session && req.session.ok ? BRIDGE_TOKEN : "";
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch (_) {
    return {};
  }
}

function saveDb(d) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d), "utf-8");
  fs.renameSync(tmp, DB_FILE);
}

const dbLock = { busy: false, queue: [] };
function withDbLock(fn) {
  // dữ liệu nhỏ, đơn tiến trình: khóa đơn giản không cần async thật
  return fn();
}

function init(app) {
  app.use(session({
    secret: SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.MUSE_HTTPS === "1",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  }));

  if (PUBLIC) {
    app.set("trust proxy", 1);
  }

  app.use((req, res, next) => {
    if (!PUBLIC || req.method === "OPTIONS") return next();
    const p = req.path;
    if (p === "/login" || p === "/api/bridge-script" || p === "/favicon.ico") return next();
    const tok = req.headers["x-muse-token"] || "";
    if ((req.session && req.session.ok) || (tok && timingSafeEqualStr(tok, BRIDGE_TOKEN))) return next();
    if (p.startsWith("/api/")) return res.status(401).json({ error: "Cần đăng nhập" });
    return res.redirect("/login?next=" + encodeURIComponent(p));
  });

  app.all("/login", (req, res) => {
    const nxt = safeNext(req.query.next || (req.body && req.body.next) || "/");
    let err = "";
    if (req.method === "POST") {
      const pw = (req.body && req.body.password) || "";
      if (timingSafeEqualStr(pw, PASSWORD)) {
        req.session.ok = true;
        return res.redirect(nxt);
      }
      return setTimeout(() => {
        res.set("Content-Type", "text/html; charset=utf-8");
        res.send(LOGIN_HTML.replace("{{NEXT}}", nxt.replace(/"/g, "")).replace("{{ERR}}", "Sai mật khẩu."));
      }, 1500);
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(LOGIN_HTML.replace("{{NEXT}}", nxt.replace(/"/g, "")).replace("{{ERR}}", err));
  });

  app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });

  function col(name) {
    return COLLECTIONS.includes(name) ? name : null;
  }

  app.get("/api/db/:col", (req, res) => {
    if (!col(req.params.col)) return res.status(404).json({ error: "Không có bộ sưu tập này" });
    const docs = withDbLock(() => (loadDb()[req.params.col] || []).slice());
    docs.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    res.json(docs.slice(0, 300));
  });

  app.post("/api/db/:col", (req, res) => {
    if (!col(req.params.col)) return res.status(404).json({ error: "Không có bộ sưu tập này" });
    const body = req.body || {};
    const doc = {};
    for (const k of Object.keys(body)) doc[k] = body[k];
    doc.id = crypto.randomBytes(8).toString("hex");
    if (!doc.created_at) doc.created_at = new Date().toISOString().slice(0, 19);
    withDbLock(() => {
      const d = loadDb();
      const lst = d[req.params.col] || (d[req.params.col] = []);
      lst.push(doc);
      if (lst.length > MAX_DOCS) {
        lst.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
        lst.splice(0, lst.length - MAX_DOCS);
      }
      saveDb(d);
    });
    res.json(doc);
  });

  app.patch("/api/db/:col/:docId", handleChange);
  app.delete("/api/db/:col/:docId", handleChange);
  function handleChange(req, res) {
    if (!col(req.params.col)) return res.status(404).json({ error: "Không có bộ sưu tập này" });
    const found = withDbLock(() => {
      const d = loadDb();
      const lst = d[req.params.col] || [];
      for (let i = 0; i < lst.length; i++) {
        if (lst[i].id === req.params.docId) {
          if (req.method === "DELETE") {
            lst.splice(i, 1);
          } else {
            const body = req.body || {};
            for (const k of Object.keys(body)) if (k !== "id") lst[i][k] = body[k];
          }
          saveDb(d);
          return true;
        }
      }
      return false;
    });
    if (!found) return res.status(404).json({ error: "Không có tài liệu này" });
    res.json({ success: true });
  }
}

module.exports = { init, PUBLIC, DATA_DIR, PASSWORD, BRIDGE_TOKEN, bridgeTokenForPage };
