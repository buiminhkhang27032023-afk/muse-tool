import os
import sys
import time
import json

# thư viện đóng gói sẵn ở thư mục libs/ (nếu có) — để chạy được trên máy khác
# chưa cài pip, không có mạng; máy nào đã có sẵn thư viện thì dùng bình thường.
_LIBS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "libs")
if os.path.isdir(_LIBS_DIR) and _LIBS_DIR not in sys.path:
    sys.path.insert(0, _LIBS_DIR)

from flask import Flask, request, jsonify, render_template, send_from_directory, redirect
from flask_cors import CORS
import court
import access
import arena
import jarvis

import logging


class _QuietPolls(logging.Filter):
    """Cầu nối và trang web hỏi server mỗi giây; không in những dòng đó ra màn hình, chỉ in việc quan trọng."""
    QUIET = ("/api/poll-pending", "/api/status", "/api/messages", "/api/court/runs", "/api/court/tabs", "/api/arena/", "/favicon.ico")

    def filter(self, record):
        msg = record.getMessage()
        return not any(q in msg for q in self.QUIET)


logging.getLogger("werkzeug").addFilter(_QuietPolls())

app = Flask(__name__, template_folder="templates", static_folder="static")
CORS(app)
access.init(app)
arena.init(app)
jarvis.init(app)


@app.before_request
def fix_trailing_punct():
    """Dán link kèm dấu chấm hoặc phẩy ở cuối (VD: /san-choi.) thì tự bỏ dấu đi."""
    if request.method == "GET" and request.path != "/" and request.path[-1] in ".,;:)":
        return redirect(request.path.rstrip(".,;:)") or "/")


