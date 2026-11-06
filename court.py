"""Triều đình: điều phối các bộ (mỗi bộ = một "bộ não" nạp vào Muse) trả lời câu hỏi của Nhà Vua.

Luồng:
  Vua hỏi -> (Nội Các chia việc) -> từng bộ làm -> bộ có thể hỏi bộ khác (@hoi) -> bộ hoàn thiện
  -> (Nội Các tổng hợp) -> kết quả tâu về Vua.
Mỗi bước là một tin gửi vào Muse qua cầu nối (có kèm bộ não của bộ đó), đợi Muse trả lời xong mới sang bước sau.
"""
import json
import os
import re
import threading
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("MUSE_DATA") or HERE
BRAIN_DIR = os.path.join(DATA, "brains") if DATA != HERE else os.path.join(HERE, "brains")
RUNS_FILE = os.path.join(DATA, "court_runs.json")
if DATA != HERE and not os.path.isdir(BRAIN_DIR):
    import shutil
    try:
        shutil.copytree(os.path.join(HERE, "brains"), BRAIN_DIR)
    except OSError:
        pass

QUEUE_WAIT = 600       # giây chờ có tab rảnh nhận việc
STEP_TIMEOUT = 240      # giây chờ Muse trả lời mỗi bước
END_MARK = "###HET###"  # Muse được dặn kết thúc bằng dòng này để biết đã trả lời xong

AGENTS = {
    "noicac": {"ten": "Bệ Hạ", "chuc": "Vua điều hành triều đình"},
    "cong": {"ten": "Công Bộ", "chuc": "AI làm phim và video"},
    "le": {"ten": "Lễ Bộ", "chuc": "Xây kênh"},
    "ho": {"ten": "Hộ Bộ", "chuc": "Web và Google Ads"},
    "binh": {"ten": "Binh Bộ", "chuc": "Ads Facebook"},
    "hinh": {"ten": "Hình Bộ", "chuc": "Sale"},
    "lai": {"ten": "Lại Bộ", "chuc": "Hậu kỳ, edit video"},
}
BO_KEYS = ["cong", "le", "ho", "binh", "hinh", "lai"]

lock = threading.RLock()
runs = {}            # run_id -> run
tasks = {}           # task_id -> {"event", "text", "final", "step"}
pending = []         # [{"id", "text", "agent"}]  hàng đợi gửi sang cầu nối
bridge_seen = [0.0]


# ---------- bộ não ----------
def brain_path(key):
    return os.path.join(BRAIN_DIR, key + ".md")


