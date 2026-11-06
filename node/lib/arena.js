"use strict";
/* Sân chơi: nhiều bot AI (ChatGPT, Gemini, Claude, Grok, Muse...) nói chuyện với nhau trong một phòng.
 *
 * Một người nói tham gia phòng có thể là:
 *   - một TAB trình duyệt đang đăng nhập sẵn tài khoản (ChatGPT, Gemini, Claude, Grok, Muse...), nối bằng cầu nối như Muse
 *   - một BOT WEBHOOK: Tool POST nội dung tới URL của bạn, nhận câu trả lời (đồng bộ hoặc gọi lại sau)
 *   - một BOT API kiểu OpenAI (chat/completions): dùng cho Grok của xAI và mọi dịch vụ có cổng tương thích
 *   - một BOT CLI: chạy lệnh thật trên máy chủ (vd. `codex exec`) — AI lập trình thật, tự sửa file/chạy lệnh
 *     trong thư mục làm việc được cấu hình, không chỉ chat suông.
 * Phòng chạy lần lượt từng người một, mỗi người thấy những câu gần nhất của cả phòng.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const which = require("which");

const court = require("./court");

const DATA = court.DATA;
const BOTS_FILE = path.join(DATA, "arena_bots.json");
const ROOMS_FILE = path.join(DATA, "arena_rooms.json");
const UPLOAD_DIR = path.join(DATA, "arena_uploads");
const HISTORY_IN_PROMPT = 10;
const CLI_TIMEOUT = 1200 * 1000; // ms cho mỗi lượt bot CLI (code agent) — việc code có thể lâu
const IMG_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const VID_EXT = [".mp4", ".webm", ".mov"];
const CLI_SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", "libs", "data", ".venv", "venv"]);
const MAX_TURNS_LIMIT = 999999;
const HTTP_TIMEOUT = 120 * 1000;
const DEFAULT_INTRO = 'Từ giờ bạn đang trò chuyện trực tiếp với một AI khác; mọi tin nhắn sau là lời của họ. Hãy đáp lại thẳng như người nói chuyện bình thường: vào ý chính ngay, tối đa {n} câu, có chính kiến, giọng tự nhiên. Không phân tích, không giải thích, không tóm tắt lại lời họ, không nhận xét về cuộc trò chuyện, không hỏi xin chỉ dẫn, không nhắc đến việc mình là AI hay đề bài. Chỉ viết đúng lời đáp.';

const IMAGE_EXT_RE = /https?:\/\/[^\s<>"'\)]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s<>"'\)]*)?/ig;
const MD_IMAGE_RE = /!\[(.*?)\]\((https?:\/\/[^\s\)]+|data:image\/[^\s\)]+)\)/ig;
const TAG_IMAGE_RE = /\[IMAGE:\s*([^\s\]]+)\]|<img\s+[^>]*src=["']([^"']+)["']/ig;

const VIDEO_EXT_RE = /https?:\/\/[^\s<>"'\)]+\.(?:mp4|webm|mov|ogg)(?:\?[^\s<>"'\)]*)?/ig;
const TAG_VIDEO_RE = /\[VIDEO:\s*([^\s\]]+)\]|<video\s+[^>]*src=["']([^"']+)["']/ig;

const OPTION_LINE_RE = new RegExp(
  "^\\s*(" +
    "(?:" +
    "(?:\\d+[\\.\\)]|\\([0-9]+\\))\\s+" +
    "|[A-Za-z][\\.\\)]\\s+" +
    "|\\[[A-Za-z0-9]\\]\\s*" +
    "|(?:Option|Lựa chọn|Phương án)\\s*\\d*[:\\.]\\s*" +
    "|[🔘👉•\\-\\*]\\s*\\[\\s*\\]\\s*" +
    ")" +
    ".+)$",
  "gim"
);

function matchAll(re, text) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    out.push(m);
    if (m[0] === "") re.lastIndex++;
  }
  return out;
}

function parseMediaAndOptions(text) {
  const images = [];
  const videos = [];
  const options = [];
  if (!text) return { images, videos, options };

  for (const m of matchAll(MD_IMAGE_RE, text)) {
    const url = m[2];
    if (url && !images.includes(url)) images.push(url);
  }
  for (const m of matchAll(TAG_IMAGE_RE, text)) {
    const url = m[1] || m[2];
    if (url && !images.includes(url)) images.push(url);
  }
  for (const m of matchAll(IMAGE_EXT_RE, text)) {
    if (!images.includes(m[0])) images.push(m[0]);
  }

  for (const m of matchAll(TAG_VIDEO_RE, text)) {
    const url = m[1] || m[2];
    if (url && !videos.includes(url)) videos.push(url);
  }
  for (const m of matchAll(VIDEO_EXT_RE, text)) {
    if (!videos.includes(m[0])) videos.push(m[0]);
  }

  const matches = matchAll(OPTION_LINE_RE, text).map((m) => m[0]);
  if (matches.length >= 2 && matches.length <= 10) {
    for (const opt of matches) {
      const cleaned = opt.trim();
      if (cleaned && cleaned.length < 140 && !options.includes(cleaned)) options.push(cleaned);
    }
  }
  return { images, videos, options };
}

const bots = new Map();
const rooms = new Map();
const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fb923c", "#c084fc", "#fbbf24", "#22d3ee", "#f87171"];

// ---------- lưu trữ ----------
function saveJson(file, obj) {
  try {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf-8");
    fs.renameSync(tmp, file);
  } catch (_) { /* bỏ qua */ }
}

