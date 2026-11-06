"""JARVIS: trợ lý điều khiển máy bằng giọng nói.

Lệnh máy (mở/đóng ứng dụng, khóa máy, chụp màn hình, âm lượng, giờ/ngày) được xử lý
ngay tại đây, không cần internet. Câu hỏi không khớp lệnh máy nào thì trang /jarvis
sẽ tự chuyển sang hỏi Muse qua cầu nối có sẵn (giống trang /chat), rồi đọc câu trả lời
lên loa khi Muse trả lời xong.
"""
import ctypes
import json
import os
import re
import subprocess
import time
import webbrowser

from flask import jsonify, request, render_template, send_from_directory

import court

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SCREENSHOT_DIR = os.path.join(BASE_DIR, "data", "screenshots")
BRAIN_PATH = os.path.join(court.BRAIN_DIR, "jarvis.md")
DEFAULT_BRAIN = (
    "Bạn là JARVIS — trợ lý giọng nói của Sếp. Nói tiếng Việt, lễ phép, gọi người dùng là \"Sếp\", "
    "hơi dí dỏm kiểu quản gia thông minh nhưng luôn đi thẳng vào việc. Trả lời ngắn gọn, đúng trọng tâm, "
    "không nói mình là AI, không bịa thông tin, tránh markdown vì câu trả lời sẽ được đọc to qua loa."
)

# những chữ đệm hay gặp khi nói chuyện tự nhiên, bỏ đi trước khi phân tích lệnh
FILLER_WORDS = [
    "jarvis oi", "jarvis", "gia vi", "lam on", "giup toi", "giup minh", "giup",
    "duoc khong", "duoc ko", "nhe", "di", "ha", "vay", "cho toi", "ban co the",
    "co the", "dum", "gium", "oi",
]


def read_jarvis_brain():
    try:
        with open(BRAIN_PATH, "r", encoding="utf-8") as f:
            return f.read().strip() or DEFAULT_BRAIN
    except OSError:
        return DEFAULT_BRAIN


def write_jarvis_brain(text):
    os.makedirs(court.BRAIN_DIR, exist_ok=True)
    with open(BRAIN_PATH, "w", encoding="utf-8") as f:
        f.write(text.strip() + "\n")

# alias (không dấu, chữ thường) -> lệnh mở bằng "start" (giống gõ vào hộp Run)
APPS = {
    "notepad": ["notepad", "ghi chu", "note pad", "so tay"],
    "calc": ["may tinh", "calculator", "calc"],
    "mspaint": ["paint", "ve tranh"],
    "explorer": ["file explorer", "quan ly file", "thu muc may tinh", "explorer", "o dia"],
    "cmd": ["command line", "cmd", "dong lenh", "terminal", "command prompt"],
    "chrome": ["chrome", "trinh duyet", "coc coc", "coc coc"],
    "winword": ["word", "van ban word", "microsoft word"],
    "excel": ["excel", "bang tinh"],
    "powerpnt": ["powerpoint", "trinh chieu", "slide"],
    "code": ["vscode", "visual studio code", "code editor"],
    "control": ["control panel", "bang dieu khien"],
    "taskmgr": ["task manager", "quan ly tien trinh"],
}

# tên tiến trình thật (.exe) để đóng bằng taskkill
PROCESS_NAMES = {
    "notepad": "notepad.exe",
    "calc": "CalculatorApp.exe",
    "mspaint": "mspaint.exe",
    "cmd": "cmd.exe",
    "chrome": "chrome.exe",
    "winword": "WINWORD.EXE",
    "excel": "EXCEL.EXE",
    "powerpnt": "POWERPNT.EXE",
    "code": "Code.exe",
    "taskmgr": "Taskmgr.exe",
}

SITES = {
    "youtube": (["youtube", "you tube"], "https://youtube.com"),
    "google": (["google", "tim kiem google"], "https://google.com"),
    "gmail": (["gmail", "email", "thu dien tu"], "https://mail.google.com"),
    "facebook": (["facebook", "fb"], "https://facebook.com"),
    "muse": (["muse", "muse.ai", "muse ai"], "https://muse.ai"),
}

VK_VOLUME_MUTE = 0xAD
VK_VOLUME_DOWN = 0xAE
VK_VOLUME_UP = 0xAF

# nối nhiều bước trong một câu nói, ví dụ "mở trình duyệt rồi chọn tk main và mở youtube"
STEP_SPLIT_RE = re.compile(r"\b(?:va|roi|sau do|xong)\b")

CHROME_LOCAL_STATE = os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data", "Local State"
)


