"use strict";
/* Triều đình: điều phối các bộ (mỗi bộ = một "bộ não" nạp vào Muse) trả lời câu hỏi của Nhà Vua.
 *
 * Luồng:
 *   Vua hỏi -> (Nội Các chia việc) -> từng bộ làm -> bộ có thể hỏi bộ khác (@hoi) -> bộ hoàn thiện
 *   -> (Nội Các tổng hợp) -> kết quả tâu về Vua.
 * Mỗi bước là một tin gửi vào Muse qua cầu nối (có kèm bộ não của bộ đó), đợi Muse trả lời xong mới sang bước sau.
 */
const fs = require("fs");
const path = require("path");
const { createJobStore } = require("./jobstore");

const HERE = __dirname.endsWith("lib") ? path.dirname(__dirname) : __dirname; // node/ or app root
// Deploy flat (templates next to server.js) OR monorepo (templates in parent of node/).
const ROOT = process.env.MUSE_ROOT
  ? path.resolve(process.env.MUSE_ROOT)
  : (fs.existsSync(path.join(HERE, "templates")) ? HERE : path.resolve(HERE, ".."));
const DATA = process.env.MUSE_DATA || path.join(HERE, "data");
const BRAIN_DIR = path.join(DATA, "brains");
const RUNS_FILE = path.join(DATA, "court_runs.json");

fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(BRAIN_DIR)) {
  try {
    fs.cpSync(path.join(ROOT, "brains"), BRAIN_DIR, { recursive: true });
  } catch (_) { /* chưa có brains gốc, bỏ qua */ }
}

// Disk-backed job bus: required under Passenger/LiteSpeed when >1 Node worker.
// In-memory Maps stay as a fast path for the worker that owns waitTask().
const jobstore = createJobStore(DATA);
jobstore.cleanup(7200);

const QUEUE_WAIT = 600; // giây chờ có tab rảnh nhận việc
const STEP_TIMEOUT = 240; // giây chờ Muse trả lời mỗi bước
const END_MARK = "###HET###"; // Muse được dặn kết thúc bằng dòng này để biết đã trả lời xong

const AGENTS = {
  noicac: { ten: "Bệ Hạ", chuc: "Vua điều hành triều đình" },
  cong: { ten: "Công Bộ", chuc: "AI làm phim và video" },
  le: { ten: "Lễ Bộ", chuc: "Xây kênh" },
  ho: { ten: "Hộ Bộ", chuc: "Web và Google Ads" },
  binh: { ten: "Binh Bộ", chuc: "Ads Facebook" },
  hinh: { ten: "Hình Bộ", chuc: "Sale" },
  lai: { ten: "Lại Bộ", chuc: "Hậu kỳ, edit video" },
};
const BO_KEYS = ["cong", "le", "ho", "binh", "hinh", "lai"];

const runs = new Map(); // run_id -> run
const tasks = new Map(); // task_id -> {text, final, step, taken, resolvers:[]}
const pending = []; // [{id, text, agent, tab?, raw?}] hàng đợi gửi sang cầu nối
let bridgeSeen = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class RunCancelled extends Error {}
class StepFailed extends Error {}

// ---------- bộ não ----------
function brainPath(key) {
  return path.join(BRAIN_DIR, key + ".md");
}

function readBrain(key) {
  try {
    return fs.readFileSync(brainPath(key), "utf-8").trim();
  } catch (_) {
    const a = AGENTS[key] || {};
    return `Bạn là ${a.ten || key} (${a.chuc || ""}).`;
  }
}

function writeBrain(key, text) {
  if (!(key in AGENTS)) throw new Error("no-such-agent:" + key);
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  fs.writeFileSync(brainPath(key), text.trim() + "\n", "utf-8");
}

function listBrains() {
  return Object.keys(AGENTS).map((k) => ({ key: k, ten: AGENTS[k].ten, chuc: AGENTS[k].chuc, text: readBrain(k) }));
}

// ---------- sổ tab Muse: mỗi trình duyệt / profile / tài khoản tự đăng ký, vai trò gán ngay trên giao diện ----------
const FRESH = 5; // giây: tab im lặng quá lâu coi như mất kết nối
const BUSY_MAX = 330; // giây: tab báo bận quá lâu thì tự giải phóng
const tabs = new Map(); // tab_id -> thông tin tab
const TABS_FILE = path.join(DATA, "court_tabs.json");

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowS() {
  return Date.now() / 1000;
}