function saveBots() {
  saveJson(BOTS_FILE, Array.from(bots.values()));
}

function saveRooms() {
  saveJson(ROOMS_FILE, Array.from(rooms.values()).sort((a, b) => a.created - b.created).slice(-30));
}

function loadAll() {
  try {
    for (const b of JSON.parse(fs.readFileSync(BOTS_FILE, "utf-8"))) bots.set(b.id, b);
  } catch (_) { /* chưa có file */ }
  try {
    for (const r of JSON.parse(fs.readFileSync(ROOMS_FILE, "utf-8"))) {
      if (r.status === "running" || r.status === "paused") {
        r.status = "stopped";
        r.error = "Tool bị tắt giữa chừng.";
      }
      r.speaking = null;
      if (r.raw === undefined) r.raw = false;
      if (r.sentences === undefined) r.sentences = 3;
      if (r.pause === undefined) r.pause = 1;
      if (r.error === undefined) r.error = "";
      if (r.unlimited === undefined) r.unlimited = false;
      if (r.auto_pause_choices === undefined) r.auto_pause_choices = false;
      rooms.set(r.id, r);
    }
  } catch (_) { /* chưa có file */ }
}

// ---------- người tham gia ----------
function botPublic(b) {
  const o = {};
  for (const k of Object.keys(b)) if (k !== "key") o[k] = b[k];
  o.has_key = Boolean(b.key);
  return o;
}

function listParticipants() {
  const out = [];
  for (const t of court.listTabs()) {
    out.push({ key: "tab:" + t.id, name: t.label, provider: t.provider, kind: "tab", state: t.state, roles: t.roles });
  }
  for (const b of bots.values()) {
    out.push({ key: "bot:" + b.id, name: b.name, provider: b.provider || "other", kind: b.kind, state: b.enabled !== false ? "idle" : "paused", roles: [] });
  }
  return out;
}

function resolve(key) {
  if (key.startsWith("tab:")) {
    const t = court.tabs.get(key.slice(4));
    return t ? [t.label, t.provider || "muse", "tab"] : null;
  }
  if (key.startsWith("bot:")) {
    const b = bots.get(key.slice(4));
    return b ? [b.name, b.provider || "other", b.kind] : null;
  }
  return null;
}

// ---------- dựng lời nhắc ----------
const _LEAD = /^(?:ChatGPT|Gemini|Grok|Claude|Muse)\s+(?:said|responded|đã nói|đã phản hồi|đã trả lời)\s*:?\s*/i;
const _JUNK = /^(?:ChatGPT said:?|You said:?|Claude responded:?|Gemini said:?|Grok said:?|Gemini đã nói:?|ChatGPT đã nói:?|Claude đã (?:phản hồi|nói):?|Bạn đã nói:?|Grok đã nói:?|Message collapsed|Show more|Show less|Xem thêm|Thu gọn|just now|\d+ (?:seconds?|minutes?|giây|phút) ago|vừa xong|Thought for .*|Đã suy nghĩ .*|Thinking…?|Đang suy nghĩ…?|[-\s]+)$/i;

function scrub(text) {
  const lines = (text || "").replace(/\r/g, "").split("\n").filter((ln) => !_JUNK.test(ln.trim()));
  const normc = (t) => t.toLowerCase().replace(/[\W_]+/g, "");
  if (lines.length && _LEAD.test(lines[0].trim())) {
    const first = lines[0].trim().replace(_LEAD, "");
    const rest = normc(lines.slice(1).join("\n"));
    if (first && rest.startsWith(normc(first).slice(0, 60))) {
      lines.shift();
    } else {
      lines[0] = first;
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function historyText(room, limit) {
  limit = limit || HISTORY_IN_PROMPT;
  const msgs = room.messages.filter((m) => m.role !== "system").slice(-limit);
  if (!msgs.length) return "(Chưa ai nói. Bạn mở đầu cuộc trò chuyện.)";
  return msgs.map((m) => `[${m.name}]: ${scrub(m.text)}`).join("\n");
}

function corePrompt(room, p) {
  const others = room.participants.filter((q) => q.key !== p.key)
    .map((q) => `${q.name} (${court.PROVIDERS[q.provider] || q.provider})`).join(", ");
  const lines = [
    "Đây là một trò chơi trò chuyện nhiều AI do Chủ Nhân tổ chức, hoàn toàn an toàn. Hãy tham gia như một thành viên bình thường, đừng từ chối nhập vai.",
    `Bạn đang ở một phòng trò chuyện với các AI khác. Tên của bạn trong phòng: ${p.name}.`,
  ];
  if (p.persona) lines.push("Vai của bạn: " + p.persona);
  lines.push(
    `Những người cùng phòng: ${others || "chưa có ai khác"}, và Chủ Nhân (người điều khiển phòng).`,
    "Chủ đề: " + room.topic,
    "=== HỘI THOẠI GẦN ĐÂY ===",
    historyText(room),
    "=== HẾT ===",
    `Đến lượt bạn nói. Tối đa ${room.sentences || 3} câu, nối tiếp câu vừa rồi, có chính kiến riêng, đừng lặp lại ý đã nói, nói tiếng Việt. ` +
      "Chỉ viết lời của bạn, không ghi tên mình ở đầu dòng."
  );
  return lines.join("\n");
}

function outgoingText(room, p) {
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const m = room.messages[i];
    if (m.role === "system" || m.key === p.key) continue;
    const t = scrub(m.text);
    if (t) return t;
  }
  return room.topic;
}

function outgoingMedia(room, p) {
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const m = room.messages[i];
    if (m.role === "system" || m.key === p.key) continue;
    if ((m.text || "").trim()) return [m.images || [], m.videos || []];
  }
  return [[], []];
}

const DIR_HINT_RE = /^\[DIR:\s*([^\]]+)\]\s*\n?/i;

