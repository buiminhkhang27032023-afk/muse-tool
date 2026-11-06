"use strict";
const fs = require("fs");
const path = require("path");
const express = require("express");
const net = require("net");

const court = require("./lib/court");
const access = require("./lib/access");
const arena = require("./lib/arena");
const jarvis = require("./lib/jarvis");
const { base, pref, publicOrigin, stripBaseMiddleware, sendHtmlFile, renderHtml } = require("./lib/prefix");

const ROOT = court.ROOT; // D:\tool muse (tài sản tĩnh dùng chung: templates, muse_bridge.js, lang.html, extension)
const HERE = court.HERE; // node/ (mã nguồn bản Node)

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true }));

// Support both: Passenger strips /muse, or forwards full /muse/... path.
app.use(stripBaseMiddleware);

// cầu nối và trang web hỏi server liên tục; lọc các dòng đó ra khỏi log, chỉ in việc quan trọng
const QUIET = ["/api/poll-pending", "/api/status", "/api/messages", "/api/court/runs", "/api/court/tabs", "/api/arena/", "/favicon.ico"];
app.use((req, res, next) => {
  const quiet = QUIET.some((q) => req.path.includes(q));
  if (!quiet) console.log(`${req.method} ${req.path}`);
  next();
});

access.init(app); // đăng nhập / chế độ công khai (phải gắn trước các route khác để canh cổng)

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Private-Network", "true");
  res.set("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// dán link kèm dấu chấm hoặc phẩy ở cuối (VD: /san-choi.) thì tự bỏ dấu đi
app.use((req, res, next) => {
  if (req.method === "GET" && req.path !== "/" && /[.,;:)]$/.test(req.path)) {
    const stripped = req.path.replace(/[.,;:)]+$/, "") || "/";
    return res.redirect(pref(stripped));
  }
  next();
});

let messages = [];
let pendingToMuse = [];
let lastBridgeHeartbeat = 0;

app.get("/", (req, res) => res.redirect(pref("/lang")));

app.get("/chat", (req, res) => sendHtmlFile(res, path.join(ROOT, "templates", "index.html")));

app.get("/api/status", (req, res) => {
  const isBridgeOnline = Date.now() / 1000 - lastBridgeHeartbeat < 5 || court.bridgeOnline();
  res.json({
    status: "ok",
    bridge_connected: isBridgeOnline,
    agents: court.onlineAgents(),
    tab_count: court.onlineTabCount(),
    labels: court.agentLabels(),
    message_count: messages.length,
  });
});

app.get("/api/messages", (req, res) => res.json(messages));

app.post("/api/clear", (req, res) => {
  messages = [];
  pendingToMuse = [];
  res.json({ success: true });
});

app.post("/api/send", (req, res) => {
  const data = req.body || {};
  const text = (data.text || "").trim();
  const sendText = (data.send_text || text).trim();
  if (!text) return res.status(400).json({ error: "Nội dung tin nhắn trống" });

  const msgId = "msg_" + Date.now();
  const userMsg = { id: msgId, role: "user", text, timestamp: Date.now() / 1000, status: "pending" };
  messages.push(userMsg);
  pendingToMuse.push({ id: msgId, text: sendText });
  res.json({ success: true, message: userMsg });
});

app.get("/api/poll-pending", (req, res) => {
  lastBridgeHeartbeat = Date.now() / 1000;
  const agent = req.query.agent || "*";
  const tabId = req.query.tab || null;
  const label = req.query.label || "";
  const provider = req.query.provider || "";
  const ct = court.takeTask(tabId, agent !== "*" ? agent : null, label, provider);
  if (ct) {
    return res.json({ has_task: true, task: { id: ct.id, text: ct.text, raw: Boolean(ct.raw) }, tab: court.tabInfo(tabId || "anon-" + agent) });
  }
  const tab = court.tabs.get(tabId || "anon-" + agent);
  // bất kỳ tab nào rảnh, chưa gán vai (Muse, Grok, ChatGPT, Gemini, Claude...) đều được nhận câu hỏi
  // của /chat và /jarvis — tab nào rảnh trước trả lời trước, không còn kẹt cứng vào mỗi Muse.
  const poolFree = Boolean(tab) && !tab.roles.length && !tab.busy && court.tabReady(tab);
  const info = court.tabInfo(tabId || "anon-" + agent);

  if (poolFree && pendingToMuse.length) {
    const task = pendingToMuse.shift();
    const m = messages.find((x) => x.id === task.id);
    if (m) m.status = "sent_to_web";
    return res.json({ has_task: true, task });
  }
  res.json({ has_task: false, tab: info });
});