@app.errorhandler(405)
@app.errorhandler(404)
def not_found_page(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Không có đường dẫn này"}), e.code
    last = request.path.rstrip("/").rsplit("/", 1)[-1].rstrip(".,;:)")
    if request.method == "GET" and last in ("lang", "trieu-dinh", "san-choi", "connect", "chat", "jarvis"):
        return redirect("/" + last)
    return ("<meta charset='utf-8'><body style='font-family:system-ui;background:#0b0f17;color:#f3e6d6;padding:40px'>"
            "<h2>Không có trang này</h2><p>Các trang có sẵn:</p><ul>"
            "<li><a style='color:#fbbf24' href='/lang'>/lang</a> Làng 3D</li>"
            "<li><a style='color:#fbbf24' href='/trieu-dinh'>/trieu-dinh</a> Triều Đình</li>"
            "<li><a style='color:#fbbf24' href='/jarvis'>/jarvis</a> JARVIS (nói chuyện bằng giọng)</li>"
            "<li><a style='color:#fbbf24' href='/san-choi'>/san-choi</a> Sân Chơi Bot</li>"
            "<li><a style='color:#fbbf24' href='/connect'>/connect</a> Nối trình duyệt</li></ul>"
            "<p style='color:#b9a390'>Nhớ gõ địa chỉ không kèm dấu chấm ở cuối.</p>"), e.code

@app.after_request
def add_pna_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    response.headers["Access-Control-Max-Age"] = "600"
    return response

@app.route('/', defaults={'path': ''}, methods=["OPTIONS"])
@app.route('/<path:path>', methods=["OPTIONS"])
def options_handler(path):
    response = app.make_default_options_response()
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

messages = []
pending_to_muse = []
last_bridge_heartbeat = 0

@app.route("/")
def index():
    return redirect("/lang")


@app.route("/chat")
def chat_page():
    return render_template("index.html")

@app.route("/api/status", methods=["GET"])
def get_status():
    global last_bridge_heartbeat
    is_bridge_online = (time.time() - last_bridge_heartbeat) < 5 or court.bridge_online()
    return jsonify({
        "status": "ok",
        "bridge_connected": is_bridge_online,
        "agents": court.online_agents(),
        "tab_count": court.online_tab_count(),
        "labels": court.agent_labels(),
        "message_count": len(messages)
    })

@app.route("/api/messages", methods=["GET"])
def get_messages():
    return jsonify(messages)

@app.route("/api/clear", methods=["POST"])
def clear_messages():
    global messages, pending_to_muse
    messages = []
    pending_to_muse = []
    return jsonify({"success": True})

@app.route("/api/send", methods=["POST"])
def send_message():
    data = request.json or {}
    text = data.get("text", "").strip()
    send_text = (data.get("send_text") or text).strip()
    if not text:
        return jsonify({"error": "Nội dung tin nhắn trống"}), 400

    msg_id = f"msg_{int(time.time() * 1000)}"
    user_msg = {
        "id": msg_id,
        "role": "user",
        "text": text,
        "timestamp": time.time(),
        "status": "pending"
    }
    messages.append(user_msg)
    pending_to_muse.append({"id": msg_id, "text": send_text})

    return jsonify({"success": True, "message": user_msg})

@app.route("/api/poll-pending", methods=["GET"])
def poll_pending():
    global last_bridge_heartbeat
    last_bridge_heartbeat = time.time()
    agent = request.args.get("agent", "*")
    tab_id = request.args.get("tab") or None
    label = request.args.get("label", "")
    provider = request.args.get("provider", "")
    ct = court.take_task(tab_id, agent if agent != "*" else None, label, provider)
    if ct:
        return jsonify({"has_task": True, "task": {"id": ct["id"], "text": ct["text"], "raw": bool(ct.get("raw"))}, "tab": court.tab_info(tab_id or ("anon-" + agent))})
    tab = court.tabs.get(tab_id or ("anon-" + agent))
    # bất kỳ tab nào rảnh, chưa gán vai (Muse, Grok, ChatGPT, Gemini, Claude...) đều được nhận câu hỏi
    # của /chat và /jarvis — tab nào rảnh trước trả lời trước, không còn kẹt cứng vào mỗi Muse.
    pool_free = bool(tab) and not tab["roles"] and not tab["busy"] and court.tab_ready(tab)
    info = court.tab_info(tab_id or ("anon-" + agent))

    if pool_free and pending_to_muse:
        task = pending_to_muse.pop(0)
        for m in messages:
            if m["id"] == task["id"]:
                m["status"] = "sent_to_web"
                break
        return jsonify({"has_task": True, "task": task})
    
    return jsonify({"has_task": False, "tab": info})

@app.route("/api/response", methods=["POST"])
def receive_response():
    global last_bridge_heartbeat
    last_bridge_heartbeat = time.time()

    data = request.json or {}
    reply_text = data.get("text", "").strip()
    prompt_id = data.get("prompt_id")
    is_final = data.get("is_final", True)

    if not reply_text or reply_text == "More":
        return jsonify({"error": "Invalid response"}), 400

    if court.on_response(prompt_id, reply_text, is_final):
        return jsonify({"success": True, "court": True})

    existing_resp = None
    for m in reversed(messages):
        if m.get("reply_to") == prompt_id:
            existing_resp = m
            break

    if existing_resp:
        existing_resp["text"] = reply_text
        existing_resp["is_final"] = is_final
        existing_resp["timestamp"] = time.time()
    else:
        assistant_msg = {
            "id": f"resp_{int(time.time() * 1000)}",
            "role": "assistant",
            "reply_to": prompt_id,
            "text": reply_text,
            "is_final": is_final,
            "timestamp": time.time()
        }
        messages.append(assistant_msg)

    return jsonify({"success": True})

@app.route("/api/bridge-script", methods=["GET"])
def get_bridge_script():
    bridge_path = os.path.join(os.path.dirname(__file__), "muse_bridge.js")
    if os.path.exists(bridge_path):
        with open(bridge_path, "r", encoding="utf-8") as f:
            return f.read(), 200, {"Content-Type": "text/plain; charset=utf-8"}
    return "// bridge script not found", 404

# ---------- Triều đình ----------
@app.route("/lang")
def village_3d():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lang.html")
    if not os.path.exists(p):
        return "Chưa có lang.html (bản 3D).", 404
    with open(p, "r", encoding="utf-8") as f:
        return f.read(), 200, {"Content-Type": "text/html; charset=utf-8"}


@app.route("/favicon.ico")
def favicon():
    return "", 204


@app.route("/extension.zip")
def extension_zip():
    """Gói extension trỏ đúng về địa chỉ mà trình duyệt đang mở Tool (máy khác trong mạng cũng dùng được)."""
    import io as _io
    import zipfile
    base = os.path.dirname(os.path.abspath(__file__))
    origin = request.host_url.rstrip("/")
    with open(os.path.join(base, "muse_bridge.js"), "r", encoding="utf-8") as f:
        bridge = f.read().replace('"http://127.0.0.1:5000"', json.dumps(origin)).replace('let TOOL_TOKEN = "";', 'let TOOL_TOKEN = %s;' % json.dumps(access.bridge_token_for_page()))
    with open(os.path.join(base, "extension", "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)
    hosts = manifest.get("host_permissions", [])
    if origin + "/*" not in hosts:
        hosts.append(origin + "/*")
    manifest["host_permissions"] = hosts
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("muse_extension/manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        z.writestr("muse_extension/bridge.js", bridge)
        with open(os.path.join(base, "extension", "background.js"), "r", encoding="utf-8") as bf:
            z.writestr("muse_extension/background.js", bf.read())
        icon_dir = os.path.join(base, "extension", "icons")
        if os.path.isdir(icon_dir):                      # logo của extension (nếu đã tạo bằng make_icons.py)
            for fn in os.listdir(icon_dir):
                with open(os.path.join(icon_dir, fn), "rb") as fh:
                    z.writestr("muse_extension/icons/" + fn, fh.read())
    return buf.getvalue(), 200, {"Content-Type": "application/zip", "Content-Disposition": "attachment; filename=muse_extension.zip"}


@app.route("/connect")
def connect_page():
    return render_template("connect.html", token=access.bridge_token_for_page())


@app.route("/trieu-dinh")
def court_page():
    return render_template("court.html")


@app.route("/api/court/agents", methods=["GET"])
def court_agents():
    return jsonify(court.list_brains())


@app.route("/api/court/brain/<key>", methods=["POST"])
def court_save_brain(key):
    text = (request.json or {}).get("text", "")
    if not text.strip():
        return jsonify({"error": "Bộ não trống"}), 400
    try:
        court.write_brain(key, text)
    except KeyError:
        return jsonify({"error": "Không có bộ này"}), 404
    return jsonify({"success": True})


@app.route("/api/court/ask", methods=["POST"])
def court_ask():
    data = request.json or {}
    q = (data.get("question") or "").strip()
    if not q:
        return jsonify({"error": "Câu hỏi trống"}), 400
    to = data.get("to") or "auto"
    if not court.bridge_online():
        return jsonify({"error": "Chưa nối với tab muse.ai (đèn trạng thái chưa xanh)."}), 409
    return jsonify(court.start_run(q, to))


@app.route("/api/court/runs", methods=["GET"])
def court_runs():
    return jsonify(sorted(court.runs.values(), key=lambda r: r["started"], reverse=True))


@app.route("/api/court/tabs", methods=["GET"])
def court_tabs():
    return jsonify(court.list_tabs())


@app.route("/api/court/tabs/auto", methods=["POST"])
def court_auto_tabs():
    return jsonify({"tabs": court.auto_assign()})


@app.route("/api/court/tab/<tab_id>", methods=["POST"])
def court_set_tab(tab_id):
    t = court.set_tab(tab_id, request.json or {})
    return jsonify(court.tab_view(t)) if t else (jsonify({"error": "Không có tab này"}), 404)


@app.route("/api/court/tab/<tab_id>/forget", methods=["POST"])
def court_forget_tab(tab_id):
    return jsonify({"success": court.forget_tab(tab_id)})


@app.route("/api/court/clear", methods=["POST"])
def court_clear():
    return jsonify({"cleared": court.clear_runs()})


@app.route("/api/court/cancel/<rid>", methods=["POST"])
def court_cancel(rid):
    return jsonify({"success": court.cancel_run(rid)})


if __name__ == "__main__":
    print("=" * 60)
    print(" MUSE AI BRIDGE & CHAT TOOL IS RUNNING")
    print(" Mở trình duyệt tại: http://localhost:5000")
    print("=" * 60)
    try:
        host = os.environ.get("MUSE_HOST", "127.0.0.1")
        port = int(os.environ.get("MUSE_PORT", "5000"))
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as _s:
            _s.settimeout(1)
            if _s.connect_ex(("127.0.0.1", port)) == 0:     # Windows cho nhiều tiến trình cùng mở một cổng, nên tự chặn bản chạy trùng
                print(" Tool đã chạy sẵn ở cổng %d, không mở thêm bản thứ hai." % port)
                time.sleep(30)
                raise SystemExit(0)
        if access.PUBLIC:
            print(" CHẾ ĐỘ TÊN MIỀN: bắt buộc đăng nhập. Mật khẩu: %s" % access.PASSWORD)
            try:
                from waitress import serve
                serve(app, host=host, port=port, threads=24)
            except ImportError:
                app.run(host=host, port=port, debug=False, threaded=True)
        else:
            app.run(host=host, port=port, debug=False, threaded=True)
    except BaseException as _e:  # noqa
        import traceback
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.log"), "a", encoding="utf-8") as _f:
            _f.write("%s Tool dừng: %r\n%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), _e, traceback.format_exc()))
        raise