function outgoingForCli(room, p) {
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const m = room.messages[i];
    if (m.role === "system" || m.key === p.key) continue;
    let raw = m.text || "";
    if (raw.trim()) {
      let dirOverride = null;
      const mm = DIR_HINT_RE.exec(raw.trim());
      if (mm) {
        dirOverride = mm[1].trim();
        raw = raw.trim().replace(DIR_HINT_RE, "");
      }
      return [scrub(raw).trim(), dirOverride, m.images || [], m.videos || []];
    }
  }
  return [room.topic, null, [], []];
}

function introText(room, p) {
  const base = (room.intro || "").trim();
  if (!base) return "";
  return base + (p.persona ? "\nVai của bạn: " + p.persona : "");
}

function withIntro(room, p, msg) {
  const intro = introText(room, p);
  if (!room.introduced) room.introduced = [];
  if (intro && !room.introduced.includes(p.key)) return intro + "\n\n" + msg;
  return msg;
}

function cliPrompt(room, p, task) {
  const extra = historyText(room);
  const lines = [task];
  if (p.persona) lines.push(`(Vai trò của bạn trong việc này: ${p.persona})`);
  if (extra && extra.trim() !== task) {
    lines.push("", `Bối cảnh thêm (trao đổi trước đó trong cùng hệ thống, do Chủ Nhân vận hành, mục tiêu chung: ${room.topic}):`, extra);
  }
  lines.push("", "Làm thật trong thư mục làm việc hiện tại: sửa file, chạy lệnh, viết code — không chỉ bàn hay giới thiệu bản thân. " +
    "Xong thì báo cáo ngắn gọn bạn đã làm gì, file nào đã đổi.");
  return lines.join("\n");
}

function uploadLocalPath(url) {
  const marker = "/api/arena/upload/";
  if ((url || "").includes(marker)) {
    const fname = url.split(marker)[1].split("?")[0];
    const p = path.join(UPLOAD_DIR, fname);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function encodeDir(cwd) {
  return Buffer.from(cwd, "utf-8").toString("base64url");
}

function decodeDir(token) {
  return Buffer.from(token, "base64url").toString("utf-8");
}

function snapshotMedia(cwd) {
  const snap = {};
  const exts = new Set([...IMG_EXT, ...VID_EXT]);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (CLI_SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
        walk(path.join(dir, ent.name));
      } else {
        const ext = path.extname(ent.name).toLowerCase();
        if (exts.has(ext)) {
          const full = path.join(dir, ent.name);
          try {
            snap[full] = fs.statSync(full).mtimeMs;
          } catch (_) { /* biến mất giữa lúc quét, bỏ qua */ }
        }
      }
    }
  }
  walk(cwd);
  return snap;
}

function resolveBin(name) {
  try {
    return which.sync(name);
  } catch (_) {
    return name;
  }
}

function cliArgv(b, prompt, cwd, images) {
  const engine = (b.engine || "codex").trim() || "codex";
  if (engine === "codex") {
    const codexBin = resolveBin("codex");
    const cmd = [codexBin, "exec", "-s", "workspace-write", "-C", cwd, "--skip-git-repo-check"];
    for (const li of images) cmd.push("-i", li);
    cmd.push(prompt);
    return cmd;
  }
  const parts = splitShell((b.cmd || "").trim());
  if (!parts.length) throw new court.StepFailed("bot CLI chưa cấu hình lệnh chạy (engine tùy chỉnh nhưng thiếu 'cmd')");
  parts[0] = resolveBin(parts[0]);
  return parts.concat([prompt]);
}