function saveTabs() {
  try {
    const keep = {};
    for (const [k, v] of tabs) {
      keep[k] = { id: v.id, label: v.label, roles: v.roles, limit: v.limit, paused: v.paused, done: v.done, day: v.day, provider: v.provider };
    }
    fs.writeFileSync(TABS_FILE, JSON.stringify(keep), "utf-8");
  } catch (_) { /* không ghi được, bỏ qua */ }
}

function loadTabs() {
  try {
    const obj = JSON.parse(fs.readFileSync(TABS_FILE, "utf-8"));
    for (const [k, v] of Object.entries(obj)) {
      if (!v.roles) v.roles = v.agent && AGENTS[v.agent] ? [v.agent] : [];
      delete v.agent;
      if (!v.provider) v.provider = "muse";
      Object.assign(v, { seen: 0, busy: null, busy_since: 0, first: nowS(), flash: 0 });
      tabs.set(k, v);
    }
  } catch (_) { /* chưa có file, bỏ qua */ }
}

function roll(tab) {
  if (tab.day !== today()) {
    tab.day = today();
    tab.done = 0;
  }
}

function alive(t, now) {
  now = now || nowS();
  return now - t.seen < FRESH || Boolean(t.busy && now - t.busy_since < BUSY_MAX);
}

function tabReady(tab) {
  roll(tab);
  if (nowS() - tab.seen >= FRESH || tab.paused) return false;
  return !(tab.limit && tab.done >= tab.limit);
}

const PROVIDERS = { muse: "Muse", chatgpt: "ChatGPT", gemini: "Gemini", claude: "Claude", grok: "Grok", other: "Bot" };