def _strip_accents(s):
    table = str.maketrans(
        "àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵ",
        "aaaaaaaaaaaaaaaaadeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyy",
    )
    return s.translate(table)


def _norm(text):
    t = _strip_accents(text.lower()).strip()
    t = re.sub(r"[.,!?;:]+", " ", t)
    for w in FILLER_WORDS:
        t = re.sub(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _open_target(target):
    try:
        subprocess.Popen('start "" ' + target, shell=True)
        return True
    except Exception:
        return False


def _find_app(rest):
    for key, aliases in APPS.items():
        for a in aliases:
            if a in rest:
                return key
    return None


def _find_site(rest):
    for key, (aliases, url) in SITES.items():
        for a in aliases:
            if a in rest:
                return key, url
    return None, None


def _key_press(vk, times=1):
    for _ in range(times):
        ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
        ctypes.windll.user32.keybd_event(vk, 0, 2, 0)  # KEYEVENTF_KEYUP
        time.sleep(0.05)


def _chrome_profile_dir(name):
    """Tìm thư mục profile Chrome theo tên hiển thị (VD 'main') qua file Local State."""
    target = _norm(name)
    if not target:
        return None
    try:
        with open(CHROME_LOCAL_STATE, "r", encoding="utf-8") as f:
            state = json.load(f)
        cache = state.get("profile", {}).get("info_cache", {})
    except Exception:
        return None
    best = None
    for key, info in cache.items():
        nm = _norm(info.get("name", ""))
        if nm == target:
            return key
        if target in nm or nm in target:
            best = best or key
    return best


def _try_browser_profile_site(text):
    """Nhận diện lệnh gộp: mở trình duyệt + chọn tài khoản/profile + vào trang web, chạy bằng MỘT lệnh
    'chrome --profile-directory=... <url>' thay vì giả lập bấm chuột từng bước (đáng tin cậy hơn nhiều)."""
    if not any(k in text for k in ("trinh duyet", "chrome", "coc coc")):
        return None
    m = re.search(r"\b(?:tk|tai khoan|profile|acc)\s+([a-z0-9]+)", text)
    if not m:
        return None
    profile_name = m.group(1).strip()
    profile_dir = _chrome_profile_dir(profile_name)
    site_key, url = _find_site(text)
    try:
        cmd = 'start chrome'
        if profile_dir:
            cmd += ' --profile-directory="%s"' % profile_dir
        if url:
            cmd += ' ' + url
        subprocess.Popen(cmd, shell=True)
    except Exception as e:
        return {"matched": True, "ok": False, "reply": "Không mở được trình duyệt: %s" % e}
    parts = ["Đã mở trình duyệt"]
    if profile_dir:
        parts.append("với tài khoản %s" % profile_name)
    else:
        parts.append("(chưa tìm thấy tài khoản \"%s\" nào trùng tên, mở theo mặc định)" % profile_name)
    if url:
        parts.append("và vào %s" % (site_key or "trang web"))
    return {"matched": True, "ok": True, "reply": ", ".join(parts) + "."}


def take_screenshot():
    os.makedirs(SCREENSHOT_DIR, exist_ok=True)
    fname = time.strftime("%Y%m%d_%H%M%S") + ".png"
    fpath = os.path.join(SCREENSHOT_DIR, fname)
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; "
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; "
        "$g=[System.Drawing.Graphics]::FromImage($bmp); "
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); "
        "$bmp.Save('" + fpath.replace("\\", "\\\\") + "')"
    )
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, timeout=15)
    except Exception:
        return None
    return fname if os.path.exists(fpath) else None


def handle_command(raw_text):
    """Trả về dict: matched=False nghĩa là không phải lệnh máy, nên hỏi Muse thay.
    Phân tích cả câu nói nhiều bước (ví dụ "mở trình duyệt rồi chọn tk main và mở youtube")."""
    text = _norm(raw_text)
    if not text:
        return {"matched": True, "ok": False, "reply": "Dạ, tôi chưa nghe rõ."}

    if any(k in text for k in ("tat may", "khoi dong lai", "restart may", "shutdown", "tat nguon")):
        return {"matched": True, "ok": False,
                "reply": "Để an toàn, tôi không tắt hoặc khởi động lại máy bằng giọng nói. Bạn tự làm việc đó trực tiếp nhé."}

    combo = _try_browser_profile_site(text)
    if combo:
        return combo

    steps = [s.strip() for s in STEP_SPLIT_RE.split(text) if s.strip()]
    if len(steps) > 1:
        done, unknown = [], []
        for s in steps:
            r = _handle_single(s)
            if r["matched"]:
                done.append(r["reply"])
            else:
                unknown.append(s)
        if not done:
            return {"matched": False}
        reply = " ".join(done)
        if unknown:
            reply += " (Chưa hiểu phần: %s.)" % "; ".join(unknown)
        return {"matched": True, "ok": True, "reply": reply}

    return _handle_single(text)