function splitShell(s) {
  // tách tham số dòng lệnh đơn giản (hỗ trợ ngoặc kép), tương đương shlex.split cho trường hợp dùng ở đây
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function runCli(cmd, cwd, timeoutMs) {
  return new Promise((resolve_, reject) => {
    execFile(cmd[0], cmd.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new court.StepFailed(`chạy quá ${Math.round(timeoutMs / 1000)} giây chưa xong`));
        return;
      }
      if (err && err.code === "ENOENT") {
        reject(new court.StepFailed(`không tìm thấy lệnh '${cmd[0]}' trên máy chủ chạy Tool`));
        return;
      }
      resolve_({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function speakCliFull(room, p, b) {
  const [task, dirOverride, inImgs] = outgoingForCli(room, p);
  const prompt = room.raw ? cliPrompt(room, p, task) : corePrompt(room, p);
  const baseDir = dirOverride || (b.url || "").trim() || court.ROOT;
  const cwd = path.resolve(baseDir);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new court.StepFailed("thư mục làm việc không tồn tại trên máy chủ: " + cwd);
  }

  const localImgs = inImgs.map(uploadLocalPath).filter(Boolean);
  const cmd = cliArgv(b, prompt, cwd, localImgs);

  const before = snapshotMedia(cwd);
  const { stdout, stderr } = await runCli(cmd, cwd, CLI_TIMEOUT);
  const after = snapshotMedia(cwd);
  const text = (stdout || "").trim();
  if (!text) {
    const err = (stderr || "").trim();
    throw new court.StepFailed("bot CLI không trả về gì" + (err ? ": " + err.slice(0, 300) : ""));
  }

  const base = (room.base || "").replace(/\/$/, "");
  const outImgs = [];
  const outVids = [];
  if (base) {
    const dtok = encodeDir(cwd);
    for (const [full, mt] of Object.entries(after)) {
      if (full in before && mt <= before[full] + 0.01) continue;
      const rel = path.relative(cwd, full).split(path.sep).join("/");
      const url = base + "/api/arena/cli-file/" + dtok + "/" + encodeURIComponent(rel).replace(/%2F/g, "/");
      const ext = path.extname(full).toLowerCase();
      (IMG_EXT.includes(ext) ? outImgs : outVids).push(url);
    }
  }
  return { text, images: outImgs, videos: outVids, options: [] };
}

function tabPrompt(taskId, room, p) {
  return [
    `[[T-${taskId}]]`,
    "TIN TỰ ĐỘNG TỪ SÂN CHƠI, KHÔNG CÓ NGƯỜI TRẢ LỜI NGAY. Không hỏi lại, không xin xác nhận, không tạo tác vụ, không dùng công cụ hay tìm kiếm web. Chỉ trả lời bằng chữ ngay trong khung chat.",
    corePrompt(room, p),
    `Khi xong, viết đúng một dòng cuối: ${court.END_MARK}`,
    `[[/T-${taskId}]]`,
  ].join("\n");
}

// ---------- gọi từng loại người nói ----------
async function httpPost(url, payload, headers, timeoutMs) {
  if (!/^https?:\/\//.test(url || "")) throw new court.StepFailed("địa chỉ phải bắt đầu bằng http:// hoặc https://");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || HTTP_TIMEOUT);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      throw new court.StepFailed(`máy chủ bot trả lỗi ${res.status}: ${body.slice(0, 160)}`);
    }
    return [res.status, body];
  } catch (e) {
    if (e instanceof court.StepFailed) throw e;
    throw new court.StepFailed("không gọi được bot: " + e.message);
  } finally {
    clearTimeout(timer);
  }
}

function extractPayload(body) {
  const images = [];
  const videos = [];
  const options = [];
  let j;
  try {
    j = JSON.parse(body);
  } catch (_) {
    return [body.trim(), images, videos, options];
  }
  if (typeof j === "string") return [j.trim(), images, videos, options];
  if (j && typeof j === "object" && !Array.isArray(j)) {
    for (const k of ["image", "image_url", "image_urls", "images", "img"]) {
      const val = j[k];
      if (typeof val === "string" && val.trim()) images.push(val.trim());
      else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string" && item.trim()) images.push(item.trim());
          else if (item && item.url) images.push(String(item.url).trim());
        }
      }
    }
    for (const k of ["video", "video_url", "video_urls", "videos"]) {
      const val = j[k];
      if (typeof val === "string" && val.trim()) videos.push(val.trim());
      else if (Array.isArray(val)) {
        for (const item of val) if (typeof item === "string" && item.trim()) videos.push(item.trim());
      }
    }
    for (const k of ["options", "choices_list", "choices", "suggested_replies"]) {
      const val = j[k];
      if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === "string" && item.trim()) options.push(item.trim());
          else if (item && (item.text || item.title)) options.push(String(item.text || item.title).trim());
        }
      }
    }
    if (Array.isArray(j.choices) && j.choices.length) {
      const c = j.choices[0];
      const m = c.message || {};
      let content = m.content || c.text || "";
      let text;
      if (Array.isArray(content)) {
        const txtParts = [];
        for (const b of content) {
          if (b && typeof b === "object") {
            if (b.type === "text") txtParts.push(b.text || "");
            else if (b.type === "image_url") {
              const url = b.image_url && b.image_url.url;
              if (url) images.push(url);
            }
          }
        }
        text = txtParts.join(" ").trim();
      } else {
        text = String(content).trim();
      }
      return [text, images, videos, options];
    }
    for (const k of ["reply", "text", "output", "message", "content", "response", "answer"]) {
      const v = j[k];
      if (typeof v === "string" && v.trim()) return [v.trim(), images, videos, options];
      if (v && typeof v === "object" && typeof v.content === "string") return [v.content.trim(), images, videos, options];
    }
    return ["", images, videos, options];
  }
  return ["", images, videos, options];
}