function nextLabel(provider) {
  provider = provider || "muse";
  const base = PROVIDERS[provider] || "Bot";
  const used = new Set(Array.from(tabs.values()).map((t) => t.label));
  let n = 1;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function touchBridge(agent, tabId, label, provider) {
  const now = nowS();
  bridgeSeen = now;
  tabId = tabId || "anon-" + (agent || "*");
  let t = tabs.get(tabId);
  if (!t) {
    provider = provider in PROVIDERS ? provider : "muse";
    t = {
      id: tabId, provider, label: nextLabel(provider), roles: agent in AGENTS ? [agent] : [],
      limit: 0, paused: false, done: 0, day: today(), seen: now, busy: null, busy_since: 0, first: now, flash: 0,
    };
    tabs.set(tabId, t);
    saveTabs();
  }
  t.seen = now;
  if (provider in PROVIDERS && t.provider !== provider) t.provider = provider;
  if (t.busy && now - t.busy_since > BUSY_MAX) t.busy = null;
  roll(t);
  return t;
}

function setTab(tabId, data) {
  const t = tabs.get(tabId);
  if (!t) return null;
  if ("label" in data) t.label = String(data.label).slice(0, 40) || t.label;
  if ("roles" in data) t.roles = Object.keys(AGENTS).filter((r) => (data.roles || []).includes(r));
  else if ("agent" in data) t.roles = data.agent in AGENTS ? [data.agent] : [];
  if (data.flash) t.flash = nowS() + 8;
  if ("limit" in data) {
    const n = parseInt(data.limit, 10);
    if (!Number.isNaN(n)) t.limit = Math.max(0, n);
  }
  if ("paused" in data) t.paused = Boolean(data.paused);
  if (data.reset_done) t.done = 0;
  saveTabs();
  return t;
}

function forgetTab(tabId) {
  const t = tabs.get(tabId);
  if (t && nowS() - t.seen >= FRESH) {
    tabs.delete(tabId);
    saveTabs();
    return true;
  }
  return false;
}

function tabView(t) {
  roll(t);
  const now = nowS();
  let st;
  if (!alive(t, now)) st = "offline";
  else if (t.paused) st = "paused";
  else if (t.limit && t.done >= t.limit) st = "quota";
  else if (t.busy) st = "busy";
  else st = "idle";
  return {
    id: t.id, provider: t.provider || "muse", label: t.label, roles: t.roles, limit: t.limit, paused: t.paused,
    done: t.done, state: st, age: Math.round((now - t.seen) * 10) / 10,
  };
}

function listTabs() {
  return Array.from(tabs.values())
    .map(tabView)
    .sort((a, b) => (a.state === "offline") - (b.state === "offline") || a.label.localeCompare(b.label));
}

function agentOnline(agent) {
  const now = nowS();
  for (const t of tabs.values()) {
    roll(t);
    if (t.roles.includes(agent) && alive(t, now) && !t.paused && !(t.limit && t.done >= t.limit)) return true;
  }
  return false;
}

function onlineAgents() {
  return Object.keys(AGENTS).filter(agentOnline);
}

function agentLabels() {
  const now = nowS();
  const out = {};
  for (const t of tabs.values()) {
    if (alive(t, now)) {
      for (const r of t.roles) {
        (out[r] || (out[r] = [])).push(t.label);
      }
    }
  }
  return out;
}

function tabInfo(tabId) {
  const t = tabs.get(tabId);
  if (!t) return null;
  return { label: t.label, roles: t.roles.map((r) => AGENTS[r].ten), flash: (t.flash || 0) > nowS() };
}

function readyTabCount() {
  let n = 0;
  for (const t of tabs.values()) if (tabReady(t)) n++;
  return n;
}

function autoAssign() {
  const now = nowS();
  const live = Array.from(tabs.values()).filter((t) => alive(t, now)).sort((a, b) => a.first - b.first);
  if (!live.length) return 0;
  for (const t of live) t.roles = [];
  const order = ["noicac", "cong", "le", "ho", "binh", "hinh", "lai"];
  order.forEach((k, i) => live[i % live.length].roles.push(k));
  saveTabs();
  return live.length;
}

function onlineTabCount() {
  const now = nowS();
  let n = 0;
  for (const t of tabs.values()) if (alive(t, now)) n++;
  return n;
}

function bridgeOnline() {
  if (nowS() - bridgeSeen < FRESH) return true;
  for (const t of tabs.values()) if (t.busy && alive(t)) return true;
  return false;
}

function taskMatchesTab(t, tab, agent) {
  const want = t.agent || "";
  if (t.tab) return t.tab === tab.id; // việc của sân chơi: đích danh một tab
  return tab.roles.includes(want) || (!tab.roles.length && (tab.provider || "muse") === "muse" && !agentOnline(want));
}

function markTaken(task, tab) {
  const ts = nowS();
  tab.busy = task.id;
  tab.busy_since = ts;
  jobstore.setBusy(tab.id, task.id);
  jobstore.patchMeta(task.id, { taken: ts, tab: tab.id, label: tab.label });
  if (tasks.has(task.id)) {
    const rec = tasks.get(task.id);
    rec.taken = ts;
    if (rec.step) rec.step.tab = tab.label;
  } else {
    // Reply may land on this worker while waitTask runs on another — keep a stub.
    tasks.set(task.id, { text: "", final: false, step: null, taken: ts, resolvers: [] });
  }
  // Drop from this process's memory queue if present
  const i = pending.findIndex((p) => p.id === task.id);
  if (i >= 0) pending.splice(i, 1);
}

function takeTask(tabId, agent, label, provider) {
  const tab = touchBridge(agent, tabId, label, provider);
  const diskBusy = jobstore.getBusy(tab.id, BUSY_MAX);
  if (diskBusy && !tab.busy) {
    tab.busy = diskBusy;
    tab.busy_since = nowS();
  }
  if (tab.busy && nowS() - tab.busy_since > BUSY_MAX) {
    jobstore.clearBusy(tab.id, tab.busy);
    tab.busy = null;
  }
  if (tab.busy || !tabReady(tab)) return null;

  // Prefer disk claim (works across Passenger workers); memory is a hint only.
  const tryIds = [];
  for (const t of pending) {
    if (taskMatchesTab(t, tab, agent)) tryIds.push(t.id);
  }
  for (const id of jobstore.listPendingIds()) {
    if (!tryIds.includes(id)) {
      const t = jobstore.readPending(id);
      if (t && taskMatchesTab(t, tab, agent)) tryIds.push(id);
    }
  }
  for (const id of tryIds) {
    let claimed = jobstore.claim(id);
    if (!claimed) {
      const stillOnDisk = Boolean(jobstore.readPending(id));
      const mem = pending.find((p) => p.id === id);
      if (stillOnDisk) {
        // Contended; try next id
        continue;
      }
      if (mem) {
        // Disk enqueue missing (permissions etc.) — fall back to in-memory only
        claimed = mem;
      } else {
        continue;
      }
    }
    markTaken(claimed, tab);
    return claimed;
  }
  return null;
}

function onResponse(taskId, text, isFinal) {
  if (!taskId) return false;
  // Always persist so the worker running waitTask() (possibly another process) sees it.
  jobstore.patchMeta(taskId, { text: text || "", final: Boolean(isFinal) });
  jobstore.dropPending(taskId);

  let t = tasks.get(taskId);
  if (!t) {
    // Reply hit a different worker than askTab — create stub; waitTask on owner reads meta.
    t = { text: "", final: false, step: null, resolvers: [] };
    tasks.set(taskId, t);
  }
  t.text = text;
  const step = t.step;
  if (step) {
    step.reply = cleanReply(text);
    if (isFinal) step.status = "done";
  }
  if (isFinal) {
    t.final = true;
    (t.resolvers || []).forEach((fn) => fn());
    t.resolvers = [];
    const meta = jobstore.readMeta(taskId);
    const busyTabId = meta && meta.tab;
    let cleared = false;
    for (const tb of tabs.values()) {
      if (tb.busy === taskId) {
        tb.busy = null;
        roll(tb);
        tb.done += 1;
        jobstore.clearBusy(tb.id, taskId);
        cleared = true;
      }
    }
    if (!cleared && busyTabId) {
      jobstore.clearBusy(busyTabId, taskId);
      const tb = tabs.get(busyTabId);
      if (tb) {
        tb.busy = null;
        roll(tb);
        tb.done += 1;
      }
    }
    saveTabs();
  }
  return true;
}

function cleanReply(text) {
  return (text || "").split(END_MARK).join("").trim();
}

// ---------- dựng tin gửi Muse ----------
function buildPrompt(taskId, agent, instruction, context) {
  const a = AGENTS[agent];
  const parts = [
    `[[T-${taskId}]]`,
    "ĐÂY LÀ TIN TỰ ĐỘNG TỪ HỆ THỐNG, KHÔNG CÓ NGƯỜI TRẢ LỜI NGAY. Tuyệt đối KHÔNG hỏi lại, KHÔNG xin xác nhận, KHÔNG tạo tác vụ hay task, KHÔNG dùng công cụ nào. Thiếu thông tin thì tự đặt giả định hợp lý, ghi rõ giả định rồi trả lời luôn ngay trong khung chat.",
    `Từ lúc này bạn nhập vai ${a.ten} (${a.chuc}) trong triều đình. Quên các vai trước đó trong cuộc trò chuyện này.`,
    "=== BỘ NÃO CỦA BẠN ===",
    readBrain(agent),
    "=== HẾT BỘ NÃO ===",
  ];
  if (context) parts.push("=== BỐI CẢNH ===", context.trim(), "=== HẾT BỐI CẢNH ===");
  parts.push(
    "=== VIỆC CẦN LÀM ===",
    instruction.trim(),
    "=== HẾT VIỆC ===",
    "Chỉ trả lời bằng chữ ngay trong khung chat, không hỏi lại, không mở tác vụ hay công cụ nào khác. Tiếng Việt, gọn, đúng chuyên môn.",
    `Khi đã trả lời xong, viết đúng một dòng cuối cùng: ${END_MARK}`,
    `[[/T-${taskId}]]`
  );
  return parts.join("\n");
}

let taskSeq = 0;
function freshTaskId(prefix) {
  let id = prefix + Date.now() + "_" + (taskSeq++);
  while (tasks.has(id)) id += "x";
  return id;
}

async function waitTask(taskId, { isCancelled, stepTimeout, queueWait, onTimeoutCleanup }) {
  const queuedAt = nowS();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(500);
    if (isCancelled && isCancelled()) {
      jobstore.dropPending(taskId);
      if (onTimeoutCleanup) onTimeoutCleanup("cancelled");
      throw new RunCancelled();
    }
    const t = tasks.get(taskId);
    if (!t) throw new StepFailed("nội bộ: tác vụ đã biến mất");

    // Merge disk meta (reply/taken may have been written by another worker)
    const meta = jobstore.readMeta(taskId);
    if (meta) {
      if (meta.taken && !t.taken) t.taken = meta.taken;
      if (meta.text != null && meta.text !== "") t.text = meta.text;
      if (meta.final) {
        t.final = true;
        t.text = meta.text != null ? meta.text : t.text;
      }
    }

    if (t.final) return t;
    const taken = t.taken;
    // taken is epoch seconds (nowS), same as Python time.time()
    if (taken && nowS() > taken + stepTimeout) {
      if (onTimeoutCleanup) onTimeoutCleanup("step_timeout");
      throw new StepFailed(`quá ${stepTimeout} giây không trả lời`);
    }
    if (!taken && nowS() > queuedAt + queueWait) {
      jobstore.dropPending(taskId);
      if (onTimeoutCleanup) onTimeoutCleanup("queue_timeout");
      throw new StepFailed(`không có tab nào nhận việc (quá ${queueWait} giây)`);
    }
  }
}

