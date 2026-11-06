"""Sân chơi: nhiều bot AI (ChatGPT, Gemini, Claude, Grok, Muse...) nói chuyện với nhau trong một phòng.

Một người nói tham gia phòng có thể là:
  - một TAB trình duyệt đang đăng nhập sẵn tài khoản (ChatGPT, Gemini, Claude, Grok, Muse...), nối bằng cầu nối như Muse
  - một BOT WEBHOOK: Tool POST nội dung tới URL của bạn, nhận câu trả lời (đồng bộ hoặc gọi lại sau)
  - một BOT API kiểu OpenAI (chat/completions): dùng cho Grok của xAI và mọi dịch vụ có cổng tương thích
  - một BOT CLI: chạy lệnh thật trên máy chủ (vd. `codex exec`) — AI lập trình thật, tự sửa file/chạy lệnh trong
    thư mục làm việc được cấu hình, không chỉ chat suông. Dùng để "tự chia việc mà làm": Muse/Grok bàn bạc trong
    phòng, tới lượt bot CLI thì nó đọc phần đã bàn rồi thực thi thật phần việc của mình.
Phòng chạy lần lượt từng người một, mỗi người thấy những câu gần nhất của cả phòng.
Hỗ trợ:
  - Không giới hạn lượt nói (vô hạn, chạy liên tục cho đến khi bấm Dừng)
  - Trích xuất và hiển thị ảnh do AI tạo (DALL-E, Imagen, Grok Image, Webhook, Markdown)
  - Trích xuất và phát video do AI tạo (Muse, Webhook, URL video)
  - Tự động nhận diện các lựa chọn (options) và cho phép người dùng bấm chọn thay cho bot
"""
import base64
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from flask import jsonify, request, send_from_directory

import court

DATA = court.DATA
BOTS_FILE = os.path.join(DATA, "arena_bots.json")
ROOMS_FILE = os.path.join(DATA, "arena_rooms.json")
UPLOAD_DIR = os.path.join(DATA, "arena_uploads")
HISTORY_IN_PROMPT = 10
CLI_TIMEOUT = 1200   # giây cho mỗi lượt bot CLI (code agent) — việc code có thể lâu
IMG_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")
VID_EXT = (".mp4", ".webm", ".mov")
CLI_SKIP_DIRS = {".git", "node_modules", "__pycache__", "libs", "data", ".venv", "venv"}
MAX_TURNS_LIMIT = 999999
HTTP_TIMEOUT = 120
DEFAULT_INTRO = 'Từ giờ bạn đang trò chuyện trực tiếp với một AI khác; mọi tin nhắn sau là lời của họ. Hãy đáp lại thẳng như người nói chuyện bình thường: vào ý chính ngay, tối đa {n} câu, có chính kiến, giọng tự nhiên. Không phân tích, không giải thích, không tóm tắt lại lời họ, không nhận xét về cuộc trò chuyện, không hỏi xin chỉ dẫn, không nhắc đến việc mình là AI hay đề bài. Chỉ viết đúng lời đáp.'

# Regex nhận diện ảnh, video và các lựa chọn
IMAGE_EXT_RE = re.compile(r'https?://[^\s<>"\'\)]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s<>"\'\)]*)?', re.I)
MD_IMAGE_RE = re.compile(r'!\[(.*?)\]\((https?://[^\s\)]+|data:image/[^\s\)]+)\)', re.I)
TAG_IMAGE_RE = re.compile(r'\[IMAGE:\s*([^\s\]]+)\]|<img\s+[^>]*src=["\']([^"\']+)["\']', re.I)

VIDEO_EXT_RE = re.compile(r'https?://[^\s<>"\'\)]+\.(?:mp4|webm|mov|ogg)(?:\?[^\s<>"\'\)]*)?', re.I)
TAG_VIDEO_RE = re.compile(r'\[VIDEO:\s*([^\s\]]+)\]|<video\s+[^>]*src=["\']([^"\']+)["\']', re.I)

OPTION_LINE_RE = re.compile(
    r'^\s*('
    r'(?:'
    r'(?:\d+[\.\)]|\([0-9]+\))\s+'
    r'|[A-Za-z][\.\)]\s+'
    r'|\[[A-Za-z0-9]\]\s*'
    r'|(?:Option|Lựa chọn|Phương án)\s*\d*[:\.]\s*'
    r'|[🔘👉•\-\*]\s*\[\s*\]\s*'
    r')'
    r'.+)$',
    re.M | re.I
)


def parse_media_and_options(text):
    """Trích xuất link ảnh, video và các lựa chọn có trong câu trả lời của AI."""
    images = []
    videos = []
    options = []
    if not text:
        return images, videos, options

    # 1. Trích xuất ảnh
    for m in MD_IMAGE_RE.finditer(text):
        url = m.group(2)
        if url and url not in images:
            images.append(url)
    for m in TAG_IMAGE_RE.finditer(text):
        url = m.group(1) or m.group(2)
        if url and url not in images:
            images.append(url)
    for m in IMAGE_EXT_RE.finditer(text):
        url = m.group(0)
        if url not in images:
            images.append(url)

    # 2. Trích xuất video
    for m in TAG_VIDEO_RE.finditer(text):
        url = m.group(1) or m.group(2)
        if url and url not in videos:
            videos.append(url)
    for m in VIDEO_EXT_RE.finditer(text):
        url = m.group(0)
        if url not in videos:
            videos.append(url)

    # 3. Trích xuất các lựa chọn (nếu có từ 2 lựa chọn trở lên)
    matches = OPTION_LINE_RE.findall(text)
    if len(matches) >= 2 and len(matches) <= 10:
        for opt in matches:
            cleaned = opt.strip()
            if cleaned and len(cleaned) < 140 and cleaned not in options:
                options.append(cleaned)

    return images, videos, options