def read_brain(key):
    try:
        with open(brain_path(key), "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        a = AGENTS.get(key, {})
        return "Bạn là %s (%s)." % (a.get("ten", key), a.get("chuc", ""))


def write_brain(key, text):
    if key not in AGENTS:
        raise KeyError(key)
    os.makedirs(BRAIN_DIR, exist_ok=True)
    with open(brain_path(key), "w", encoding="utf-8") as f:
        f.write(text.strip() + "\n")


def list_brains():
    return [{"key": k, "ten": v["ten"], "chuc": v["chuc"], "text": read_brain(k)} for k, v in AGENTS.items()]


# ---------- sổ tab Muse: mỗi trình duyệt / profile / tài khoản tự đăng ký, vai trò gán ngay trên giao diện ----------
FRESH = 5            # giây: tab im lặng quá lâu coi như mất kết nối
BUSY_MAX = 330       # giây: tab báo bận quá lâu thì tự giải phóng
tabs = {}            # tab_id -> thông tin tab
TABS_FILE = os.path.join(DATA, "court_tabs.json")


def _today():
    return time.strftime("%Y-%m-%d")


def save_tabs():
    try:
        keep = {k: {x: v[x] for x in ("id", "label", "roles", "limit", "paused", "done", "day", "provider")} for k, v in tabs.items()}
        with open(TABS_FILE, "w", encoding="utf-8") as f:
            json.dump(keep, f, ensure_ascii=False)
    except OSError:
        pass


def load_tabs():
    try:
        with open(TABS_FILE, "r", encoding="utf-8") as f:
            for k, v in json.load(f).items():
                if "roles" not in v:
                    v["roles"] = [v["agent"]] if v.get("agent") in AGENTS else []
                v.pop("agent", None)
                v.setdefault("provider", "muse")
                v.update({"seen": 0, "busy": None, "busy_since": 0, "first": time.time(), "flash": 0})
                tabs[k] = v
    except (OSError, ValueError):
        pass


def _roll(tab):
    if tab.get("day") != _today():
        tab["day"], tab["done"] = _today(), 0


def _alive(t, now=None):
    """Tab còn sống: vừa hỏi việc, hoặc đang bận làm một việc (lúc bận cầu nối không hỏi việc nên im lặng là bình thường)."""
    now = now or time.time()
    return (now - t["seen"]) < FRESH or bool(t.get("busy") and (now - t["busy_since"]) < BUSY_MAX)


def tab_ready(tab):
    """Tab dùng được ngay bây giờ (đang online, không tạm nghỉ, chưa hết hạn mức hôm nay)."""
    _roll(tab)
    if (time.time() - tab["seen"]) >= FRESH or tab["paused"]:
        return False
    return not (tab["limit"] and tab["done"] >= tab["limit"])


PROVIDERS = {"muse": "Muse", "chatgpt": "ChatGPT", "gemini": "Gemini", "claude": "Claude", "grok": "Grok", "other": "Bot"}


def next_label(provider="muse"):
    base = PROVIDERS.get(provider, "Bot")
    used = {t["label"] for t in tabs.values()}
    n = 1
    while "%s %d" % (base, n) in used:
        n += 1
    return "%s %d" % (base, n)


def touch_bridge(agent, tab_id=None, label="", provider=""):
    now = time.time()
    bridge_seen[0] = now
    tab_id = tab_id or ("anon-" + (agent or "*"))
    with lock:
        t = tabs.get(tab_id)
        if not t:
            provider = provider if provider in PROVIDERS else "muse"
            t = tabs[tab_id] = {"id": tab_id, "provider": provider, "label": next_label(provider), "roles": [agent] if agent in AGENTS else [],
                                "limit": 0, "paused": False, "done": 0, "day": _today(), "seen": now, "busy": None,
                                "busy_since": 0, "first": now, "flash": 0}
            save_tabs()
        t["seen"] = now
        if provider in PROVIDERS and t.get("provider") != provider:
            t["provider"] = provider
        if t["busy"] and now - t["busy_since"] > BUSY_MAX:
            t["busy"] = None
        _roll(t)
    return t


def set_tab(tab_id, data):
    with lock:
        t = tabs.get(tab_id)
        if not t:
            return None
        if "label" in data:
            t["label"] = str(data["label"])[:40] or t["label"]
        if "roles" in data:
            t["roles"] = [r for r in AGENTS if r in (data["roles"] or [])]
        elif "agent" in data:
            t["roles"] = [data["agent"]] if data["agent"] in AGENTS else []
        if data.get("flash"):
            t["flash"] = time.time() + 8
        if "limit" in data:
            try:
                t["limit"] = max(0, int(data["limit"]))
            except (TypeError, ValueError):
                pass
        if "paused" in data:
            t["paused"] = bool(data["paused"])
        if data.get("reset_done"):
            t["done"] = 0
        save_tabs()
        return t


def forget_tab(tab_id):
    with lock:
        if tab_id in tabs and (time.time() - tabs[tab_id]["seen"]) >= FRESH:
            del tabs[tab_id]
            save_tabs()
            return True
    return False


def tab_view(t):
    _roll(t)
    now = time.time()
    if not _alive(t, now):
        st = "offline"
    elif t["paused"]:
        st = "paused"
    elif t["limit"] and t["done"] >= t["limit"]:
        st = "quota"
    elif t["busy"]:
        st = "busy"
    else:
        st = "idle"
    return {"id": t["id"], "provider": t.get("provider", "muse"), "label": t["label"], "roles": t["roles"], "limit": t["limit"], "paused": t["paused"],
            "done": t["done"], "state": st, "age": round(now - t["seen"], 1)}


def list_tabs():
    with lock:
        return sorted((tab_view(t) for t in tabs.values()), key=lambda x: (x["state"] == "offline", x["label"]))


def agent_online(agent):
    """Có tab đang online được gán đúng bộ này (kể cả đang bận)?"""
    now = time.time()
    with lock:
        for t in tabs.values():
            _roll(t)
            if agent in t["roles"] and _alive(t, now) and not t["paused"] and not (t["limit"] and t["done"] >= t["limit"]):
                return True
        return False


def online_agents():
    return [k for k in AGENTS if agent_online(k)]


def agent_labels():
    """bộ -> tên các tab (tài khoản) đang online được gán bộ đó"""
    now = time.time()
    out = {}
    with lock:
        for t in tabs.values():
            if _alive(t, now):
                for r in t["roles"]:
                    out.setdefault(r, []).append(t["label"])
    return out


def tab_info(tab_id):
    """Thông tin gửi ngược cho cầu nối để tab tự hiện huy hiệu (tên tab + vai) và nhấp nháy khi được gọi."""
    t = tabs.get(tab_id)
    if not t:
        return None
    return {"label": t["label"], "roles": [AGENTS[r]["ten"] for r in t["roles"]], "flash": t.get("flash", 0) > time.time()}


def ready_tab_count():
    with lock:
        return sum(1 for t in tabs.values() if tab_ready(t))


def auto_assign():
    """Chia đều 7 vai cho các tab đang online (mỗi tab giữ một vài vai)."""
    now = time.time()
    with lock:
        live = sorted((t for t in tabs.values() if _alive(t, now)), key=lambda t: t["first"])
        if not live:
            return 0
        for t in live:
            t["roles"] = []
        for i, k in enumerate(["noicac", "cong", "le", "ho", "binh", "hinh", "lai"]):
            live[i % len(live)]["roles"].append(k)
        save_tabs()
        return len(live)


def online_tab_count():
    now = time.time()
    return sum(1 for t in tabs.values() if _alive(t, now))


def bridge_online():
    return (time.time() - bridge_seen[0]) < FRESH or any(t.get("busy") for t in tabs.values() if _alive(t))


def take_task(tab_id, agent=None, label="", provider=""):
    """Tab hỏi việc. Tab được gán bộ nào lấy việc của bộ đó. Tab tự do lấy việc của bộ chưa có tab riêng.
    Nhiều tab cùng một bộ thì tab nào rảnh trước lấy trước."""
    tab = touch_bridge(agent, tab_id, label, provider)
    with lock:
        if tab["busy"] or not tab_ready(tab):
            return None
        for i, t in enumerate(pending):
            want = t.get("agent") or ""
            if t.get("tab"):                       # việc của sân chơi: đích danh một tab
                ok = t["tab"] == tab["id"]
            else:                                   # việc của triều đình: tab tự do chỉ là tab Muse
                ok = want in tab["roles"] or (not tab["roles"] and tab.get("provider", "muse") == "muse" and not agent_online(want))
            if ok:
                task = pending.pop(i)
                tab["busy"], tab["busy_since"] = task["id"], time.time()
                if task["id"] in tasks:
                    tasks[task["id"]]["taken"] = time.time()
                    st = tasks[task["id"]].get("step")
                    if st is not None:
                        st["tab"] = tab["label"]      # tài khoản Muse nào đang làm bước này
                return task
    return None


def on_response(task_id, text, is_final):
    """Trả True nếu tin này thuộc về triều đình."""
    with lock:
        t = tasks.get(task_id)
        if not t:
            return False
        t["text"] = text
        step = t.get("step")
        if step is not None:
            step["reply"] = clean_reply(text)
            if is_final:
                step["status"] = "done"
        if is_final:
            t["final"] = True
            t["event"].set()
            for tb in tabs.values():
                if tb["busy"] == task_id:
                    tb["busy"] = None
                    _roll(tb)
                    tb["done"] += 1
            save_tabs()
        return True


def clean_reply(text):
    text = (text or "").replace(END_MARK, "").strip()
    return text


# ---------- dựng tin gửi Muse ----------
def build_prompt(task_id, agent, instruction, context=""):
    a = AGENTS[agent]
    parts = [
        "[[T-%s]]" % task_id,
        "ĐÂY LÀ TIN TỰ ĐỘNG TỪ HỆ THỐNG, KHÔNG CÓ NGƯỜI TRẢ LỜI NGAY. Tuyệt đối KHÔNG hỏi lại, KHÔNG xin xác nhận, KHÔNG tạo tác vụ hay task, KHÔNG dùng công cụ nào. Thiếu thông tin thì tự đặt giả định hợp lý, ghi rõ giả định rồi trả lời luôn ngay trong khung chat.",
        "Từ lúc này bạn nhập vai %s (%s) trong triều đình. Quên các vai trước đó trong cuộc trò chuyện này." % (a["ten"], a["chuc"]),
        "=== BỘ NÃO CỦA BẠN ===",
        read_brain(agent),
        "=== HẾT BỘ NÃO ===",
    ]
    if context:
        parts += ["=== BỐI CẢNH ===", context.strip(), "=== HẾT BỐI CẢNH ==="]
    parts += [
        "=== VIỆC CẦN LÀM ===",
        instruction.strip(),
        "=== HẾT VIỆC ===",
        "Chỉ trả lời bằng chữ ngay trong khung chat, không hỏi lại, không mở tác vụ hay công cụ nào khác. Tiếng Việt, gọn, đúng chuyên môn.",
        "Khi đã trả lời xong, viết đúng một dòng cuối cùng: %s" % END_MARK,
        "[[/T-%s]]" % task_id,
    ]
    return "\n".join(parts)


class RunCancelled(Exception):
    pass


class StepFailed(Exception):
    pass


def ask_agent(run, agent, kind, instruction, context="", frm="chu"):
    """Gửi một bước vào Muse, chờ trả lời xong, trả về chữ."""
    if run["status"] == "cancelled":
        raise RunCancelled()
    task_id = "c%d" % int(time.time() * 1000)
    # tránh trùng id khi hai bước cùng mili giây
    with lock:
        while task_id in tasks:
            task_id += "x"
        step = {
            "id": task_id, "from": frm, "to": agent, "kind": kind,
            "ask": instruction.strip(), "reply": "", "status": "running", "ts": time.time(),
        }
        run["steps"].append(step)
        ev = threading.Event()
        tasks[task_id] = {"event": ev, "text": "", "final": False, "step": step}
        pending.append({"id": task_id, "text": build_prompt(task_id, agent, instruction, context), "agent": agent})
    queued_at = time.time()
    while not ev.wait(0.5):
        if run["status"] == "cancelled":
            step["status"] = "cancelled"
            raise RunCancelled()
        taken = tasks[task_id].get("taken")
        # đồng hồ chỉ chạy từ lúc có tab nhận việc; còn xếp hàng đợi tab rảnh thì được chờ lâu hơn
        if taken and time.time() > taken + STEP_TIMEOUT:
            step["status"] = "timeout"
            raise StepFailed("%s không trả lời kịp (quá %d giây)" % (AGENTS[agent]["ten"], STEP_TIMEOUT))
        if not taken and time.time() > queued_at + QUEUE_WAIT:
            step["status"] = "timeout"
            with lock:
                pending[:] = [p for p in pending if p["id"] != task_id]
            raise StepFailed("Không có tab Muse nào nhận việc của %s (quá %d giây). Kiểm tra tab đã nối và đang rảnh chưa." % (AGENTS[agent]["ten"], QUEUE_WAIT))
    step["status"] = "done"
    return step["reply"]


def ask_tab(tab_id, build, stop=None, queue_wait=180, raw=False):
    """Gửi một tin tới đúng một tab, chờ trả lời xong. build(task_id) -> nội dung tin. Trả (task_id, chữ)."""
    with lock:
        task_id = "a%d" % int(time.time() * 1000)
        while task_id in tasks:
            task_id += "x"
        ev = threading.Event()
        tasks[task_id] = {"event": ev, "text": "", "final": False, "step": None}
        pending.append({"id": task_id, "text": build(task_id), "agent": "", "tab": tab_id, "raw": raw})
    queued = time.time()
    while not ev.wait(0.5):
        if stop and stop():
            with lock:
                pending[:] = [p for p in pending if p["id"] != task_id]
                tb = tabs.get(tab_id)
                if tb and tb.get("busy") == task_id:
                    tb["busy"] = None
            raise RunCancelled()
        taken = tasks[task_id].get("taken")
        if taken and time.time() > taken + STEP_TIMEOUT:
            with lock:
                tb = tabs.get(tab_id)
                if tb and tb.get("busy") == task_id:
                    tb["busy"] = None
            raise StepFailed("quá %d giây không trả lời" % STEP_TIMEOUT)
        if not taken and time.time() > queued + queue_wait:
            with lock:
                pending[:] = [p for p in pending if p["id"] != task_id]
            raise StepFailed("tab không nhận việc (tắt hoặc đang bận quá %d giây)" % queue_wait)
    return task_id, clean_reply(tasks[task_id]["text"])


def partial_reply(task_id):
    t = tasks.get(task_id)
    return clean_reply(t["text"]) if t else ""


# ---------- đọc lệnh trong câu trả lời ----------
def norm(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").replace("đ", "d")
    return re.sub(r"[^a-z ]", "", s).strip()


def resolve_key(raw):
    n = norm(raw)
    if n in AGENTS:
        return n
    for k, v in AGENTS.items():
        if norm(v["ten"]) == n or norm(v["ten"]) in n:
            return k
    return None


CMD_RE = re.compile(r"^\W*@(giao|hoi|tau)\b\s*([^:：\n]*?)\s*[:：]\s*(.+)$", re.I)


def parse_cmds(text):
    """Trả danh sách (lệnh, bộ, nội dung) từ các dòng bắt đầu bằng @giao / @hoi / @tau."""
    out = []
    for line in (text or "").replace("**", "").replace("`", "").splitlines():
        m = CMD_RE.match(line.strip())
        if not m:
            continue
        cmd, who, body = m.group(1).lower(), m.group(2).strip(), m.group(3).strip()
        key = resolve_key(who) if who else None
        out.append((cmd, key, body))
    return out


def strip_cmds(text):
    keep = [ln for ln in (text or "").splitlines() if not CMD_RE.match(ln.replace("**", "").replace("`", "").strip())]
    return "\n".join(keep).strip()


# ---------- điều phối ----------
def who(frm):
    return {"chu": "Chủ Nhân", "vua": "Chủ Nhân"}.get(frm) or AGENTS.get(frm, {}).get("ten", frm)


def work_bo(run, bo, task_text, frm, allow_hoi=True):
    """Một bộ làm việc; được phép hỏi tối đa 2 bộ khác (một vòng) rồi hoàn thiện."""
    others = ", ".join("%s=%s" % (k, AGENTS[k]["ten"]) for k in BO_KEYS if k != bo)
    ins = (
        "%s giao việc cho bạn:\n%s\n\n"
        "Nếu tự làm được thì trả lời kết quả luôn. Nếu cần bộ khác hỗ trợ trước khi hoàn thành, "
        "CHƯA trả lời kết quả, chỉ viết tối đa 2 dòng dạng:\n@hoi <mã bộ>: <câu hỏi cụ thể>\n"
        "Mã bộ có thể dùng: %s." % (who(frm), task_text, others)
    )
    if not allow_hoi:
        # hỏi thẳng một con: chỉ con đó trả lời, không gọi bộ khác
        ins = "%s hỏi bạn:\n%s\n\nTrả lời trực tiếp theo đúng chuyên môn của bạn, không hỏi lại bộ khác." % (who(frm), task_text)
    first = ask_agent(run, bo, "giao", ins, frm=frm)
    if not allow_hoi:
        return strip_cmds(first) or first
    asks = [(k, b) for c, k, b in parse_cmds(first) if c == "hoi" and k and k != bo][:2]
    if not asks:
        return strip_cmds(first) or first
    got = []
    for k, q in asks:
        ans = ask_agent(run, k, "hoi",
                        "%s hỏi bạn: %s\nTrả lời đúng phần chuyên môn của bạn, ngắn gọn, không hỏi lại bộ khác." % (AGENTS[bo]["ten"], q),
                        context="Việc gốc của %s: %s" % (AGENTS[bo]["ten"], task_text), frm=bo)
        got.append("- %s trả lời câu \"%s\":\n%s" % (AGENTS[k]["ten"], q, strip_cmds(ans) or ans))
    final = ask_agent(run, bo, "tra_loi",
                      "Các bộ đã trả lời câu bạn hỏi. Dựa vào đó hoàn thiện kết quả cuối cho việc: %s\n"
                      "Không hỏi thêm bộ nào nữa." % task_text,
                      context="\n\n".join(got), frm=bo)
    return strip_cmds(final) or final


def run_bo_group(run, giao):
    """Giao cho nhiều bộ. Nếu mỗi bộ có tab Muse riêng đang mở thì các bộ làm song song, không thì làm lần lượt."""
    now = time.time()
    # làm song song khi có ít nhất 2 tab sẵn sàng (tab riêng của bộ hoặc tab tự do); việc thừa tự xếp hàng chờ tab rảnh
    parallel = len(giao) > 1 and len({k for k, _ in giao}) == len(giao) and (all(agent_online(k) for k, _ in giao) or ready_tab_count() >= 2)
    if not parallel:
        return [(k, work_bo(run, k, viec, "noicac")) for k, viec in giao]
    results, errs = [None] * len(giao), []

    def job(i, k, viec):
        try:
            results[i] = (k, work_bo(run, k, viec, "noicac"))
        except Exception as e:  # noqa
            errs.append(e)
    ths = [threading.Thread(target=job, args=(i, k, v), daemon=True) for i, (k, v) in enumerate(giao)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    if errs:
        raise errs[0]
    return results


def run_court(run):
    try:
        question, to = run["question"], run["to"]
        results = []
        if to == "auto":
            plan = ask_agent(
                run, "noicac", "chia_viec",
                "Chủ Nhân ra lệnh cho bạn: %s\n\nHãy chọn các bộ cần làm (tối đa 4) và ban chỉ dụ xuống, mỗi bộ một dòng dạng:\n"
                "@giao <mã bộ>: <việc cụ thể cho bộ đó>\n"
                "Mã bộ: cong, le, ho, binh, hinh, lai. Nếu việc quá đơn giản không cần bộ nào, "
                "trả lời thẳng cho Chủ Nhân bằng một dòng:\n@tau: <câu trả lời>" % question)
            cmds = parse_cmds(plan)
            giao = [(k, b) for c, k, b in cmds if c == "giao" and k in BO_KEYS][:4]
            direct = [b for c, k, b in cmds if c == "tau"]
            if not giao:
                run["answer"] = (direct[0] if direct else strip_cmds(plan) or plan)
                run["status"] = "done"
                return
            results = run_bo_group(run, giao)
            ctx = "\n\n".join("### %s làm xong:\n%s" % (AGENTS[k]["ten"], r) for k, r in results)
            run["answer"] = strip_cmds(ask_agent(
                run, "noicac", "tong_hop",
                "Chủ Nhân đã ra lệnh: %s\nCác bộ đã làm xong. Soạn bản tâu cuối cùng dâng Chủ Nhân: "
                "mở đầu một câu kết luận, rồi các ý chính theo từng bộ, rồi việc tiếp theo cần quyết. Gọn, rõ." % question,
                context=ctx))
        else:
            if to != "noicac" and to not in BO_KEYS:
                raise StepFailed("Không có bộ '%s'" % to)
            # hỏi thẳng Bệ Hạ hoặc một bộ: chỉ con đó trả lời
            run["answer"] = work_bo(run, to, question, "chu", allow_hoi=False)
        run["status"] = "done"
    except RunCancelled:
        run["status"] = "cancelled"
    except StepFailed as e:
        run["status"] = "error"
        run["error"] = str(e)
    except Exception as e:  # noqa
        run["status"] = "error"
        run["error"] = "Lỗi nội bộ: %s" % e
    finally:
        run["finished"] = time.time()
        save_runs()


def start_run(question, to):
    to = (to or "auto").strip()
    with lock:
        rid = "run%d" % int(time.time() * 1000)
        run = {"id": rid, "question": question.strip(), "to": to, "status": "running",
               "steps": [], "answer": "", "error": "", "started": time.time(), "finished": 0}
        runs[rid] = run
    threading.Thread(target=run_court, args=(run,), daemon=True).start()
    return run


def cancel_run(rid):
    r = runs.get(rid)
    if r and r["status"] == "running":
        r["status"] = "cancelled"
        with lock:
            ids = {s["id"] for s in r["steps"]}
            pending[:] = [p for p in pending if p["id"] not in ids]
        return True
    return False


def clear_runs():
    """Hủy mọi chỉ dụ đang chạy, xóa lịch sử, hàng đợi và trạng thái bận của các tab."""
    with lock:
        for r in runs.values():
            if r["status"] == "running":
                r["status"] = "cancelled"
        n = len(runs)
        runs.clear()
        pending[:] = []
        tasks.clear()
        for t in tabs.values():
            t["busy"] = None
    try:
        os.remove(RUNS_FILE)
    except OSError:
        pass
    return n


def save_runs():
    try:
        data = sorted(runs.values(), key=lambda r: r["started"])[-50:]
        with open(RUNS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except OSError:
        pass


def load_runs():
    try:
        with open(RUNS_FILE, "r", encoding="utf-8") as f:
            for r in json.load(f):
                if r.get("status") == "running":
                    r["status"] = "error"
                    r["error"] = "Tool bị tắt giữa chừng."
                runs[r["id"]] = r
    except (OSError, ValueError):
        pass


load_runs()
load_tabs()