async function askAgent(run, agent, kind, instruction, context, frm) {
  context = context || "";
  frm = frm || "chu";
  if (run.status === "cancelled") throw new RunCancelled();
  const taskId = freshTaskId("c");
  const step = { id: taskId, from: frm, to: agent, kind, ask: instruction.trim(), reply: "", status: "running", ts: nowS() };
  run.steps.push(step);
  tasks.set(taskId, { text: "", final: false, step, resolvers: [] });
  const agentTask = { id: taskId, text: buildPrompt(taskId, agent, instruction, context), agent };
  pending.push(agentTask);
  jobstore.enqueue(agentTask);
  await waitTask(taskId, {
    isCancelled: () => run.status === "cancelled",
    stepTimeout: STEP_TIMEOUT,
    queueWait: QUEUE_WAIT,
    onTimeoutCleanup: (reason) => {
      step.status = reason === "cancelled" ? "cancelled" : "timeout";
      jobstore.dropPending(taskId);
      if (reason === "queue_timeout") {
        const i = pending.findIndex((p) => p.id === taskId);
        if (i >= 0) pending.splice(i, 1);
      }
    },
  });
  step.status = "done";
  return step.reply;
}

async function askTab(tabId, build, opts) {
  opts = opts || {};
  const taskId = freshTaskId("a");
  tasks.set(taskId, { text: "", final: false, step: null, resolvers: [] });
  const tabTask = { id: taskId, text: build(taskId), agent: "", tab: tabId, raw: Boolean(opts.raw) };
  pending.push(tabTask);
  jobstore.enqueue(tabTask);
  try {
    await waitTask(taskId, {
      isCancelled: opts.stop,
      stepTimeout: STEP_TIMEOUT,
      queueWait: opts.queueWait || 180,
      onTimeoutCleanup: (reason) => {
        jobstore.dropPending(taskId);
        jobstore.clearBusy(tabId, taskId);
        if (reason === "cancelled" || reason === "queue_timeout") {
          const i = pending.findIndex((p) => p.id === taskId);
          if (i >= 0) pending.splice(i, 1);
        }
        const tb = tabs.get(tabId);
        if (tb && tb.busy === taskId) tb.busy = null;
      },
    });
  } catch (e) {
    throw e;
  }
  const done = tasks.get(taskId);
  return [taskId, cleanReply(done ? done.text : "")];
}