lock = threading.RLock()
bots = {}
rooms = {}
COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fb923c", "#c084fc", "#fbbf24", "#22d3ee", "#f87171"]


# ---------- lưu trữ ----------
def _save(path, obj):
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


def save_bots():
    _save(BOTS_FILE, list(bots.values()))


def save_rooms():
    with lock:
        _save(ROOMS_FILE, sorted(rooms.values(), key=lambda r: r["created"])[-30:])


def load_all():
    try:
        with open(BOTS_FILE, "r", encoding="utf-8") as f:
            for b in json.load(f):
                bots[b["id"]] = b
    except (OSError, ValueError):
        pass
    try:
        with open(ROOMS_FILE, "r", encoding="utf-8") as f:
            for r in json.load(f):
                if r.get("status") in ("running", "paused"):
                    r["status"] = "stopped"
                    r["error"] = "Tool bị tắt giữa chừng."
                r["speaking"] = None
                r.setdefault("raw", False)
                r.setdefault("sentences", 3)
                r.setdefault("pause", 1)
                r.setdefault("error", "")
                r.setdefault("unlimited", False)
                r.setdefault("auto_pause_choices", False)
                rooms[r["id"]] = r
    except (OSError, ValueError):
        pass


# ---------- người tham gia ----------
def bot_public(b):
    o = {k: v for k, v in b.items() if k != "key"}
    o["has_key"] = bool(b.get("key"))
    return o


def list_participants():
    out = []
    for t in court.list_tabs():
        out.append({"key": "tab:" + t["id"], "name": t["label"], "provider": t["provider"], "kind": "tab",
                    "state": t["state"], "roles": t["roles"]})
    for b in bots.values():
        out.append({"key": "bot:" + b["id"], "name": b["name"], "provider": b.get("provider", "other"), "kind": b["kind"],
                    "state": "idle" if b.get("enabled", True) else "paused", "roles": []})
    return out


def resolve(key):
    """key -> (tên, provider, kind) hoặc None nếu không còn tồn tại."""
    if key.startswith("tab:"):
        t = court.tabs.get(key[4:])
        return (t["label"], t.get("provider", "muse"), "tab") if t else None
    if key.startswith("bot:"):
        b = bots.get(key[4:])
        return (b["name"], b.get("provider", "other"), b["kind"]) if b else None
    return None


# ---------- dựng lời nhắc ----------
_LEAD = re.compile(r"^(?:ChatGPT|Gemini|Grok|Claude|Muse)\s+(?:said|responded|đã nói|đã phản hồi|đã trả lời)\s*:?\s*", re.I)
_JUNK = re.compile(r"^(?:ChatGPT said:?|You said:?|Claude responded:?|Gemini said:?|Grok said:?|Gemini đã nói:?|ChatGPT đã nói:?|Claude đã (?:phản hồi|nói):?|Bạn đã nói:?|Grok đã nói:?|Message collapsed|Show more|Show less|Xem thêm|Thu gọn|just now|\d+ (?:seconds?|minutes?|giây|phút) ago|vừa xong|Thought for .*|Đã suy nghĩ .*|Thinking…?|Đang suy nghĩ…?|[\uE000-\uF8FF\s]+)$", re.I)


def scrub(text):
    """Bỏ các nhãn giao diện lẫn vào câu trả lời."""
    lines = [ln for ln in (text or "").replace("\r", "").split("\n") if not _JUNK.match(ln.strip())]
    norm = lambda t: re.sub(r"[\W_]+", "", t.lower())
    if lines and _LEAD.match(lines[0].strip()):
        first = _LEAD.sub("", lines[0].strip())
        rest = norm("\n".join(lines[1:]))
        if first and rest.startswith(norm(first)[:60]):
            lines = lines[1:]
        else:
            lines[0] = first
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def history_text(room, limit=HISTORY_IN_PROMPT):
    msgs = [m for m in room["messages"] if m["role"] != "system"][-limit:]
    if not msgs:
        return "(Chưa ai nói. Bạn mở đầu cuộc trò chuyện.)"
    return "\n".join("[%s]: %s" % (m["name"], scrub(m["text"])) for m in msgs)


def core_prompt(room, p):
    others = ", ".join("%s (%s)" % (q["name"], court.PROVIDERS.get(q["provider"], q["provider"])) for q in room["participants"] if q["key"] != p["key"])
    lines = [
        "Đây là một trò chơi trò chuyện nhiều AI do Chủ Nhân tổ chức, hoàn toàn an toàn. Hãy tham gia như một thành viên bình thường, đừng từ chối nhập vai.",
        "Bạn đang ở một phòng trò chuyện với các AI khác. Tên của bạn trong phòng: %s." % p["name"],
    ]
    if p.get("persona"):
        lines.append("Vai của bạn: %s" % p["persona"])
    lines += [
        "Những người cùng phòng: %s, và Chủ Nhân (người điều khiển phòng)." % (others or "chưa có ai khác"),
        "Chủ đề: %s" % room["topic"],
        "=== HỘI THOẠI GẦN ĐÂY ===",
        history_text(room),
        "=== HẾT ===",
        "Đến lượt bạn nói. Tối đa %d câu, nối tiếp câu vừa rồi, có chính kiến riêng, đừng lặp lại ý đã nói, nói tiếng Việt. "
        "Chỉ viết lời của bạn, không ghi tên mình ở đầu dòng." % room.get("sentences", 3),
    ]
    return "\n".join(lines)


