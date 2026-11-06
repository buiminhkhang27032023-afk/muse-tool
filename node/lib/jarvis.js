"use strict";
/* JARVIS: trợ lý điều khiển máy bằng giọng nói.
 *
 * Lệnh máy (mở/đóng ứng dụng, khóa máy, chụp màn hình, âm lượng, giờ/ngày) được xử lý
 * ngay tại đây, không cần internet. Câu hỏi không khớp lệnh máy nào thì trang /jarvis
 * sẽ tự chuyển sang hỏi Muse qua cầu nối có sẵn (giống trang /chat), rồi đọc câu trả lời
 * lên loa khi Muse trả lời xong.
 */
const fs = require("fs");
const path = require("path");
const { execFile, exec } = require("child_process");

const court = require("./court");
const { sendHtmlFile, pref, base } = require("./prefix");

const BASE_DIR = court.HERE;
const SCREENSHOT_DIR = path.join(court.DATA, "screenshots");
const BRAIN_PATH = path.join(court.BRAIN_DIR, "jarvis.md");
const DEFAULT_BRAIN =
  "Bạn là JARVIS — trợ lý giọng nói của Sếp. Nói tiếng Việt, lễ phép, gọi người dùng là \"Sếp\", " +
  "hơi dí dỏm kiểu quản gia thông minh nhưng luôn đi thẳng vào việc. Trả lời ngắn gọn, đúng trọng tâm, " +
  "không nói mình là AI, không bịa thông tin, tránh markdown vì câu trả lời sẽ được đọc to qua loa.";

const FILLER_WORDS = [
  "jarvis oi", "jarvis", "gia vi", "lam on", "giup toi", "giup minh", "giup",
  "duoc khong", "duoc ko", "nhe", "di", "ha", "vay", "cho toi", "ban co the",
  "co the", "dum", "gium", "oi",
];

function readJarvisBrain() {
  try {
    return fs.readFileSync(BRAIN_PATH, "utf-8").trim() || DEFAULT_BRAIN;
  } catch (_) {
    return DEFAULT_BRAIN;
  }
}

function writeJarvisBrain(text) {
  fs.mkdirSync(court.BRAIN_DIR, { recursive: true });
  fs.writeFileSync(BRAIN_PATH, text.trim() + "\n", "utf-8");
}

// alias (không dấu, chữ thường) -> lệnh mở bằng "start" (giống gõ vào hộp Run)
const APPS = {
  notepad: ["notepad", "ghi chu", "note pad", "so tay"],
  calc: ["may tinh", "calculator", "calc"],
  mspaint: ["paint", "ve tranh"],
  explorer: ["file explorer", "quan ly file", "thu muc may tinh", "explorer", "o dia"],
  cmd: ["command line", "cmd", "dong lenh", "terminal", "command prompt"],
  chrome: ["chrome", "trinh duyet", "coc coc"],
  winword: ["word", "van ban word", "microsoft word"],
  excel: ["excel", "bang tinh"],
  powerpnt: ["powerpoint", "trinh chieu", "slide"],
  code: ["vscode", "visual studio code", "code editor"],
  control: ["control panel", "bang dieu khien"],
  taskmgr: ["task manager", "quan ly tien trinh"],
};

// tên tiến trình thật (.exe) để đóng bằng taskkill
const PROCESS_NAMES = {
  notepad: "notepad.exe",
  calc: "CalculatorApp.exe",
  mspaint: "mspaint.exe",
  cmd: "cmd.exe",
  chrome: "chrome.exe",
  winword: "WINWORD.EXE",
  excel: "EXCEL.EXE",
  powerpnt: "POWERPNT.EXE",
  code: "Code.exe",
  taskmgr: "Taskmgr.exe",
};

const SITES = {
  youtube: [["youtube", "you tube"], "https://youtube.com"],
  google: [["google", "tim kiem google"], "https://google.com"],
  gmail: [["gmail", "email", "thu dien tu"], "https://mail.google.com"],
  facebook: [["facebook", "fb"], "https://facebook.com"],
  muse: [["muse", "muse.ai", "muse ai"], "https://muse.ai"],
};

const VK_VOLUME_MUTE = 0xad;
const VK_VOLUME_DOWN = 0xae;
const VK_VOLUME_UP = 0xaf;

// nối nhiều bước trong một câu nói, ví dụ "mở trình duyệt rồi chọn tk main và mở youtube"
const STEP_SPLIT_RE = /\b(?:va|roi|sau do|xong)\b/;

const CHROME_LOCAL_STATE = path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data", "Local State");

const ACCENT_FROM = "àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ";
const ACCENT_TO = "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy";

function stripAccents(s) {
  let out = "";
  for (const ch of s) {
    const i = ACCENT_FROM.indexOf(ch);
    out += i >= 0 ? ACCENT_TO[i] : ch;
  }
  return out;
}

