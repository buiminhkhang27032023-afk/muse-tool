"""Chế độ chạy trên tên miền: đăng nhập, mã cho cầu nối, và kho dữ liệu của làng (công vụ, nhật ký, tường hoa).

Bật bằng biến môi trường MUSE_PUBLIC=1. Không bật thì chạy như cũ trên máy, không cần đăng nhập.
  MUSE_PASSWORD  mật khẩu đăng nhập Triều Đình (không đặt thì tự sinh lần đầu, lưu ở data/password.txt)
  MUSE_DATA      thư mục lưu dữ liệu (mặc định D:\\tool muse\\data)
  MUSE_HTTPS=1   khi chạy sau HTTPS (Caddy, Cloudflare...) để cookie đăng nhập chỉ đi qua HTTPS
"""
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from urllib.parse import quote

from flask import jsonify, redirect, request, session

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.environ.get("MUSE_PUBLIC") == "1"
DATA_DIR = os.environ.get("MUSE_DATA") or os.path.join(HERE, "data")
os.makedirs(DATA_DIR, exist_ok=True)

COLLECTIONS = ("cong_vu", "nhat_ky", "hoa_vien")
MAX_DOCS = 600
_db_lock = threading.Lock()
DB_FILE = os.path.join(DATA_DIR, "db.json")


def _read_or_make(name, maker):
    p = os.path.join(DATA_DIR, name)
    try:
        with open(p, "r", encoding="utf-8") as f:
            v = f.read().strip()
            if v:
                return v
    except OSError:
        pass
    v = maker()
    with open(p, "w", encoding="utf-8") as f:
        f.write(v)
    return v


SECRET = _read_or_make("secret.key", lambda: secrets.token_hex(32))
PASSWORD = os.environ.get("MUSE_PASSWORD") or _read_or_make("password.txt", lambda: secrets.token_urlsafe(12))
BRIDGE_TOKEN = hashlib.sha256((PASSWORD + "|muse-bridge").encode("utf-8")).hexdigest()[:32]

LOGIN_HTML = """<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Đăng nhập Triều Đình</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#140d0a;color:#f3e6d6;font-family:system-ui,"Segoe UI",sans-serif}
form{width:min(360px,90vw);background:#241a14;border:1px solid #4a3a2c;border-radius:18px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{margin:0 0 4px;font-size:22px;color:#e0a43f}p{margin:0 0 18px;color:#b9a390;font-size:13px}
input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid #5a4636;background:#1b120e;color:inherit;font-size:15px}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:10px;background:#b3202c;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.e{color:#ff8a80;font-size:13px;margin-top:10px;min-height:16px}</style></head><body>
<form method="post"><h1>🐉 Triều Đình Rồng Tiên</h1><p>Nhập mật khẩu để vào.</p>
<input type="password" name="password" placeholder="Mật khẩu" autofocus required>
<input type="hidden" name="next" value="{{NEXT}}"><button>Vào triều</button><div class="e">{{ERR}}</div></form></body></html>"""


def _safe_next(n):
    return n if (n or "").startswith("/") and not (n or "").startswith("//") else "/"


def bridge_token_for_page():
    """Mã gắn sẵn vào cầu nối: chỉ đưa cho người đã đăng nhập (hoặc khi chạy cục bộ không cần mã)."""
    if not PUBLIC:
        return ""
    return BRIDGE_TOKEN if session.get("ok") else ""


def _load_db():
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_db(d):
    tmp = DB_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, DB_FILE)


def init(app):
    app.secret_key = SECRET
    app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                      SESSION_COOKIE_SECURE=os.environ.get("MUSE_HTTPS") == "1",
                      PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30)
    if PUBLIC:
        from werkzeug.middleware.proxy_fix import ProxyFix
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    @app.before_request
    def guard():
        if not PUBLIC or request.method == "OPTIONS":
            return None
        p = request.path
        if p in ("/login", "/api/bridge-script", "/favicon.ico"):
            return None
        tok = request.headers.get("X-Muse-Token", "")
        if session.get("ok") or (tok and hmac.compare_digest(tok, BRIDGE_TOKEN)):
            return None
        if p.startswith("/api/"):
            return jsonify({"error": "Cần đăng nhập"}), 401
        return redirect("/login?next=" + quote(p))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        nxt = _safe_next(request.values.get("next", "/"))
        err = ""
        if request.method == "POST":
            if hmac.compare_digest(request.form.get("password", ""), PASSWORD):
                session.permanent = True
                session["ok"] = True
                return redirect(nxt)
            time.sleep(1.5)   # làm chậm việc dò mật khẩu
            err = "Sai mật khẩu."
        return LOGIN_HTML.replace("{{NEXT}}", nxt.replace('"', "")).replace("{{ERR}}", err), 200, {"Content-Type": "text/html; charset=utf-8"}

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect("/login")

    # ----- kho dữ liệu của làng (thay cho cơ sở dữ liệu của claude.ai) -----
    def _col(name):
        return name if name in COLLECTIONS else None

    @app.route("/api/db/<col>", methods=["GET"])
    def db_list(col):
        if not _col(col):
            return jsonify({"error": "Không có bộ sưu tập này"}), 404
        with _db_lock:
            docs = list(_load_db().get(col, []))
        docs.sort(key=lambda d: d.get("created_at", ""), reverse=True)
        return jsonify(docs[:300])

    @app.route("/api/db/<col>", methods=["POST"])
    def db_add(col):
        if not _col(col):
            return jsonify({"error": "Không có bộ sưu tập này"}), 404
        body = request.get_json(silent=True) or {}
        doc = {k: v for k, v in body.items() if isinstance(k, str)}
        doc["id"] = secrets.token_hex(8)
        doc.setdefault("created_at", time.strftime("%Y-%m-%dT%H:%M:%S"))
        with _db_lock:
            d = _load_db()
            lst = d.setdefault(col, [])
            lst.append(doc)
            if len(lst) > MAX_DOCS:
                lst.sort(key=lambda x: x.get("created_at", ""))
                del lst[:len(lst) - MAX_DOCS]
            _save_db(d)
        return jsonify(doc)

    @app.route("/api/db/<col>/<doc_id>", methods=["PATCH", "DELETE"])
    def db_change(col, doc_id):
        if not _col(col):
            return jsonify({"error": "Không có bộ sưu tập này"}), 404
        with _db_lock:
            d = _load_db()
            lst = d.get(col, [])
            for i, x in enumerate(lst):
                if x.get("id") == doc_id:
                    if request.method == "DELETE":
                        del lst[i]
                    else:
                        x.update({k: v for k, v in (request.get_json(silent=True) or {}).items() if k != "id"})
                    _save_db(d)
                    return jsonify({"success": True})
        return jsonify({"error": "Không có tài liệu này"}), 404