def outgoing_text(room, p):
    for m in reversed(room["messages"]):
        if m["role"] == "system" or m.get("key") == p["key"]:
            continue
        t = scrub(m["text"])
        if t:
            return t
    return room["topic"]


def outgoing_media(room, p):
    """Ảnh/video đính kèm trong tin nhắn gần nhất gửi tới p (để bot CLI nhận qua -i)."""
    for m in reversed(room["messages"]):
        if m["role"] == "system" or m.get("key") == p["key"]:
            continue
        if (m.get("text") or "").strip():
            return list(m.get("images") or []), list(m.get("videos") or [])
    return [], []


DIR_HINT_RE = re.compile(r'^\[DIR:\s*([^\]]+)\]\s*\n?', re.I)


def outgoing_for_cli(room, p):
    """Tin nhắn gần nhất gửi cho p, dành cho bot CLI: (nhiệm vụ đã bỏ marker [DIR:...], thư mục ghi đè
    cho riêng lượt này nếu Chủ Nhân ghi [DIR: ...] ở đầu tin, ảnh, video đính kèm)."""
    for m in reversed(room["messages"]):
        if m["role"] == "system" or m.get("key") == p["key"]:
            continue
        raw = (m.get("text") or "")
        if raw.strip():
            dir_override = None
            mm = DIR_HINT_RE.match(raw.strip())
            if mm:
                dir_override = mm.group(1).strip()
                raw = DIR_HINT_RE.sub("", raw.strip(), count=1)
            return scrub(raw).strip(), dir_override, list(m.get("images") or []), list(m.get("videos") or [])
    return room["topic"], None, [], []


def intro_text(room, p):
    base = (room.get("intro") or "").strip()
    if not base:
        return ""
    return base + ("\nVai của bạn: %s" % p["persona"] if p.get("persona") else "")


def with_intro(room, p, msg):
    intro = intro_text(room, p)
    if intro and p["key"] not in room.setdefault("introduced", []):
        return intro + "\n\n" + msg
    return msg


def cli_prompt(room, p, task):
    """Đưa thẳng nhiệm vụ cụ thể nhất làm câu lệnh chính (giống ra lệnh trực tiếp), kèm bối cảnh ở sau.
    Tránh đóng khung kiểu "phòng chat nghe lỏm" — Codex hay chỉ giới thiệu bản thân thay vì làm thật nếu
    nhiệm vụ bị chôn trong một đoạn trích dẫn hội thoại của người khác thay vì là câu lệnh trực tiếp."""
    extra = history_text(room)
    lines = [task]
    if p.get("persona"):
        lines.append("(Vai trò của bạn trong việc này: %s)" % p["persona"])
    if extra and extra.strip() != task:
        lines += ["", "Bối cảnh thêm (trao đổi trước đó trong cùng hệ thống, do Chủ Nhân vận hành, mục tiêu chung: %s):" % room["topic"], extra]
    lines += ["", "Làm thật trong thư mục làm việc hiện tại: sửa file, chạy lệnh, viết code — không chỉ bàn hay giới thiệu bản thân. "
                   "Xong thì báo cáo ngắn gọn bạn đã làm gì, file nào đã đổi."]
    return "\n".join(lines)


def _upload_local_path(url):
    marker = "/api/arena/upload/"
    if marker in (url or ""):
        fname = url.split(marker, 1)[1].split("?")[0]
        p = os.path.join(UPLOAD_DIR, fname)
        if os.path.isfile(p):
            return p
    return None