function partialReply(taskId) {
  const t = tasks.get(taskId);
  if (t && t.text) return cleanReply(t.text);
  const meta = jobstore.readMeta(taskId);
  return meta && meta.text ? cleanReply(meta.text) : "";
}

// ---------- đọc lệnh trong câu trả lời ----------
function norm(s) {
  s = (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
  return s.replace(/[^a-z ]/g, "").trim();
}

function resolveKey(raw) {
  const n = norm(raw);
  if (n in AGENTS) return n;
  for (const [k, v] of Object.entries(AGENTS)) {
    const nt = norm(v.ten);
    if (nt === n || n.includes(nt)) return k;
  }
  return null;
}

const CMD_RE = /^\W*@(giao|hoi|tau)\b\s*([^:：\n]*?)\s*[:：]\s*(.+)$/i;

function parseCmds(text) {
  const out = [];
  for (const line of (text || "").replace(/\*\*/g, "").replace(/`/g, "").split("\n")) {
    const m = CMD_RE.exec(line.trim());
    if (!m) continue;
    const cmd = m[1].toLowerCase();
    const who = m[2].trim();
    const body = m[3].trim();
    const key = who ? resolveKey(who) : null;
    out.push([cmd, key, body]);
  }
  return out;
}

function stripCmds(text) {
  const keep = (text || "").split("\n").filter((ln) => !CMD_RE.test(ln.replace(/\*\*/g, "").replace(/`/g, "").trim()));
  return keep.join("\n").trim();
}