def _handle_single(text):
    """Phân tích một lệnh máy đơn (text đã chuẩn hóa)."""
    if any(k in text for k in ("khoa may", "khoa man hinh", "lock screen", "lock may")):
        try:
            ctypes.windll.user32.LockWorkStation()
            return {"matched": True, "ok": True, "reply": "Đã khóa màn hình."}
        except Exception as e:
            return {"matched": True, "ok": False, "reply": "Không khóa được máy: %s" % e}

    if any(k in text for k in ("chup man hinh", "chup anh man hinh", "screenshot")):
        fname = take_screenshot()
        if fname:
            return {"matched": True, "ok": True, "reply": "Đã chụp màn hình xong.",
                    "extra": {"screenshot": "/jarvis/screenshot/" + fname}}
        return {"matched": True, "ok": False, "reply": "Chụp màn hình không thành công."}

    if any(k in text for k in ("tat tieng", "tat am luong", "mute")):
        _key_press(VK_VOLUME_MUTE)
        return {"matched": True, "ok": True, "reply": "Đã tắt tiếng."}
    if any(k in text for k in ("tang am luong", "to len", "volume up", "tang volume")):
        _key_press(VK_VOLUME_UP, 4)
        return {"matched": True, "ok": True, "reply": "Đã tăng âm lượng."}
    if any(k in text for k in ("giam am luong", "nho lai", "volume down", "giam volume")):
        _key_press(VK_VOLUME_DOWN, 4)
        return {"matched": True, "ok": True, "reply": "Đã giảm âm lượng."}

    if any(k in text for k in ("may gio", "gio hien tai", "bay gio la may gio")):
        return {"matched": True, "ok": True, "reply": "Bây giờ là " + time.strftime("%H giờ %M phút") + "."}
    if any(k in text for k in ("hom nay ngay may", "hom nay thu may", "ngay hom nay")):
        return {"matched": True, "ok": True, "reply": "Hôm nay là " + time.strftime("%d/%m/%Y") + "."}

    m = re.search(r"\b(dong|tat)\s+(.+)$", text)
    if m:
        rest = m.group(2)
        key = _find_app(rest)
        if key and key in PROCESS_NAMES:
            try:
                subprocess.run(["taskkill", "/IM", PROCESS_NAMES[key], "/F"], capture_output=True, timeout=10)
                return {"matched": True, "ok": True, "reply": "Đã đóng %s." % rest.strip()}
            except Exception as e:
                return {"matched": True, "ok": False, "reply": "Không đóng được: %s" % e}
        return {"matched": True, "ok": False, "reply": "Tôi chưa biết cách đóng \"%s\"." % rest.strip()}

    m = re.search(r"\b(mo|khoi dong|chay|bat)\s+(.+)$", text)
    if m:
        rest = m.group(2)
        site_key, url = _find_site(rest)
        if url:
            webbrowser.open(url)
            return {"matched": True, "ok": True, "reply": "Đã mở %s." % rest.strip()}
        app_key = _find_app(rest)
        if app_key:
            _open_target(app_key)
            return {"matched": True, "ok": True, "reply": "Đã mở %s." % rest.strip()}
        # không rõ ứng dụng cụ thể: coi như tìm kiếm trên Google cho tiện
        webbrowser.open("https://www.google.com/search?q=" + rest.strip().replace(" ", "+"))
        return {"matched": True, "ok": True, "reply": "Tôi chưa biết ứng dụng \"%s\", nên đã tìm trên Google giúp bạn." % rest.strip()}

    return {"matched": False}


def init(app):
    @app.route("/jarvis")
    def jarvis_page():
        return render_template("jarvis.html")

    @app.route("/api/jarvis/cmd", methods=["POST"])
    def jarvis_cmd():
        data = request.json or {}
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "Nội dung trống"}), 400
        return jsonify(handle_command(text))

    @app.route("/api/jarvis/brain", methods=["GET"])
    def jarvis_get_brain():
        return jsonify({"text": read_jarvis_brain()})

    @app.route("/api/jarvis/brain", methods=["POST"])
    def jarvis_set_brain():
        text = (request.json or {}).get("text", "")
        if not text.strip():
            return jsonify({"error": "Bộ não trống"}), 400
        write_jarvis_brain(text)
        return jsonify({"success": True})

    @app.route("/jarvis/screenshot/<fname>")
    def jarvis_screenshot(fname):
        return send_from_directory(SCREENSHOT_DIR, fname)