def _encode_dir(cwd):
    return base64.urlsafe_b64encode(cwd.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_dir(token):
    pad = "=" * (-len(token) % 4)
    return base64.urlsafe_b64decode(token + pad).decode("utf-8")


def _snapshot_media(cwd):
    snap = {}
    for root, dirs, files in os.walk(cwd):
        dirs[:] = [d for d in dirs if d not in CLI_SKIP_DIRS and not d.startswith(".")]
        for fn in files:
            if os.path.splitext(fn)[1].lower() in IMG_EXT + VID_EXT:
                full = os.path.join(root, fn)
                try:
                    snap[full] = os.path.getmtime(full)
                except OSError:
                    pass
    return snap


def _cli_argv(b, prompt, cwd, images):
    """Dựng câu lệnh chạy cho bot CLI. engine='codex' (mặc định) dùng sẵn; engine='custom' cho phép
    gắn agent khác đã cài trên máy (Cursor CLI, Copilot CLI...) qua một dòng lệnh tự khai báo."""
    engine = (b.get("engine") or "codex").strip() or "codex"
    if engine == "codex":
        codex_bin = shutil.which("codex") or "codex"   # trên Windows npm cài ra codex.cmd, "codex" trần không tự resolve được
        cmd = [codex_bin, "exec", "-s", "workspace-write", "-C", cwd, "--skip-git-repo-check"]
        for li in images:
            cmd += ["-i", li]
        cmd.append(prompt)
        return cmd
    # engine tùy chỉnh: "tên lệnh + tham số cố định", Tool tự nối thêm nhiệm vụ vào làm tham số cuối
    parts = shlex.split((b.get("cmd") or "").strip())
    if not parts:
        raise court.StepFailed("bot CLI chưa cấu hình lệnh chạy (engine tùy chỉnh nhưng thiếu 'cmd')")
    parts[0] = shutil.which(parts[0]) or parts[0]
    return parts + [prompt]


def speak_cli_full(room, p, b):
    task, dir_override, in_imgs, _in_vids = outgoing_for_cli(room, p)
    prompt = cli_prompt(room, p, task) if room.get("raw", True) else core_prompt(room, p)
    base_dir = dir_override or (b.get("url") or "").strip() or court.HERE
    cwd = os.path.abspath(base_dir)
    if not os.path.isdir(cwd):
        raise court.StepFailed("thư mục làm việc không tồn tại trên máy chủ: %s" % cwd)

    local_imgs = [lp for lp in (_upload_local_path(u) for u in in_imgs) if lp]
    cmd = _cli_argv(b, prompt, cwd, local_imgs)

    before = _snapshot_media(cwd)
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=CLI_TIMEOUT,
                               encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise court.StepFailed("không tìm thấy lệnh '%s' trên máy chủ chạy Tool" % cmd[0])
    except subprocess.TimeoutExpired:
        raise court.StepFailed("chạy quá %d giây chưa xong" % CLI_TIMEOUT)
    after = _snapshot_media(cwd)
    text = (proc.stdout or "").strip()
    if not text:
        err = (proc.stderr or "").strip()
        raise court.StepFailed("bot CLI không trả về gì" + (": " + err[:300] if err else ""))

    base = (room.get("base") or "").rstrip("/")
    out_imgs, out_vids = [], []
    if base:
        dtok = _encode_dir(cwd)   # mã hóa đúng thư mục đã dùng ở lượt này (mặc định hoặc bị [DIR: ...] ghi đè)
        for full, mt in after.items():
            if full in before and mt <= before[full] + 0.01:
                continue   # file có sẵn từ trước, không phải vừa tạo/sửa ở lượt này
            rel = os.path.relpath(full, cwd).replace(os.sep, "/")
            url = base + "/api/arena/cli-file/" + dtok + "/" + urllib.parse.quote(rel)
            (out_imgs if os.path.splitext(full)[1].lower() in IMG_EXT else out_vids).append(url)
    return {"text": text, "images": out_imgs, "videos": out_vids, "options": []}


def tab_prompt(task_id, room, p):
    return "\n".join([
        "[[T-%s]]" % task_id,
        "TIN TỰ ĐỘNG TỪ SÂN CHƠI, KHÔNG CÓ NGƯỜI TRẢ LỜI NGAY. Không hỏi lại, không xin xác nhận, không tạo tác vụ, không dùng công cụ hay tìm kiếm web. Chỉ trả lời bằng chữ ngay trong khung chat.",
        core_prompt(room, p),
        "Khi xong, viết đúng một dòng cuối: %s" % court.END_MARK,
        "[[/T-%s]]" % task_id,
    ])


# ---------- gọi từng loại người nói ----------
def _http(url, payload, headers=None, timeout=HTTP_TIMEOUT):
    if not re.match(r"^https?://", url or ""):
        raise court.StepFailed("địa chỉ phải bắt đầu bằng http:// hoặc https://")
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), method="POST",
                                 headers=dict({"Content-Type": "application/json"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise court.StepFailed("máy chủ bot trả lỗi %d: %s" % (e.code, e.read().decode("utf-8", "replace")[:160]))
    except (urllib.error.URLError, OSError) as e:
        raise court.StepFailed("không gọi được bot: %s" % e)


def _extract_payload(body):
    """Lấy câu trả lời, ảnh, video và lựa chọn từ JSON hoặc text."""
    images = []
    videos = []
    options = []
    text = ""
    try:
        j = json.loads(body)
    except ValueError:
        return body.strip(), images, videos, options
    if isinstance(j, str):
        return j.strip(), images, videos, options
    if isinstance(j, dict):
        for img_k in ("image", "image_url", "image_urls", "images", "img"):
            val = j.get(img_k)
            if isinstance(val, str) and val.strip():
                images.append(val.strip())
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.strip():
                        images.append(item.strip())
                    elif isinstance(item, dict) and item.get("url"):
                        images.append(item["url"].strip())

        for vid_k in ("video", "video_url", "video_urls", "videos"):
            val = j.get(vid_k)
            if isinstance(val, str) and val.strip():
                videos.append(val.strip())
            elif isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.strip():
                        videos.append(item.strip())

        for opt_k in ("options", "choices_list", "choices", "suggested_replies"):
            val = j.get(opt_k)
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, str) and item.strip():
                        options.append(item.strip())
                    elif isinstance(item, dict) and (item.get("text") or item.get("title")):
                        options.append((item.get("text") or item.get("title")).strip())

        if isinstance(j.get("choices"), list) and j["choices"]:
            c = j["choices"][0]
            m = c.get("message") or {}
            content = m.get("content") or c.get("text") or ""
            if isinstance(content, list):
                txt_parts = []
                for b in content:
                    if isinstance(b, dict):
                        if b.get("type") == "text":
                            txt_parts.append(b.get("text", ""))
                        elif b.get("type") == "image_url":
                            url = (b.get("image_url") or {}).get("url")
                            if url:
                                images.append(url)
                text = " ".join(txt_parts).strip()
            else:
                text = str(content).strip()
            return text, images, videos, options
        for k in ("reply", "text", "output", "message", "content", "response", "answer"):
            v = j.get(k)
            if isinstance(v, str) and v.strip():
                text = v.strip()
                return text, images, videos, options
            if isinstance(v, dict) and isinstance(v.get("content"), str):
                text = v["content"].strip()
                return text, images, videos, options
        return "", images, videos, options
    return "", images, videos, options


def _extract_text(body):
    t, _, _, _ = _extract_payload(body)
    return t


def speak_webhook_full(room, p, b):
    task_id = "w%d" % int(time.time() * 1000)
    ev = threading.Event()
    with court.lock:
        while task_id in court.tasks:
            task_id += "x"
        court.tasks[task_id] = {"event": ev, "text": "", "final": False, "step": None}
    room["speaking_task"] = task_id
    raw = room.get("raw", True)
    sent = outgoing_text(room, p) if raw else core_prompt(room, p)
    payload = {
        "id": task_id, "room": room["id"], "bot": p["name"], "topic": room["topic"], "persona": p.get("persona", ""),
        "history": [{"name": m["name"], "text": m["text"]} for m in room["messages"] if m["role"] != "system"][-HISTORY_IN_PROMPT:],
        "text": sent, "prompt": sent, "intro": intro_text(room, p) if raw else "",
        "callback": (room.get("base", "").rstrip("/") + "/api/arena/callback/" + task_id) if room.get("base") else "",
    }
    headers = {"Authorization": "Bearer " + b["key"], "X-Muse-Token": b["key"]} if b.get("key") else {}
    try:
        import access
        if access.PUBLIC:
            payload["callback_token"] = access.BRIDGE_TOKEN
    except Exception:
        pass
    status, body = _http(b["url"], payload, headers)
    text, imgs, vids, opts = _extract_payload(body)
    if text and not (status == 202):
        return {"text": text, "images": imgs, "videos": vids, "options": opts}
    if not payload["callback"] or "127.0.0.1" in payload["callback"] or "localhost" in payload["callback"]:
        raise court.StepFailed("webhook đã nhận tin (HTTP %d) nhưng không trả lời ngay, và địa chỉ gọi lại của Tool là localhost nên dịch vụ bên ngoài không gọi về được. Cần tên miền hoặc đường hầm công khai để bot gửi câu trả lời về." % status)
    deadline = time.time() + HTTP_TIMEOUT
    while not ev.wait(0.5):
        if room["status"] == "stopped":
            raise court.RunCancelled()
        if time.time() > deadline:
            raise court.StepFailed("chờ bot trả lời qua callback quá %d giây" % HTTP_TIMEOUT)
    cb_text = court.partial_reply(task_id)
    return {"text": cb_text, "images": imgs, "videos": vids, "options": opts}


def speak_webhook(room, p, b):
    return speak_webhook_full(room, p, b)["text"]


def speak_openai_full(room, p, b):
    base = (b["url"] or "").rstrip("/")
    url = base if base.endswith("/chat/completions") else base + "/chat/completions"
    if room.get("raw", True):
        msgs = [{"role": "user", "content": outgoing_text(room, p)}]
        if intro_text(room, p):
            msgs.insert(0, {"role": "system", "content": intro_text(room, p)})
    else:
        sys_msg = "Bạn là %s trong một phòng trò chuyện nhiều AI. %s" % (p["name"], p.get("persona", ""))
        msgs = [{"role": "system", "content": sys_msg.strip()}, {"role": "user", "content": core_prompt(room, p)}]
    payload = {"model": b.get("model") or "", "max_tokens": 1000, "messages": msgs}
    headers = {"Authorization": "Bearer " + b["key"]} if b.get("key") else {}
    _, body = _http(url, payload, headers)
    text, imgs, vids, opts = _extract_payload(body)
    if not text and not imgs and not vids:
        raise court.StepFailed("bot API không trả nội dung: %s" % body[:160])
    return {"text": text, "images": imgs, "videos": vids, "options": opts}


def speak_openai(room, p, b):
    return speak_openai_full(room, p, b)["text"]


def speak_full(room, p):
    kind = p["kind"]
    if kind == "tab":
        raw = room.get("raw", True)
        sent = with_intro(room, p, outgoing_text(room, p)) if raw else None

        def build(task_id):
            room["speaking_task"] = task_id
            return sent if raw else tab_prompt(task_id, room, p)
        _, text = court.ask_tab(p["key"][4:], build, stop=lambda: room["status"] == "stopped", raw=raw)
        if raw and p["key"] not in room.setdefault("introduced", []):
            room["introduced"].append(p["key"])
        return {"text": text, "images": [], "videos": [], "options": []}
    b = bots.get(p["key"][4:])
    if not b:
        raise court.StepFailed("bot đã bị xóa")
    if kind == "cli":
        res = speak_cli_full(room, p, b)
    else:
        res = speak_webhook_full(room, p, b) if kind == "webhook" else speak_openai_full(room, p, b)
    if isinstance(res, str):
        return {"text": res, "images": [], "videos": [], "options": []}
    return res


def speak(room, p):
    return speak_full(room, p).get("text", "")


# ---------- chạy phòng ----------
def add_message(room, role, name, text, p=None, images=None, videos=None, options=None):
    parsed_imgs, parsed_vids, parsed_opts = parse_media_and_options(text)

    all_imgs = []
    for img in list(images or []) + parsed_imgs:
        if img and img not in all_imgs:
            all_imgs.append(img)

    all_vids = []
    for vid in list(videos or []) + parsed_vids:
        if vid and vid not in all_vids:
            all_vids.append(vid)

    all_opts = []
    for opt in list(options or []) + parsed_opts:
        if opt and opt not in all_opts:
            all_opts.append(opt)

    m = {"role": role, "name": name, "text": text, "ts": time.time(),
         "key": p["key"] if p else "", "provider": p["provider"] if p else "", "color": p.get("color", "") if p else "",
         "images": all_imgs, "videos": all_vids, "options": all_opts}
    with lock:
        room["messages"].append(m)
    return m


def run_room(room):
    fails = 0
    try:
        while True:
            while room["status"] == "paused":
                time.sleep(0.5)
            # Dừng nếu không đang running hoặc đã đủ lượt (khi không bật unlimited)
            if room["status"] != "running":
                break
            if not room.get("unlimited") and room.get("max_turns", 0) > 0 and room["turns_done"] >= room["max_turns"]:
                break
            parts = room["participants"]
            p = parts[room["turn"] % len(parts)]
            room["speaking"], room["speaking_task"] = p["key"], None
            try:
                if resolve(p["key"]) is None:
                    raise court.StepFailed("không còn tồn tại")
                reply_data = speak_full(room, p)
                text = scrub(reply_data.get("text", ""))
                if not text:
                    raise court.StepFailed("trả lời rỗng")
                msg = add_message(room, "bot", p["name"], text, p,
                                  images=reply_data.get("images"),
                                  videos=reply_data.get("videos"),
                                  options=reply_data.get("options"))
                fails = 0

                # Tự động tạm dừng nếu AI đưa ra lựa chọn và phòng có bật auto_pause_choices
                if room.get("auto_pause_choices") and msg.get("options") and len(msg["options"]) >= 2:
                    room["turn"] += 1
                    room["turns_done"] += 1
                    room["status"] = "paused"
                    add_message(room, "system", "Hệ thống", "⏸️ Đã tạm dừng phòng để Chủ Nhân bấm chọn phương án bên dưới.")
                    save_rooms()
                    break
            except court.RunCancelled:
                raise
            except court.StepFailed as e:
                fails += 1
                add_message(room, "system", "Hệ thống", "%s không nói được: %s" % (p["name"], e))
                if fails >= 3:
                    room["error"] = "Ba lần liên tiếp không ai trả lời được, dừng phòng."
                    room["status"] = "error"
                    break
            room["turn"] += 1
            room["turns_done"] += 1
            save_rooms()
            time.sleep(max(0, room.get("pause", 1)))
        if room["status"] == "running":
            room["status"] = "done"
    except court.RunCancelled:
        room["status"] = "stopped"
    except Exception as e:  # noqa
        room["status"] = "error"
        room["error"] = "Lỗi nội bộ: %s" % e
    finally:
        room["speaking"], room["speaking_task"] = None, None
        room["worker"] = False
        save_rooms()


def _start_worker(room):
    with lock:
        if room.get("worker"):
            return
        room["worker"] = True
    threading.Thread(target=run_room, args=(room,), daemon=True).start()


def create_room(topic, items, max_turns, pause, sentences, base, raw=True, intro=None, unlimited=False, auto_pause_choices=False):
    parts = []
    for i, it in enumerate(items):
        r = resolve(it.get("key", ""))
        if not r:
            continue
        parts.append({"key": it["key"], "name": r[0], "provider": r[1], "kind": r[2], "persona": (it.get("persona") or "").strip(),
                      "color": COLORS[i % len(COLORS)]})
    if len(parts) < 2:
        raise ValueError("Cần ít nhất 2 người tham gia")
    busy = {q["key"] for r in rooms.values() if r["status"] in ("running", "paused") for q in r["participants"]}
    clash = [q["name"] for q in parts if q["key"] in busy]
    if clash:
        raise ValueError("%s đang ở trong một phòng khác chưa dừng. Hãy bấm Dừng hoặc Xóa phòng đó trước." % ", ".join(clash))
    rid = "room%d" % int(time.time() * 1000)

    is_unlimited = bool(unlimited) or (int(max_turns or 0) <= 0)
    calculated_max = 0 if is_unlimited else max(1, min(int(max_turns or 10), MAX_TURNS_LIMIT))

    room = {"id": rid, "topic": topic.strip() or "Trò chuyện tự do", "participants": parts, "messages": [], "status": "running",
            "turn": 0, "turns_done": 0, "max_turns": calculated_max, "unlimited": is_unlimited,
            "auto_pause_choices": bool(auto_pause_choices),
            "pause": max(0, min(float(pause or 1), 30)), "sentences": max(1, min(int(sentences or 3), 8)), "raw": bool(raw), "introduced": [],
            "created": time.time(), "error": "", "speaking": None, "speaking_task": None, "base": base, "worker": False}
    room["intro"] = ((DEFAULT_INTRO if intro is None else intro) or "").replace("{n}", str(room["sentences"])).strip() if raw else ""
    with lock:
        rooms[rid] = room
    _start_worker(room)
    return room


def room_view(room):
    v = {k: room.get(k) for k in ("id", "topic", "participants", "messages", "status", "turn", "turns_done", "max_turns",
                                  "pause", "sentences", "created", "error", "speaking", "raw", "intro", "unlimited", "auto_pause_choices")}
    live = ""
    if room.get("speaking_task"):
        live = court.partial_reply(room["speaking_task"])
    v["live"] = live
    return v


# ---------- đường dẫn ----------
def init(app):
    load_all()

    @app.route("/api/arena/default-intro", methods=["GET"])
    def ar_default_intro():
        return jsonify({"intro": DEFAULT_INTRO})

    @app.route("/api/arena/upload", methods=["POST"])
    def ar_upload():
        """Chủ Nhân đính kèm ảnh/video vào phòng — lưu lại rồi trả về link để chèn vào tin nhắn.
        Bot CLI (Codex) sẽ nhận file gốc qua -i; các bot khác thấy link ảnh/video trong tin nhắn như bình thường."""
        f = request.files.get("file")
        if not f or not f.filename:
            return jsonify({"error": "Thiếu file"}), 400
        ext = os.path.splitext(f.filename)[1].lower()
        if ext not in IMG_EXT + VID_EXT:
            return jsonify({"error": "Chỉ nhận ảnh hoặc video"}), 400
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        fname = secrets.token_hex(8) + ext
        f.save(os.path.join(UPLOAD_DIR, fname))
        url = request.host_url.rstrip("/") + "/api/arena/upload/" + fname
        return jsonify({"url": url, "kind": "video" if ext in VID_EXT else "image"})

    @app.route("/api/arena/upload/<fname>")
    def ar_upload_file(fname):
        return send_from_directory(UPLOAD_DIR, fname)

    @app.route("/api/arena/cli-file/<dirtoken>/<path:relpath>")
    def ar_cli_file(dirtoken, relpath):
        """Phục vụ ảnh/video mà bot CLI vừa tạo ra trong thư mục làm việc đã dùng ở lượt đó
        (thư mục mặc định của bot, hoặc thư mục bị [DIR: ...] ghi đè cho riêng lượt đó)."""
        try:
            cwd = os.path.abspath(_decode_dir(dirtoken))
        except Exception:
            return "Không hợp lệ", 400
        full = os.path.abspath(os.path.join(cwd, urllib.parse.unquote(relpath)))
        if full != cwd and not full.startswith(cwd + os.sep):
            return "Không có quyền", 403
        if not os.path.isfile(full):
            return "Không có file này", 404
        return send_from_directory(os.path.dirname(full), os.path.basename(full))

    @app.route("/api/arena/participants", methods=["GET"])
    def ar_participants():
        return jsonify({"participants": list_participants(), "bots": [bot_public(b) for b in bots.values()]})

    @app.route("/api/arena/bot", methods=["POST"])
    def ar_bot_save():
        d = request.get_json(silent=True) or {}
        kind = d.get("kind")
        if kind not in ("webhook", "openai", "cli"):
            return jsonify({"error": "kind phải là webhook, openai hoặc cli"}), 400
        name, url = (d.get("name") or "").strip()[:40], (d.get("url") or "").strip()
        if not name:
            return jsonify({"error": "Cần tên bot"}), 400
        engine = (d.get("engine") or "codex").strip() if kind == "cli" else ""
        cmd = (d.get("cmd") or "").strip() if kind == "cli" else ""
        if kind == "cli":
            if url and not os.path.isdir(url):
                return jsonify({"error": "Thư mục làm việc không tồn tại trên máy chủ: %s" % url}), 400
            if engine not in ("codex", "custom"):
                return jsonify({"error": "engine phải là codex hoặc custom"}), 400
            if engine == "custom" and not cmd:
                return jsonify({"error": "Engine tùy chỉnh cần nhập lệnh chạy (vd. tên CLI của Cursor/Copilot)"}), 400
        elif not re.match(r"^https?://", url):
            return jsonify({"error": "Cần địa chỉ bắt đầu bằng http:// hoặc https://"}), 400
        with lock:
            b = bots.get(d.get("id")) if d.get("id") else None
            if not b:
                b = {"id": secrets.token_hex(4), "enabled": True}
                bots[b["id"]] = b
            b.update({"name": name, "kind": kind, "url": url, "model": (d.get("model") or "").strip(),
                      "provider": d.get("provider") if d.get("provider") in court.PROVIDERS else "other"})
            if kind == "cli":
                b.update({"engine": engine, "cmd": cmd})
            if d.get("key"):
                b["key"] = d["key"].strip()
            save_bots()
        return jsonify(bot_public(b))

    @app.route("/api/arena/bot/<bid>", methods=["DELETE"])
    def ar_bot_del(bid):
        with lock:
            ok = bots.pop(bid, None) is not None
            save_bots()
        return jsonify({"success": ok})

    @app.route("/api/arena/bot/<bid>/test", methods=["POST"])
    def ar_bot_test(bid):
        b = bots.get(bid)
        if not b:
            return jsonify({"error": "Không có bot này"}), 404
        fake = {"id": "test", "topic": "Thử kết nối", "messages": [], "participants": [{"key": "bot:" + bid, "name": b["name"], "provider": b.get("provider", "other")}],
                "status": "running", "sentences": 1, "base": request.host_url}
        p = {"key": "bot:" + bid, "name": b["name"], "provider": b.get("provider", "other"), "kind": b["kind"], "persona": ""}
        try:
            if b["kind"] == "cli":
                res = speak_cli_full(fake, p, b)
            else:
                res = speak_webhook_full(fake, p, b) if b["kind"] == "webhook" else speak_openai_full(fake, p, b)
            reply_text = res.get("text", "")
            return jsonify({"ok": True, "reply": reply_text[:300], "images": res.get("images", []), "options": res.get("options", [])})
        except Exception as e:  # noqa
            return jsonify({"ok": False, "error": str(e)})

    @app.route("/api/arena/room", methods=["POST"])
    def ar_room_new():
        d = request.get_json(silent=True) or {}
        try:
            r = create_room(d.get("topic", ""), d.get("participants") or [], d.get("max_turns"), d.get("pause"),
                            d.get("sentences"), request.host_url, d.get("raw", True), d.get("intro"),
                            unlimited=d.get("unlimited", False), auto_pause_choices=d.get("auto_pause_choices", False))
        except (ValueError, TypeError) as e:
            return jsonify({"error": str(e)}), 400
        return jsonify(room_view(r))

    @app.route("/api/arena/rooms", methods=["GET"])
    def ar_rooms():
        return jsonify([room_view(r) for r in sorted(rooms.values(), key=lambda r: r["created"], reverse=True)])

    def _room(rid):
        return rooms.get(rid)

    @app.route("/api/arena/room/<rid>/say", methods=["POST"])
    def ar_say(rid):
        r = _room(rid)
        text = ((request.get_json(silent=True) or {}).get("text") or "").strip()
        if not r or not text:
            return jsonify({"error": "Thiếu phòng hoặc lời nói"}), 400
        add_message(r, "user", "Chủ Nhân", text)
        return jsonify({"success": True})

    @app.route("/api/arena/room/<rid>/choose", methods=["POST"])
    def ar_choose(rid):
        """Người dùng bấm vào lựa chọn để quyết định thay cho bot."""
        r = _room(rid)
        if not r:
            return jsonify({"error": "Không có phòng này"}), 404
        d = request.get_json(silent=True) or {}
        choice = (d.get("choice") or d.get("text") or "").strip()
        if not choice:
            return jsonify({"error": "Thiếu nội dung lựa chọn"}), 400
        add_message(r, "user", "Chủ Nhân", "👉 Lựa chọn: " + choice)
        if r["status"] == "paused":
            r["status"] = "running"
            _start_worker(r)
        elif r["status"] in ("done", "stopped"):
            r["status"] = "running"
            _start_worker(r)
        save_rooms()
        return jsonify({"success": True, "room": room_view(r)})

    @app.route("/api/arena/room/<rid>/<action>", methods=["POST"])
    def ar_action(rid, action):
        r = _room(rid)
        if not r:
            return jsonify({"error": "Không có phòng này"}), 404
        d = request.get_json(silent=True) or {}
        if action == "pause" and r["status"] == "running":
            r["status"] = "paused"
        elif action == "resume" and r["status"] == "paused":
            r["status"] = "running"
        elif action == "stop":
            r["status"] = "stopped"
        elif action == "unlimited":
            r["unlimited"] = not r.get("unlimited", False)
            if r["unlimited"]:
                r["max_turns"] = 0
                if r["status"] in ("done", "stopped"):
                    r["status"], r["error"] = "running", ""
                    _start_worker(r)
        elif action == "more":
            r["max_turns"] = min(r["turns_done"] + max(1, int(d.get("turns") or 6)), r["turns_done"] + MAX_TURNS_LIMIT)
            if r["status"] in ("done", "stopped", "error"):
                r["status"], r["error"] = "running", ""
                _start_worker(r)
        else:
            return jsonify({"error": "Không hiểu thao tác"}), 400
        save_rooms()
        return jsonify(room_view(r))

    @app.route("/api/arena/room/<rid>", methods=["DELETE"])
    def ar_room_del(rid):
        r = rooms.get(rid)
        if r:
            r["status"] = "stopped"
            rooms.pop(rid, None)
            save_rooms()
        return jsonify({"success": bool(r)})

    @app.route("/api/arena/callback/<task_id>", methods=["POST"])
    def ar_callback(task_id):
        d = request.get_json(silent=True) or {}
        text = d.get("text") or d.get("reply") or ""

        # Hỗ trợ bot gửi ảnh, video hoặc options qua callback
        imgs = d.get("images") or d.get("image") or []
        if isinstance(imgs, str): imgs = [imgs]
        vids = d.get("videos") or d.get("video") or []
        if isinstance(vids, str): vids = [vids]
        opts = d.get("options") or d.get("choices") or []
        if isinstance(opts, str): opts = [opts]

        extra = []
        for img in imgs:
            if img: extra.append(f"\n\n![Ảnh do AI tạo]({img})\n\n")
        for vid in vids:
            if vid: extra.append(f"\n\n[VIDEO: {vid}]\n\n")
        if opts:
            extra.append("\n" + "\n".join(f"{i+1}. {opt}" for i, opt in enumerate(opts)))
        if extra:
            text = text + "".join(extra)

        if not text:
            return jsonify({"error": "Thiếu text"}), 400
        return jsonify({"success": court.on_response(task_id, text, True)})

    @app.route("/san-choi")
    def ar_page():
        from flask import render_template
        return render_template("arena.html")