function normText(text) {
  let t = stripAccents(text.toLowerCase()).trim();
  t = t.replace(/[.,!?;:]+/g, " ");
  for (const w of FILLER_WORDS) {
    const re = new RegExp("(?<![a-z])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z])", "g");
    t = t.replace(re, " ");
  }
  return t.replace(/\s+/g, " ").trim();
}

function openTarget(target) {
  try {
    exec('start "" ' + target, { shell: "cmd.exe" });
    return true;
  } catch (_) {
    return false;
  }
}

function findApp(rest) {
  for (const [key, aliases] of Object.entries(APPS)) {
    for (const a of aliases) if (rest.includes(a)) return key;
  }
  return null;
}

function findSite(rest) {
  for (const [key, [aliases, url]] of Object.entries(SITES)) {
    for (const a of aliases) if (rest.includes(a)) return [key, url];
  }
  return [null, null];
}

function psKeyPress(vk, times) {
  times = times || 1;
  const script =
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;" +
    "public class U{[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b,byte s,uint f,UIntPtr e);}';" +
    Array.from({ length: times }, () =>
      `[U]::keybd_event(${vk},0,0,[UIntPtr]::Zero);[U]::keybd_event(${vk},0,2,[UIntPtr]::Zero);Start-Sleep -Milliseconds 50;`
    ).join("");
  execFile("powershell", ["-NoProfile", "-Command", script], { timeout: 8000 }, () => {});
}

function chromeProfileDir(name) {
  const target = normText(name);
  if (!target) return null;
  let cache;
  try {
    const state = JSON.parse(fs.readFileSync(CHROME_LOCAL_STATE, "utf-8"));
    cache = (state.profile || {}).info_cache || {};
  } catch (_) {
    return null;
  }
  let best = null;
  for (const [key, info] of Object.entries(cache)) {
    const nm = normText(info.name || "");
    if (nm === target) return key;
    if ((target && nm.includes(target)) || (nm && target.includes(nm))) best = best || key;
  }
  return best;
}

function tryBrowserProfileSite(text) {
  if (!["trinh duyet", "chrome", "coc coc"].some((k) => text.includes(k))) return null;
  const m = /\b(?:tk|tai khoan|profile|acc)\s+([a-z0-9]+)/.exec(text);
  if (!m) return null;
  const profileName = m[1].trim();
  const profileDir = chromeProfileDir(profileName);
  const [siteKey, url] = findSite(text);
  try {
    let cmd = "start chrome";
    if (profileDir) cmd += ` --profile-directory="${profileDir}"`;
    if (url) cmd += " " + url;
    exec(cmd, { shell: "cmd.exe" });
  } catch (e) {
    return { matched: true, ok: false, reply: "Không mở được trình duyệt: " + e.message };
  }
  const parts = ["Đã mở trình duyệt"];
  if (profileDir) parts.push(`với tài khoản ${profileName}`);
  else parts.push(`(chưa tìm thấy tài khoản "${profileName}" nào trùng tên, mở theo mặc định)`);
  if (url) parts.push(`và vào ${siteKey || "trang web"}`);
  return { matched: true, ok: true, reply: parts.join(", ") + "." };
}

function takeScreenshot() {
  return new Promise((resolve) => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const fname = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15) + ".png";
    const fpath = path.join(SCREENSHOT_DIR, fname);
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; " +
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; " +
      "$g=[System.Drawing.Graphics]::FromImage($bmp); " +
      "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); " +
      "$bmp.Save('" + fpath.replace(/\\/g, "\\\\") + "')";
    execFile("powershell", ["-NoProfile", "-Command", ps], { timeout: 15000 }, () => {
      resolve(fs.existsSync(fpath) ? fname : null);
    });
  });
}