app.post("/api/response", (req, res) => {
  lastBridgeHeartbeat = Date.now() / 1000;
  const data = req.body || {};
  const replyText = (data.text || "").trim();
  const promptId = data.prompt_id;
  const isFinal = data.is_final !== undefined ? data.is_final : true;

  if (!replyText || replyText === "More") return res.status(400).json({ error: "Invalid response" });

  if (court.onResponse(promptId, replyText, isFinal)) return res.json({ success: true, court: true });
  // onResponse now always persists to disk and returns true for valid ids; keep chat fallback below.

  let existing = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].reply_to === promptId) {
      existing = messages[i];
      break;
    }
  }
  if (existing) {
    existing.text = replyText;
    existing.is_final = isFinal;
    existing.timestamp = Date.now() / 1000;
  } else {
    messages.push({ id: "resp_" + Date.now(), role: "assistant", reply_to: promptId, text: replyText, is_final: isFinal, timestamp: Date.now() / 1000 });
  }
  res.json({ success: true });
});

app.get("/api/bridge-script", (req, res) => {
  const bridgePath = path.join(ROOT, "muse_bridge.js");
  if (fs.existsSync(bridgePath)) {
    res.set("Content-Type", "text/plain; charset=utf-8");
    return res.send(fs.readFileSync(bridgePath, "utf-8"));
  }
  res.status(404).send("// bridge script not found");
});

// ---------- Triều đình ----------
app.get("/lang", (req, res) => {
  const p = path.join(ROOT, "lang.html");
  if (!fs.existsSync(p)) return res.status(404).send("Chưa có lang.html (bản 3D).");
  sendHtmlFile(res, p);
});

app.get("/favicon.ico", (req, res) => res.status(204).end());

app.get("/extension.zip", async (req, res) => {
  const archiver = require("archiver");
  const origin = publicOrigin(req);
  let bridge = fs.readFileSync(path.join(ROOT, "muse_bridge.js"), "utf-8");
  bridge = bridge
    .replace('"http://127.0.0.1:5000"', JSON.stringify(origin))
    .replace('let TOOL_TOKEN = "";', "let TOOL_TOKEN = " + JSON.stringify(access.bridgeTokenForPage(req)) + ";");
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf-8"));
  const hosts = manifest.host_permissions || [];
  if (!hosts.includes(origin + "/*")) hosts.push(origin + "/*");
  manifest.host_permissions = hosts;

  res.set("Content-Type", "application/zip");
  res.set("Content-Disposition", "attachment; filename=muse_extension.zip");
  const archive = archiver("zip");
  archive.pipe(res);
  archive.append(JSON.stringify(manifest, null, 2), { name: "muse_extension/manifest.json" });
  archive.append(bridge, { name: "muse_extension/bridge.js" });
  archive.append(fs.readFileSync(path.join(ROOT, "extension", "background.js")), { name: "muse_extension/background.js" });
  const iconDir = path.join(ROOT, "extension", "icons");
  if (fs.existsSync(iconDir)) {
    for (const fn of fs.readdirSync(iconDir)) {
      archive.append(fs.readFileSync(path.join(iconDir, fn)), { name: "muse_extension/icons/" + fn });
    }
  }
  archive.finalize();
});

app.get("/connect", (req, res) => {
  sendHtmlFile(res, path.join(ROOT, "templates", "connect.html"), {
    token: access.bridgeTokenForPage(req),
  });
});

app.get("/trieu-dinh", (req, res) => sendHtmlFile(res, path.join(ROOT, "templates", "court.html")));

app.get("/api/court/agents", (req, res) => res.json(court.listBrains()));

app.post("/api/court/brain/:key", (req, res) => {
  const text = (req.body || {}).text || "";
  if (!text.trim()) return res.status(400).json({ error: "Bộ não trống" });
  try {
    court.writeBrain(req.params.key, text);
  } catch (_) {
    return res.status(404).json({ error: "Không có bộ này" });
  }
  res.json({ success: true });
});

app.post("/api/court/ask", (req, res) => {
  const data = req.body || {};
  const q = (data.question || "").trim();
  if (!q) return res.status(400).json({ error: "Câu hỏi trống" });
  const to = data.to || "auto";
  if (!court.bridgeOnline()) return res.status(409).json({ error: "Chưa nối với tab muse.ai (đèn trạng thái chưa xanh)." });
  res.json(court.startRun(q, to));
});

app.get("/api/court/runs", (req, res) => {
  res.json(Array.from(court.runs.values()).sort((a, b) => b.started - a.started));
});