// ---------- điều phối ----------
function who(frm) {
  if (frm === "chu" || frm === "vua") return "Chủ Nhân";
  return (AGENTS[frm] && AGENTS[frm].ten) || frm;
}

async function workBo(run, bo, taskText, frm, allowHoi) {
  if (allowHoi === undefined) allowHoi = true;
  const others = BO_KEYS.filter((k) => k !== bo).map((k) => `${k}=${AGENTS[k].ten}`).join(", ");
  let ins;
  if (!allowHoi) {
    ins = `${who(frm)} hỏi bạn:\n${taskText}\n\nTrả lời trực tiếp theo đúng chuyên môn của bạn, không hỏi lại bộ khác.`;
  } else {
    ins = `${who(frm)} giao việc cho bạn:\n${taskText}\n\n` +
      "Nếu tự làm được thì trả lời kết quả luôn. Nếu cần bộ khác hỗ trợ trước khi hoàn thành, " +
      "CHƯA trả lời kết quả, chỉ viết tối đa 2 dòng dạng:\n@hoi <mã bộ>: <câu hỏi cụ thể>\n" +
      `Mã bộ có thể dùng: ${others}.`;
  }
  const first = await askAgent(run, bo, "giao", ins, "", frm);
  if (!allowHoi) return stripCmds(first) || first;
  const asks = parseCmds(first).filter(([c, k]) => c === "hoi" && k && k !== bo).slice(0, 2);
  if (!asks.length) return stripCmds(first) || first;
  const got = [];
  for (const [k, q] of asks) {
    const ans = await askAgent(
      run, k, "hoi",
      `${AGENTS[bo].ten} hỏi bạn: ${q}\nTrả lời đúng phần chuyên môn của bạn, ngắn gọn, không hỏi lại bộ khác.`,
      `Việc gốc của ${AGENTS[bo].ten}: ${taskText}`, bo
    );
    got.push(`- ${AGENTS[k].ten} trả lời câu "${q}":\n${stripCmds(ans) || ans}`);
  }
  const final = await askAgent(
    run, bo, "tra_loi",
    `Các bộ đã trả lời câu bạn hỏi. Dựa vào đó hoàn thiện kết quả cuối cho việc: ${taskText}\nKhông hỏi thêm bộ nào nữa.`,
    got.join("\n\n"), bo
  );
  return stripCmds(final) || final;
}

async function runBoGroup(run, giao) {
  const keys = giao.map(([k]) => k);
  const parallel = giao.length > 1 && new Set(keys).size === giao.length &&
    (keys.every(agentOnline) || readyTabCount() >= 2);
  if (!parallel) {
    const out = [];
    for (const [k, viec] of giao) out.push([k, await workBo(run, k, viec, "noicac")]);
    return out;
  }
  const results = await Promise.all(giao.map(async ([k, viec]) => [k, await workBo(run, k, viec, "noicac")]));
  return results;
}