async function speakWebhookFull(room, p, b) {
  const taskId = "w" + Date.now();
  court.tasks.set(taskId, { text: "", final: false, step: null, resolvers: [] });
  room.speaking_task = taskId;
  const raw = room.raw !== false;
  const sent = raw ? outgoingText(room, p) : corePrompt(room, p);
  const payload = {
    id: taskId, room: room.id, bot: p.name, topic: room.topic, persona: p.persona || "",
    history: room.messages.filter((m) => m.role !== "system").slice(-HISTORY_IN_PROMPT).map((m) => ({ name: m.name, text: m.text })),
    text: sent, prompt: sent, intro: raw ? introText(room, p) : "",
    callback: room.base ? room.base.replace(/\/$/, "") + "/api/arena/callback/" + taskId : "",
  };
  const headers = b.key ? { Authorization: "Bearer " + b.key, "X-Muse-Token": b.key } : {};
  const access = require("./access");
  if (access.PUBLIC) payload.callback_token = access.BRIDGE_TOKEN;
  const [status, body] = await httpPost(b.url, payload, headers);
  const [text, imgs, vids, opts] = extractPayload(body);
  if (text && status !== 202) return { text, images: imgs, videos: vids, options: opts };
  if (!payload.callback || payload.callback.includes("127.0.0.1") || payload.callback.includes("localhost")) {
    throw new court.StepFailed(`webhook đã nhận tin (HTTP ${status}) nhưng không trả lời ngay, và địa chỉ gọi lại của Tool là localhost nên dịch vụ bên ngoài không gọi về được. Cần tên miền hoặc đường hầm công khai để bot gửi câu trả lời về.`);
  }
  const deadline = Date.now() + HTTP_TIMEOUT;
  while (true) {
    await new Promise((r) => setTimeout(r, 500));
    if (room.status === "stopped") throw new court.RunCancelled();
    const t = court.tasks.get(taskId);
    if (t && t.final) break;
    if (Date.now() > deadline) throw new court.StepFailed(`chờ bot trả lời qua callback quá ${HTTP_TIMEOUT / 1000} giây`);
  }
  const cbText = court.partialReply(taskId);
  return { text: cbText, images: imgs, videos: vids, options: opts };
}

async function speakOpenaiFull(room, p, b) {
  const base = (b.url || "").replace(/\/$/, "");
  const url = base.endsWith("/chat/completions") ? base : base + "/chat/completions";
  let msgs;
  if (room.raw !== false) {
    msgs = [{ role: "user", content: outgoingText(room, p) }];
    if (introText(room, p)) msgs.unshift({ role: "system", content: introText(room, p) });
  } else {
    const sysMsg = `Bạn là ${p.name} trong một phòng trò chuyện nhiều AI. ${p.persona || ""}`.trim();
    msgs = [{ role: "system", content: sysMsg }, { role: "user", content: corePrompt(room, p) }];
  }
  const payload = { model: b.model || "", max_tokens: 1000, messages: msgs };
  const headers = b.key ? { Authorization: "Bearer " + b.key } : {};
  const [, body] = await httpPost(url, payload, headers);
  const [text, imgs, vids, opts] = extractPayload(body);
  if (!text && !imgs.length && !vids.length) throw new court.StepFailed("bot API không trả nội dung: " + body.slice(0, 160));
  return { text, images: imgs, videos: vids, options: opts };
}

async function speakFull(room, p) {
  const kind = p.kind;
  if (kind === "tab") {
    const raw = room.raw !== false;
    const sent = raw ? withIntro(room, p, outgoingText(room, p)) : null;
    const build = (taskId) => {
      room.speaking_task = taskId;
      return raw ? sent : tabPrompt(taskId, room, p);
    };
    const [, text] = await court.askTab(p.key.slice(4), build, { stop: () => room.status === "stopped", raw });
    if (raw) {
      if (!room.introduced) room.introduced = [];
      if (!room.introduced.includes(p.key)) room.introduced.push(p.key);
    }
    return { text, images: [], videos: [], options: [] };
  }
  const b = bots.get(p.key.slice(4));
  if (!b) throw new court.StepFailed("bot đã bị xóa");
  let res;
  if (kind === "cli") res = await speakCliFull(room, p, b);
  else if (kind === "webhook") res = await speakWebhookFull(room, p, b);
  else res = await speakOpenaiFull(room, p, b);
  if (typeof res === "string") return { text: res, images: [], videos: [], options: [] };
  return res;
}