function handleCommand(rawText) {
  const text = normText(rawText);
  if (!text) return Promise.resolve({ matched: true, ok: false, reply: "Dạ, tôi chưa nghe rõ." });

  if (["tat may", "khoi dong lai", "restart may", "shutdown", "tat nguon"].some((k) => text.includes(k))) {
    return Promise.resolve({
      matched: true, ok: false,
      reply: "Để an toàn, tôi không tắt hoặc khởi động lại máy bằng giọng nói. Bạn tự làm việc đó trực tiếp nhé.",
    });
  }

  const combo = tryBrowserProfileSite(text);
  if (combo) return Promise.resolve(combo);

  const steps = text.split(STEP_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  if (steps.length > 1) {
    return (async () => {
      const done = [];
      const unknown = [];
      for (const s of steps) {
        const r = await handleSingle(s);
        if (r.matched) done.push(r.reply);
        else unknown.push(s);
      }
      if (!done.length) return { matched: false };
      let reply = done.join(" ");
      if (unknown.length) reply += ` (Chưa hiểu phần: ${unknown.join("; ")}.)`;
      return { matched: true, ok: true, reply };
    })();
  }

  return handleSingle(text);
}

async function handleSingle(text) {
  if (["khoa may", "khoa man hinh", "lock screen", "lock may"].some((k) => text.includes(k))) {
    try {
      exec("rundll32.exe user32.dll,LockWorkStation");
      return { matched: true, ok: true, reply: "Đã khóa màn hình." };
    } catch (e) {
      return { matched: true, ok: false, reply: "Không khóa được máy: " + e.message };
    }
  }

  if (["chup man hinh", "chup anh man hinh", "screenshot"].some((k) => text.includes(k))) {
    const fname = await takeScreenshot();
    if (fname) return { matched: true, ok: true, reply: "Đã chụp màn hình xong.", extra: { screenshot: pref("/jarvis/screenshot/" + fname) } };
    return { matched: true, ok: false, reply: "Chụp màn hình không thành công." };
  }

  if (["tat tieng", "tat am luong", "mute"].some((k) => text.includes(k))) {
    psKeyPress(VK_VOLUME_MUTE);
    return { matched: true, ok: true, reply: "Đã tắt tiếng." };
  }
  if (["tang am luong", "to len", "volume up", "tang volume"].some((k) => text.includes(k))) {
    psKeyPress(VK_VOLUME_UP, 4);
    return { matched: true, ok: true, reply: "Đã tăng âm lượng." };
  }
  if (["giam am luong", "nho lai", "volume down", "giam volume"].some((k) => text.includes(k))) {
    psKeyPress(VK_VOLUME_DOWN, 4);
    return { matched: true, ok: true, reply: "Đã giảm âm lượng." };
  }

  if (["may gio", "gio hien tai", "bay gio la may gio"].some((k) => text.includes(k))) {
    const now = new Date();
    return { matched: true, ok: true, reply: `Bây giờ là ${String(now.getHours()).padStart(2, "0")} giờ ${String(now.getMinutes()).padStart(2, "0")} phút.` };
  }
  if (["hom nay ngay may", "hom nay thu may", "ngay hom nay"].some((k) => text.includes(k))) {
    const now = new Date();
    return { matched: true, ok: true, reply: `Hôm nay là ${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}.` };
  }

  let m = /\b(dong|tat)\s+(.+)$/.exec(text);
  if (m) {
    const rest = m[2];
    const key = findApp(rest);
    if (key && PROCESS_NAMES[key]) {
      try {
        await new Promise((res) => execFile("taskkill", ["/IM", PROCESS_NAMES[key], "/F"], { timeout: 10000 }, () => res()));
        return { matched: true, ok: true, reply: "Đã đóng " + rest.trim() + "." };
      } catch (e) {
        return { matched: true, ok: false, reply: "Không đóng được: " + e.message };
      }
    }
    return { matched: true, ok: false, reply: `Tôi chưa biết cách đóng "${rest.trim()}".` };
  }

  m = /\b(mo|khoi dong|chay|bat)\s+(.+)$/.exec(text);
  if (m) {
    const rest = m[2];
    const [siteKey, url] = findSite(rest);
    if (url) {
      exec('start "" ' + url, { shell: "cmd.exe" });
      return { matched: true, ok: true, reply: "Đã mở " + rest.trim() + "." };
    }
    const appKey = findApp(rest);
    if (appKey) {
      openTarget(appKey);
      return { matched: true, ok: true, reply: "Đã mở " + rest.trim() + "." };
    }
    exec('start "" "https://www.google.com/search?q=' + rest.trim().replace(/ /g, "+") + '"', { shell: "cmd.exe" });
    return { matched: true, ok: true, reply: `Tôi chưa biết ứng dụng "${rest.trim()}", nên đã tìm trên Google giúp bạn.` };
  }

  return { matched: false };
}

function init(app) {
  app.get("/jarvis", (req, res) => {
    sendHtmlFile(res, path.join(court.ROOT, "templates", "jarvis.html"));
  });

  app.post("/api/jarvis/cmd", async (req, res) => {
    const data = req.body || {};
    const text = (data.text || "").trim();
    if (!text) return res.status(400).json({ error: "Nội dung trống" });
    res.json(await handleCommand(text));
  });

  app.get("/api/jarvis/brain", (req, res) => res.json({ text: readJarvisBrain() }));

  app.post("/api/jarvis/brain", (req, res) => {
    const text = (req.body || {}).text || "";
    if (!text.trim()) return res.status(400).json({ error: "Bộ não trống" });
    writeJarvisBrain(text);
    res.json({ success: true });
  });

  app.get("/jarvis/screenshot/:fname", (req, res) => {
    res.sendFile(path.join(SCREENSHOT_DIR, req.params.fname), (err) => {
      if (err) res.status(404).end();
    });
  });
}

module.exports = { init, handleCommand, readJarvisBrain, writeJarvisBrain };