async function runCourt(run) {
  try {
    const question = run.question;
    const to = run.to;
    if (to === "auto") {
      const plan = await askAgent(
        run, "noicac", "chia_viec",
        `Chủ Nhân ra lệnh cho bạn: ${question}\n\nHãy chọn các bộ cần làm (tối đa 4) và ban chỉ dụ xuống, mỗi bộ một dòng dạng:\n` +
          "@giao <mã bộ>: <việc cụ thể cho bộ đó>\n" +
          "Mã bộ: cong, le, ho, binh, hinh, lai. Nếu việc quá đơn giản không cần bộ nào, " +
          "trả lời thẳng cho Chủ Nhân bằng một dòng:\n@tau: <câu trả lời>"
      );
      const cmds = parseCmds(plan);
      const giao = cmds.filter(([c, k]) => c === "giao" && BO_KEYS.includes(k)).map(([, k, b]) => [k, b]).slice(0, 4);
      const direct = cmds.filter(([c]) => c === "tau").map(([, , b]) => b);
      if (!giao.length) {
        run.answer = direct[0] || stripCmds(plan) || plan;
        run.status = "done";
        return;
      }
      const results = await runBoGroup(run, giao);
      const ctx = results.map(([k, r]) => `### ${AGENTS[k].ten} làm xong:\n${r}`).join("\n\n");
      run.answer = stripCmds(await askAgent(
        run, "noicac", "tong_hop",
        `Chủ Nhân đã ra lệnh: ${question}\nCác bộ đã làm xong. Soạn bản tâu cuối cùng dâng Chủ Nhân: ` +
          "mở đầu một câu kết luận, rồi các ý chính theo từng bộ, rồi việc tiếp theo cần quyết. Gọn, rõ.",
        ctx
      ));
    } else {
      if (to !== "noicac" && !BO_KEYS.includes(to)) throw new StepFailed(`Không có bộ '${to}'`);
      run.answer = await workBo(run, to, question, "chu", false);
    }
    run.status = "done";
  } catch (e) {
    if (e instanceof RunCancelled) run.status = "cancelled";
    else if (e instanceof StepFailed) {
      run.status = "error";
      run.error = e.message;
    } else {
      run.status = "error";
      run.error = "Lỗi nội bộ: " + e.message;
    }
  } finally {
    run.finished = nowS();
    saveRuns();
  }
}

function startRun(question, to) {
  to = (to || "auto").trim();
  const rid = "run" + Date.now();
  const run = { id: rid, question: question.trim(), to, status: "running", steps: [], answer: "", error: "", started: nowS(), finished: 0 };
  runs.set(rid, run);
  runCourt(run); // chạy nền (không await) — giống luồng nền của Python
  return run;
}

function cancelRun(rid) {
  const r = runs.get(rid);
  if (r && r.status === "running") {
    r.status = "cancelled";
    const ids = new Set(r.steps.map((s) => s.id));
    for (let i = pending.length - 1; i >= 0; i--) if (ids.has(pending[i].id)) pending.splice(i, 1);
    for (const id of ids) jobstore.dropJob(id);
    return true;
  }
  return false;
}

function clearRuns() {
  for (const r of runs.values()) if (r.status === "running") r.status = "cancelled";
  const n = runs.size;
  runs.clear();
  for (const p of pending) jobstore.dropJob(p.id);
  pending.length = 0;
  tasks.clear();
  for (const t of tabs.values()) {
    if (t.busy) jobstore.clearBusy(t.id, t.busy);
    t.busy = null;
  }
  jobstore.wipe();
  try {
    fs.unlinkSync(RUNS_FILE);
  } catch (_) { /* không có file, bỏ qua */ }
  return n;
}

function saveRuns() {
  try {
    const data = Array.from(runs.values()).sort((a, b) => a.started - b.started).slice(-50);
    fs.writeFileSync(RUNS_FILE, JSON.stringify(data), "utf-8");
  } catch (_) { /* bỏ qua */ }
}

function loadRuns() {
  try {
    const arr = JSON.parse(fs.readFileSync(RUNS_FILE, "utf-8"));
    for (const r of arr) {
      if (r.status === "running") {
        r.status = "error";
        r.error = "Tool bị tắt giữa chừng.";
      }
      runs.set(r.id, r);
    }
  } catch (_) { /* chưa có file, bỏ qua */ }
}

loadRuns();
loadTabs();

module.exports = {
  HERE, ROOT, DATA, BRAIN_DIR, AGENTS, BO_KEYS, PROVIDERS, END_MARK,
  runs, tasks, pending, tabs,
  RunCancelled, StepFailed,
  readBrain, writeBrain, listBrains,
  listTabs, setTab, forgetTab, tabView, tabInfo, tabReady, agentOnline, onlineAgents, agentLabels,
  readyTabCount, autoAssign, onlineTabCount, bridgeOnline, takeTask, onResponse, cleanReply,
  askAgent, askTab, partialReply, startRun, cancelRun, clearRuns, saveRuns,
};