// ---------- chạy phòng ----------
function addMessage(room, role, name, text, p, images, videos, options) {
  const { images: parsedImgs, videos: parsedVids, options: parsedOpts } = parseMediaAndOptions(text);

  const allImgs = [];
  for (const img of [...(images || []), ...parsedImgs]) if (img && !allImgs.includes(img)) allImgs.push(img);
  const allVids = [];
  for (const vid of [...(videos || []), ...parsedVids]) if (vid && !allVids.includes(vid)) allVids.push(vid);
  const allOpts = [];
  for (const opt of [...(options || []), ...parsedOpts]) if (opt && !allOpts.includes(opt)) allOpts.push(opt);

  const m = {
    role, name, text, ts: Date.now() / 1000,
    key: p ? p.key : "", provider: p ? p.provider : "", color: p && p.color ? p.color : "",
    images: allImgs, videos: allVids, options: allOpts,
  };
  room.messages.push(m);
  return m;
}

async function runRoom(room) {
  let fails = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      while (room.status === "paused") {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (room.status !== "running") break;
      if (!room.unlimited && room.max_turns > 0 && room.turns_done >= room.max_turns) break;
      const parts = room.participants;
      const p = parts[room.turn % parts.length];
      room.speaking = p.key;
      room.speaking_task = null;
      try {
        if (resolve(p.key) === null) throw new court.StepFailed("không còn tồn tại");
        const replyData = await speakFull(room, p);
        const text = scrub(replyData.text || "");
        if (!text) throw new court.StepFailed("trả lời rỗng");
        const msg = addMessage(room, "bot", p.name, text, p, replyData.images, replyData.videos, replyData.options);
        fails = 0;

        if (room.auto_pause_choices && msg.options && msg.options.length >= 2) {
          room.turn += 1;
          room.turns_done += 1;
          room.status = "paused";
          addMessage(room, "system", "Hệ thống", "⏸️ Đã tạm dừng phòng để Chủ Nhân bấm chọn phương án bên dưới.");
          saveRooms();
          break;
        }
      } catch (e) {
        if (e instanceof court.RunCancelled) throw e;
        fails += 1;
        addMessage(room, "system", "Hệ thống", `${p.name} không nói được: ${e.message}`);
        if (fails >= 3) {
          room.error = "Ba lần liên tiếp không ai trả lời được, dừng phòng.";
          room.status = "error";
          break;
        }
      }
      room.turn += 1;
      room.turns_done += 1;
      saveRooms();
      await new Promise((r) => setTimeout(r, Math.max(0, room.pause || 1) * 1000));
    }
    if (room.status === "running") room.status = "done";
  } catch (e) {
    if (e instanceof court.RunCancelled) room.status = "stopped";
    else {
      room.status = "error";
      room.error = "Lỗi nội bộ: " + e.message;
    }
  } finally {
    room.speaking = null;
    room.speaking_task = null;
    room.worker = false;
    saveRooms();
  }
}

function startWorker(room) {
  if (room.worker) return;
  room.worker = true;
  runRoom(room); // chạy nền (không await)
}

function createRoom(topic, items, maxTurns, pause, sentences, base, raw, intro, unlimited, autoPauseChoices) {
  if (raw === undefined) raw = true;
  const parts = [];
  items.forEach((it, i) => {
    const r = resolve(it.key || "");
    if (!r) return;
    parts.push({ key: it.key, name: r[0], provider: r[1], kind: r[2], persona: (it.persona || "").trim(), color: COLORS[i % COLORS.length] });
  });
  if (parts.length < 2) throw new Error("Cần ít nhất 2 người tham gia");
  const busy = new Set();
  for (const r of rooms.values()) if (r.status === "running" || r.status === "paused") for (const q of r.participants) busy.add(q.key);
  const clash = parts.filter((q) => busy.has(q.key)).map((q) => q.name);
  if (clash.length) throw new Error(`${clash.join(", ")} đang ở trong một phòng khác chưa dừng. Hãy bấm Dừng hoặc Xóa phòng đó trước.`);
  const rid = "room" + Date.now();

  const isUnlimited = Boolean(unlimited) || (parseInt(maxTurns || 0, 10) <= 0);
  const calculatedMax = isUnlimited ? 0 : Math.max(1, Math.min(parseInt(maxTurns || 10, 10), MAX_TURNS_LIMIT));

  const room = {
    id: rid, topic: (topic || "").trim() || "Trò chuyện tự do", participants: parts, messages: [], status: "running",
    turn: 0, turns_done: 0, max_turns: calculatedMax, unlimited: isUnlimited,
    auto_pause_choices: Boolean(autoPauseChoices),
    pause: Math.max(0, Math.min(parseFloat(pause || 1), 30)), sentences: Math.max(1, Math.min(parseInt(sentences || 3, 10), 8)),
    raw: Boolean(raw), introduced: [],
    created: Date.now() / 1000, error: "", speaking: null, speaking_task: null, base, worker: false,
  };
  room.intro = raw ? ((intro === undefined || intro === null ? DEFAULT_INTRO : intro) || "").replace("{n}", String(room.sentences)).trim() : "";
  rooms.set(rid, room);
  startWorker(room);
  return room;
}