app.get("/api/court/tabs", (req, res) => res.json(court.listTabs()));

app.post("/api/court/tabs/auto", (req, res) => res.json({ tabs: court.autoAssign() }));

app.post("/api/court/tab/:tabId", (req, res) => {
  const t = court.setTab(req.params.tabId, req.body || {});
  if (!t) return res.status(404).json({ error: "Không có tab này" });
  res.json(court.tabView(t));
});

app.post("/api/court/tab/:tabId/forget", (req, res) => res.json({ success: court.forgetTab(req.params.tabId) }));

app.post("/api/court/clear", (req, res) => res.json({ cleared: court.clearRuns() }));

app.post("/api/court/cancel/:rid", (req, res) => res.json({ success: court.cancelRun(req.params.rid) }));

arena.init(app);
jarvis.init(app);

// 404/405: trang và API không khớp đường dẫn nào ở trên
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Không có đường dẫn này" });
  const last = req.path.replace(/\/$/, "").split("/").pop().replace(/[.,;:)]+$/, "");
  if (req.method === "GET" && ["lang", "trieu-dinh", "san-choi", "connect", "chat", "jarvis"].includes(last)) {
    return res.redirect(pref("/" + last));
  }
  const b = base();
  res.status(404).send(
    "<meta charset='utf-8'><body style='font-family:system-ui;background:#0b0f17;color:#f3e6d6;padding:40px'>" +
      "<h2>Không có trang này</h2><p>Các trang có sẵn:</p><ul>" +
      "<li><a style='color:#fbbf24' href='" + pref("/lang") + "'>" + pref("/lang") + "</a> Làng 3D</li>" +
      "<li><a style='color:#fbbf24' href='" + pref("/trieu-dinh") + "'>" + pref("/trieu-dinh") + "</a> Triều Đình</li>" +
      "<li><a style='color:#fbbf24' href='" + pref("/jarvis") + "'>" + pref("/jarvis") + "</a> JARVIS (nói chuyện bằng giọng)</li>" +
      "<li><a style='color:#fbbf24' href='" + pref("/san-choi") + "'>" + pref("/san-choi") + "</a> Sân Chơi Bot</li>" +
      "<li><a style='color:#fbbf24' href='" + pref("/connect") + "'>" + pref("/connect") + "</a> Nối trình duyệt</li></ul>" +
      "<p style='color:#b9a390'>Nhớ gõ địa chỉ không kèm dấu chấm ở cuối." + (b ? " Prefixed: " + b : "") + "</p>"
  );
});

// lỗi chưa bắt được: ghi log thay vì làm sập tiến trình
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith("/api/")) return res.status(500).json({ error: "Lỗi nội bộ" });
  res.status(500).send("Lỗi nội bộ");
});

function main() {
  // cPanel / Passenger sets PORT. Prefer that; else MUSE_PORT / 5000.
  const port = parseInt(process.env.PORT || process.env.MUSE_PORT || "5000", 10);
  const underPassenger = Boolean(process.env.PORT) || Boolean(process.env.PASSENGER_BASE_URI);
  const host = process.env.MUSE_HOST || (underPassenger || access.PUBLIC ? "0.0.0.0" : "127.0.0.1");
  const b = base();

  console.log("=".repeat(60));
  console.log(" MUSE AI BRIDGE & CHAT TOOL (Node.js) IS RUNNING");
  console.log(" Listen: " + host + ":" + port + (b ? "  base=" + b : ""));
  console.log(" Open: http://localhost:" + port + (b || "") + "/");
  console.log("=".repeat(60));

  function start() {
    if (access.PUBLIC) console.log(" CHẾ ĐỘ TÊN MIỀN: bắt buộc đăng nhập.");
    app.listen(port, host, () => {});
  }

  // Skip the "already running" probe under Passenger / when PORT is assigned —
  // the platform owns the port and probing it races the listen.
  if (underPassenger) {
    start();
    return;
  }

  const probe = net.createConnection({ host: "127.0.0.1", port, timeout: 1000 });
  probe.on("connect", () => {
    console.log(` Tool đã chạy sẵn ở cổng ${port}, không mở thêm bản thứ hai.`);
    probe.destroy();
    setTimeout(() => process.exit(0), 30000);
  });
  probe.on("error", () => start());
}

process.on("uncaughtException", (e) => {
  const logPath = path.join(HERE, "server.log");
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} Tool dừng: ${e.stack || e}\n`, "utf-8");
  } catch (_) { /* không ghi được log, bỏ qua */ }
  console.error(e);
});

main();