function roomView(room) {
  const keys = ["id", "topic", "participants", "messages", "status", "turn", "turns_done", "max_turns",
    "pause", "sentences", "created", "error", "speaking", "raw", "intro", "unlimited", "auto_pause_choices"];
  const v = {};
  for (const k of keys) v[k] = room[k];
  v.live = room.speaking_task ? court.partialReply(room.speaking_task) : "";
  return v;
}

// ---------- đường dẫn ----------
function init(app) {
  loadAll();
  const multer = require("multer");
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const upload = multer({ dest: UPLOAD_DIR });

  app.get("/api/arena/default-intro", (req, res) => res.json({ intro: DEFAULT_INTRO }));

  app.post("/api/arena/upload", upload.single("file"), (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: "Thiếu file" });
    const ext = path.extname(f.originalname || "").toLowerCase();
    if (!IMG_EXT.includes(ext) && !VID_EXT.includes(ext)) {
      fs.unlink(f.path, () => {});
      return res.status(400).json({ error: "Chỉ nhận ảnh hoặc video" });
    }
    const fname = crypto.randomBytes(8).toString("hex") + ext;
    fs.renameSync(f.path, path.join(UPLOAD_DIR, fname));
    const url = req.protocol + "://" + req.get("host") + "/api/arena/upload/" + fname;
    res.json({ url, kind: VID_EXT.includes(ext) ? "video" : "image" });
  });

  app.get("/api/arena/upload/:fname", (req, res) => {
    res.sendFile(path.join(UPLOAD_DIR, req.params.fname), (err) => {
      if (err) res.status(404).end();
    });
  });

  app.get("/api/arena/cli-file/:dirtoken/*", (req, res) => {
    let cwd;
    try {
      cwd = path.resolve(decodeDir(req.params.dirtoken));
    } catch (_) {
      return res.status(400).send("Không hợp lệ");
    }
    const relpath = decodeURIComponent(req.params[0]);
    const full = path.resolve(path.join(cwd, relpath));
    if (full !== cwd && !full.startsWith(cwd + path.sep)) return res.status(403).send("Không có quyền");
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(404).send("Không có file này");
    res.sendFile(full);
  });

  app.get("/api/arena/participants", (req, res) => {
    res.json({ participants: listParticipants(), bots: Array.from(bots.values()).map(botPublic) });
  });

  app.post("/api/arena/bot", (req, res) => {
    const d = req.body || {};
    const kind = d.kind;
    if (!["webhook", "openai", "cli"].includes(kind)) return res.status(400).json({ error: "kind phải là webhook, openai hoặc cli" });
    const name = (d.name || "").trim().slice(0, 40);
    const url = (d.url || "").trim();
    if (!name) return res.status(400).json({ error: "Cần tên bot" });
    const engine = kind === "cli" ? (d.engine || "codex").trim() : "";
    const cmd = kind === "cli" ? (d.cmd || "").trim() : "";
    if (kind === "cli") {
      if (url && !(fs.existsSync(url) && fs.statSync(url).isDirectory())) {
        return res.status(400).json({ error: "Thư mục làm việc không tồn tại trên máy chủ: " + url });
      }
      if (!["codex", "custom"].includes(engine)) return res.status(400).json({ error: "engine phải là codex hoặc custom" });
      if (engine === "custom" && !cmd) return res.status(400).json({ error: "Engine tùy chỉnh cần nhập lệnh chạy (vd. tên CLI của Cursor/Copilot)" });
    } else if (!/^https?:\/\//.test(url)) {
      return res.status(400).json({ error: "Cần địa chỉ bắt đầu bằng http:// hoặc https://" });
    }
    let b = d.id ? bots.get(d.id) : null;
    if (!b) {
      b = { id: crypto.randomBytes(4).toString("hex"), enabled: true };
      bots.set(b.id, b);
    }
    Object.assign(b, { name, kind, url, model: (d.model || "").trim(), provider: d.provider in court.PROVIDERS ? d.provider : "other" });
    if (kind === "cli") Object.assign(b, { engine, cmd });
    if (d.key) b.key = String(d.key).trim();
    saveBots();
    res.json(botPublic(b));
  });

  app.delete("/api/arena/bot/:bid", (req, res) => {
    const ok = bots.delete(req.params.bid);
    saveBots();
    res.json({ success: ok });
  });

  app.post("/api/arena/bot/:bid/test", async (req, res) => {
    const b = bots.get(req.params.bid);
    if (!b) return res.status(404).json({ error: "Không có bot này" });
    const fake = {
      id: "test", topic: "Thử kết nối", messages: [],
      participants: [{ key: "bot:" + req.params.bid, name: b.name, provider: b.provider || "other" }],
      status: "running", sentences: 1, base: req.protocol + "://" + req.get("host"),
    };
    const p = { key: "bot:" + req.params.bid, name: b.name, provider: b.provider || "other", kind: b.kind, persona: "" };
    try {
      let res_;
      if (b.kind === "cli") res_ = await speakCliFull(fake, p, b);
      else if (b.kind === "webhook") res_ = await speakWebhookFull(fake, p, b);
      else res_ = await speakOpenaiFull(fake, p, b);
      res.json({ ok: true, reply: (res_.text || "").slice(0, 300), images: res_.images || [], options: res_.options || [] });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.post("/api/arena/room", (req, res) => {
    const d = req.body || {};
    try {
      const r = createRoom(d.topic || "", d.participants || [], d.max_turns, d.pause, d.sentences,
        req.protocol + "://" + req.get("host"), d.raw !== undefined ? d.raw : true, d.intro,
        d.unlimited || false, d.auto_pause_choices || false);
      res.json(roomView(r));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get("/api/arena/rooms", (req, res) => {
    res.json(Array.from(rooms.values()).sort((a, b) => b.created - a.created).map(roomView));
  });

  app.post("/api/arena/room/:rid/say", (req, res) => {
    const r = rooms.get(req.params.rid);
    const text = ((req.body || {}).text || "").trim();
    if (!r || !text) return res.status(400).json({ error: "Thiếu phòng hoặc lời nói" });
    addMessage(r, "user", "Chủ Nhân", text);
    res.json({ success: true });
  });

  app.post("/api/arena/room/:rid/choose", (req, res) => {
    const r = rooms.get(req.params.rid);
    if (!r) return res.status(404).json({ error: "Không có phòng này" });
    const d = req.body || {};
    const choice = (d.choice || d.text || "").trim();
    if (!choice) return res.status(400).json({ error: "Thiếu nội dung lựa chọn" });
    addMessage(r, "user", "Chủ Nhân", "👉 Lựa chọn: " + choice);
    if (r.status === "paused" || r.status === "done" || r.status === "stopped") {
      r.status = "running";
      startWorker(r);
    }
    saveRooms();
    res.json({ success: true, room: roomView(r) });
  });

  app.post("/api/arena/room/:rid/:action", (req, res) => {
    const r = rooms.get(req.params.rid);
    if (!r) return res.status(404).json({ error: "Không có phòng này" });
    const d = req.body || {};
    const action = req.params.action;
    if (action === "pause" && r.status === "running") r.status = "paused";
    else if (action === "resume" && r.status === "paused") r.status = "running";
    else if (action === "stop") r.status = "stopped";
    else if (action === "unlimited") {
      r.unlimited = !r.unlimited;
      if (r.unlimited) {
        r.max_turns = 0;
        if (r.status === "done" || r.status === "stopped") {
          r.status = "running";
          r.error = "";
          startWorker(r);
        }
      }
    } else if (action === "more") {
      r.max_turns = Math.min(r.turns_done + Math.max(1, parseInt(d.turns || 6, 10)), r.turns_done + MAX_TURNS_LIMIT);
      if (["done", "stopped", "error"].includes(r.status)) {
        r.status = "running";
        r.error = "";
        startWorker(r);
      }
    } else {
      return res.status(400).json({ error: "Không hiểu thao tác" });
    }
    saveRooms();
    res.json(roomView(r));
  });

  app.delete("/api/arena/room/:rid", (req, res) => {
    const r = rooms.get(req.params.rid);
    if (r) {
      r.status = "stopped";
      rooms.delete(req.params.rid);
      saveRooms();
    }
    res.json({ success: Boolean(r) });
  });

  app.post("/api/arena/callback/:taskId", (req, res) => {
    const d = req.body || {};
    let text = d.text || d.reply || "";
    let imgs = d.images || d.image || [];
    if (typeof imgs === "string") imgs = [imgs];
    let vids = d.videos || d.video || [];
    if (typeof vids === "string") vids = [vids];
    let opts = d.options || d.choices || [];
    if (typeof opts === "string") opts = [opts];

    const extra = [];
    for (const img of imgs) if (img) extra.push(`\n\n![Ảnh do AI tạo](${img})\n\n`);
    for (const vid of vids) if (vid) extra.push(`\n\n[VIDEO: ${vid}]\n\n`);
    if (opts.length) extra.push("\n" + opts.map((opt, i) => `${i + 1}. ${opt}`).join("\n"));
    if (extra.length) text = text + extra.join("");

    if (!text) return res.status(400).json({ error: "Thiếu text" });
    res.json({ success: court.onResponse(req.params.taskId, text, true) });
  });

  app.get("/san-choi", (req, res) => {
    res.sendFile(path.join(court.ROOT, "templates", "arena.html"));
  });
}

module.exports = { init, DEFAULT_INTRO, bots, rooms };
