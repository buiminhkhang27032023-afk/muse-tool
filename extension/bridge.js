/**
 * WEB BRIDGE SCRIPT (v2.6 - Muse, ChatGPT, Gemini, Claude, Grok; nhiều tab, huy hiệu, tự nối lại)
 * - Nhận việc từ Tool, điền vào ô chat của muse.ai, đọc câu trả lời gửi ngược về Tool.
 * - Mỗi tin của triều đình có cặp dấu [[T-id]] ... [[/T-id]]: cầu nối dựa vào dấu này để cắt đúng phần Muse trả lời.
 * - Muse được dặn kết thúc bằng dòng ###HET### nên biết chắc khi nào trả lời xong.
 * - Một tab chỉ xử lý một việc một lúc. Mỗi tab tự đăng ký với Tool; vào http://localhost:5000/trieu-dinh bấm "Tab Muse"
 *   để gán vai (Bệ Hạ, Công Bộ...), đặt tên, hạn mức mỗi ngày, tạm nghỉ. Tab chưa gán vai nhận việc của bộ chưa có tab riêng.
 * - Tool ở máy khác: chạy museSetApi('http://IP-máy-chạy-tool:5000') trong Console của tab.
 */
(function() {
    if (window.__MUSE_BRIDGE_RUNNING__) { console.log("[MUSE BRIDGE] Đã chạy sẵn trong tab này."); return; }
    window.__MUSE_BRIDGE_RUNNING__ = true;

    let TOOL_API = "http://127.0.0.1:5000";
    let TOOL_TOKEN = "";
    try { TOOL_API = localStorage.getItem("museApi") || TOOL_API; TOOL_TOKEN = localStorage.getItem("museToken") || TOOL_TOKEN; } catch (e) {}
    window.museSetToken = function(t) { TOOL_TOKEN = t; try { localStorage.setItem("museToken", t); } catch (e) {} };
    const authHeaders = () => (TOOL_TOKEN ? { "X-Muse-Token": TOOL_TOKEN } : {});
    window.museSetApi = function(u) { TOOL_API = u; try { localStorage.setItem("museApi", u); } catch (e) {} console.log("[MUSE BRIDGE] Tool ở: " + u); };
    const END_MARK = "###HET###";
    // Trang đang mở là của AI nào (để biết cách điền ô chat và nút gửi)
    const HOST = window.__MUSE_FORCE_HOST || location.hostname;
    const PROVIDER = /(^|\.)muse\.ai$/.test(HOST) ? "muse"
        : /(^|\.)(chatgpt\.com|openai\.com)$/.test(HOST) ? "chatgpt"
        : /(^|\.)gemini\.google\.com$/.test(HOST) ? "gemini"
        : /(^|\.)claude\.ai$/.test(HOST) ? "claude"
        : (/(^|\.)grok\.com$/.test(HOST) || (/(^|\.)x\.com$/.test(HOST) && /grok/i.test(location.pathname))) ? "grok" : "other";
    const INPUT_SEL = {
        chatgpt: ['#prompt-textarea', 'div[contenteditable="true"][id*="prompt"]', 'textarea[data-id]'],
        claude: ['div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"][data-testid*="input"]', 'fieldset div[contenteditable="true"]'],
        gemini: ['rich-textarea div[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]'],
        grok: ['textarea[aria-label*="Grok" i]', 'textarea', 'div[contenteditable="true"]']
    };
    const SEND_SEL = {
        chatgpt: ['#composer-submit-button', 'button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="Gửi" i]'],
        claude: ['button[aria-label*="Send" i]', 'button[aria-label*="Gửi" i]'],
        gemini: ['button[aria-label*="Send" i]', 'button[aria-label*="Gửi" i]', 'button.send-button'],
        grok: ['button[type="submit"]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]']
    };
    const NOISE = new Set(["More", "Copy", "Edit", "...", "Share", "Retry", "Regenerate", "Good response", "Bad response", "Copy code", "Read aloud", "Show thinking", "Show drafts"]);
    const NOISE_RE = /^(ChatGPT said:?|You said:?|Claude responded:?|Gemini said:?|Grok said:?|(Gemini|ChatGPT|Grok) đã nói:?|Claude đã (phản hồi|nói):?|Bạn đã nói:?|Message collapsed|Show more|Show less|Xem thêm|Thu gọn|just now|\d+ (seconds?|minutes?|giây|phút) ago|vừa xong|Thought for .*|Đã suy nghĩ .*|Thinking…?|Đang suy nghĩ…?|[\uE000-\uF8FF\s]+)$/i;
    console.log("%c[MUSE BRIDGE v2.0] Đang khởi động...", "color: #10b981; font-weight: bold; font-size: 14px;");

    // Mỗi tab tự có một mã riêng (nhớ trong trình duyệt/profile này). Vai trò (Bệ Hạ, Công Bộ...) gán ngay trên giao diện Tool.
    let TAB_ID = "", LABEL = "", AGENT = "*";
    try {
        TAB_ID = localStorage.getItem("museTabId") || "";
        if (!TAB_ID) { TAB_ID = "t" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); localStorage.setItem("museTabId", TAB_ID); }
        LABEL = localStorage.getItem("museLabel") || "";
        AGENT = localStorage.getItem("museAgent") || "*";
    } catch (e) { TAB_ID = "t" + Math.random().toString(36).slice(2, 10); }
    if (!LABEL) LABEL = (navigator.userAgentData && navigator.userAgentData.platform || navigator.platform || "Tab") + " " + TAB_ID.slice(-4);
    window.museSetLabel = function(l) { LABEL = l; try { localStorage.setItem("museLabel", l); } catch (e) {} };
    // (tùy chọn) gợi ý vai trò ngay từ đầu; sau đó Tool giữ vai trò đã gán
    window.museSetAgent = function(a) { AGENT = a || "*"; try { localStorage.setItem("museAgent", AGENT); } catch (e) {} console.log("[MUSE BRIDGE] Gợi ý vai trò: " + AGENT); };

    let busy = false;

    /* Đồng hồ: tab ở nền bị trình duyệt làm chậm bộ đếm giờ (có khi chỉ chạy 1 lần mỗi phút), nên cầu nối sẽ đứng khi bạn không mở tab.
       Extension có tiến trình nền (background.js) gửi nhịp "tick" mỗi 0,5 giây qua một cổng; tin nhắn không bị làm chậm kể cả khi tab ẩn.
       after(ms, fn) chạy fn bằng nhịp đó, và vẫn có setTimeout thường làm dự phòng (dán vào Console hoặc dấu trang thì chỉ có dự phòng). */
    let clockPort = null, tickN = 0;
    const clockTimers = [];
    function onTick() {
        tickN++;
        if (tickN % 8 === 0) { try { clockPort.postMessage({ t: "hb" }); } catch (e) {} }   // báo còn sống để tiến trình nền không bị tắt
        const now = Date.now();
        for (const t of clockTimers.slice()) {
            if (now >= t.at) { const i = clockTimers.indexOf(t); if (i >= 0) { clockTimers.splice(i, 1); try { t.fn(); } catch (e) {} } }
        }
    }
    function startClock() {
        try {
            if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.connect) return;
            clockPort = chrome.runtime.connect({ name: "muse-clock" });
            clockPort.onMessage.addListener(onTick);
            clockPort.onDisconnect.addListener(() => { clockPort = null; setTimeout(startClock, 2000); });
        } catch (e) { clockPort = null; }
    }
    function after(ms, fn) {
        const t = { at: Date.now() + ms, fn: fn };
        clockTimers.push(t);
        setTimeout(() => { const i = clockTimers.indexOf(t); if (i >= 0) { clockTimers.splice(i, 1); try { fn(); } catch (e) {} } }, ms + 100);
    }
    function every(ms, fn) {
        let on = true;
        const h = { stop: function() { on = false; } };
        const run = async () => { if (!on) return; try { await fn(); } catch (e) {} if (on) after(ms, run); };
        after(ms, run);
        return h;
    }

    function findChatInput() {
        const selectors = (INPUT_SEL[PROVIDER] || []).concat([
            'textarea[placeholder*="Message" i]',
            'input[placeholder*="Message" i]',
            'div[contenteditable="true"]',
            'textarea',
            'input[type="text"]'
        ]);
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return el;
        }
        return null;
    }

    function setInputText(inputEl, text) {
        inputEl.focus();
        if (inputEl.isContentEditable) {
            // ô chat của ChatGPT, Claude, Gemini là trình soạn thảo: phải chèn chữ như người gõ thì nó mới nhận
            const sel = window.getSelection(), range = document.createRange();
            range.selectNodeContents(inputEl); sel.removeAllRanges(); sel.addRange(range);
            let ok = false;
            try { ok = document.execCommand('insertText', false, text); } catch (e) {}
            if (!ok || !(inputEl.innerText || "").trim()) {
                inputEl.textContent = text;
                inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            }
        } else {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set ||
                           Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            if (setter) setter.call(inputEl, text); else inputEl.value = text;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
    function inputIsEmpty(inputEl) { return !((inputEl.value !== undefined ? inputEl.value : inputEl.innerText) || "").trim(); }
    function findSendButton(inputEl) {
        for (const sel of (SEND_SEL[PROVIDER] || [])) {
            for (const b of document.querySelectorAll(sel)) { if (b.offsetParent !== null && !b.disabled) return b; }
        }
        if (PROVIDER !== "muse") {
            // Trang AI khác: tìm nút gửi quanh ô chat, bỏ nút đính kèm, micro, công cụ...; ưu tiên nút submit hoặc nút có chữ gửi, không có thì lấy nút nằm bên phải nhất
            const BAD = /attach|upload|file|photo|image|mic|voice|dictat|record|tools|menu|more|search|reason|think|đính|tải|ảnh|thêm|ghi âm|thoại|giọng|suy luận|tìm|công cụ/i;
            let scope = inputEl.closest('form') || inputEl;
            for (let i = 0; i < 4 && scope.parentElement && !scope.querySelector('button[type="submit"], button[aria-label]'); i++) scope = scope.parentElement;
            const cands = [];
            for (const b of scope.querySelectorAll('button, [role="button"]')) {
                if (b.offsetParent === null || b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
                const label = ((b.getAttribute('aria-label') || "") + " " + (b.title || "") + " " + (b.innerText || "")).trim();
                if (BAD.test(label)) continue;
                cands.push({ b: b, label: label, r: b.getBoundingClientRect() });
            }
            const named = cands.find(c => c.b.type === "submit" || /send|submit|gửi|enviar|envoyer/i.test(c.label));
            if (named) return named.b;
            cands.sort((x, y) => y.r.right - x.r.right);
            return cands.length ? cands[0].b : null;
        }
        const parent = inputEl.closest('form') || inputEl.parentElement?.parentElement;
        if (parent) {
            for (const btn of parent.querySelectorAll('button')) {
                if (btn.querySelector('svg') || btn.innerText.match(/send|gửi/i) || btn.getAttribute('aria-label')?.match(/send/i)) return btn;
            }
        }
        return null;
    }
    function pressEnter(inputEl) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
            inputEl.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
    }
    function submitMessage(inputEl, text) {
        setInputText(inputEl, text);
        after(150, () => {
            const sendBtn = findSendButton(inputEl);
            if (sendBtn && !sendBtn.disabled) sendBtn.click(); else pressEnter(inputEl);
            // nếu chữ vẫn còn trong ô sau 1,5 giây nghĩa là chưa gửi được: thử Enter
            after(1500, () => { if (!inputIsEmpty(inputEl)) pressEnter(inputEl); });
        });
    }

    function cleanLines(text) {
        return text.split("\n").map(s => s.replace(/\s+$/, "")).filter(s => !NOISE.has(s.trim()) && !NOISE_RE.test(s.trim())).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    }

    function extractMediaMarkdown(box) {
        if (!box) return "";
        const media = [];
        try {
            // Quét các ảnh được tạo (bỏ qua avatar/icon/emoji)
            const imgs = box.querySelectorAll('img');
            for (const img of imgs) {
                const src = img.currentSrc || img.src || img.getAttribute('src') || '';
                if (!src) continue;
                if (src.startsWith('data:image/svg') || src.includes('avatar') || src.includes('emoji') || src.includes('favicon')) continue;
                const w = img.naturalWidth || img.clientWidth || img.width || 0;
                const h = img.naturalHeight || img.clientHeight || img.height || 0;
                if (w > 0 && w < 50 && h > 0 && h < 50) continue;
                const md = `\n\n![Ảnh do AI tạo](${src})\n\n`;
                if (!media.includes(md)) media.push(md);
            }
            // Quét các video được tạo
            const vids = box.querySelectorAll('video');
            for (const vid of vids) {
                const src = vid.currentSrc || vid.src || vid.querySelector('source')?.src || '';
                if (src) {
                    const md = `\n\n[VIDEO: ${src}]\n\n`;
                    if (!media.includes(md)) media.push(md);
                }
            }
        } catch (e) {}
        return media.join("");
    }

    /* Cách 1 (chính): tìm dấu kết thúc [[/T-id]] của tin mình gửi, lấy toàn bộ chữ nằm SAU dấu đó trong khung chat giữa. */
    function replyByToken(promptId) {
        const endTok = "[[/T-" + promptId + "]]";
        const inputEl = findChatInput();
        const all = Array.from(document.querySelectorAll('body *'));
        // phần tử sâu nhất chứa dấu kết thúc (trừ ô gõ phím)
        let endEl = null;
        for (let i = all.length - 1; i >= 0; i--) {
            const el = all[i];
            if (inputEl && (el === inputEl || inputEl.contains(el) || el.contains(inputEl))) continue;
            if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
            if ((el.textContent || "").indexOf(endTok) < 0) continue;
            if (Array.from(el.children).some(c => (c.textContent || "").indexOf(endTok) >= 0)) continue;
            endEl = el; break;
        }
        if (!endEl) return null;
        // leo lên tới khung lớn nhất vẫn nằm giữa màn hình và không chứa ô gõ phím
        let box = endEl;
        while (box.parentElement && box.parentElement !== document.body) {
            const p = box.parentElement, r = p.getBoundingClientRect();
            if (inputEl && p.contains(inputEl)) break;
            // Muse có thanh bên trái và phải nên cần lọc theo vị trí; các trang AI khác thì leo đến khi gặp ô gõ chữ
            if (PROVIDER === "muse" && window.innerWidth > 400 && (r.left < 120 || r.right > window.innerWidth - 200)) break;
            box = p;
        }
        const full = (box.innerText || "");
        const at = full.lastIndexOf(endTok);
        if (at < 0) return "";
        const textPart = cleanLines(full.slice(at + endTok.length));
        const mediaPart = extractMediaMarkdown(box);
        return (textPart + mediaPart).trim();
    }

    /* Cách 2 (dự phòng, như bản cũ): dò theo vị trí hình học các dòng chữ nằm dưới tin của mình. */
    function replyByGeometry(userText) {
        const inputEl = findChatInput();
        const inputTop = inputEl ? inputEl.getBoundingClientRect().top : window.innerHeight - 80;
        const all = Array.from(document.querySelectorAll('*'));
        const head = userText.trim().split("\n")[0].trim();
        let userEl = null;
        for (let i = all.length - 1; i >= 0; i--) {
            const el = all[i];
            if (el.children.length === 0 && el.textContent && el.textContent.trim() === head) {
                const rect = el.getBoundingClientRect();
                if (rect.left > 180 && rect.right < window.innerWidth - 260 && rect.top < inputTop) { userEl = el; break; }
            }
        }
        if (!userEl) return "";
        const userRect = userEl.getBoundingClientRect();
        const out = [];
        for (const el of all.slice(all.indexOf(userEl) + 1)) {
            if (el.children.length > 0) continue;
            const r = el.getBoundingClientRect();
            if (r.left >= 180 && r.right <= window.innerWidth - 260 && r.top >= userRect.top && r.bottom <= inputTop + 15) {
                const t = el.textContent.trim();
                if (t && !NOISE.has(t) && t !== head) out.push(t);
            }
        }
        return Array.from(new Set(out)).join("\n").trim();
    }

    /* ----- Việc "nguyên văn": gửi đúng chữ, không có dấu hiệu nào đi kèm, nên tìm câu trả lời bằng cách tìm chính câu mình vừa gửi ----- */
    function rawMarker(text) {
        const lines = String(text).split("\n").map(s => s.trim()).filter(Boolean);
        return (lines.length ? lines[lines.length - 1] : String(text).trim()).slice(-60);
    }
    function markerRegex(marker) {
        const toks = marker.split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        return new RegExp(toks.join("\\s+"), "g");
    }
    function countOcc(marker) {
        const re = markerRegex(marker);
        const inBody = (document.body.innerText || "").match(re);
        const inp = findChatInput();
        // chữ nằm trong ô soạn (trình soạn thảo) cũng được tính vào innerText của trang, phải trừ ra
        const own = (inp && inp.isContentEditable) ? ((inp.innerText || "").match(re) || []).length : 0;
        return Math.max(0, (inBody ? inBody.length : 0) - own);
    }
    function replyAfterMarker(marker, before) {
        if (countOcc(marker) <= before) return null;        // tin mình vừa gửi chưa hiện lên
        const re = markerRegex(marker), inputEl = findChatInput();
        const all = Array.from(document.querySelectorAll('body *'));
        let endEl = null;
        for (let i = all.length - 1; i >= 0; i--) {
            const el = all[i];
            if (inputEl && (el === inputEl || inputEl.contains(el) || el.contains(inputEl))) continue;
            if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
            re.lastIndex = 0; if (!re.test(el.textContent || "")) continue;
            if (Array.from(el.children).some(c => { re.lastIndex = 0; return re.test(c.textContent || ""); })) continue;
            endEl = el; break;
        }
        if (!endEl) return null;
        let box = endEl;
        while (box.parentElement && box.parentElement !== document.body) {
            const p = box.parentElement, r = p.getBoundingClientRect();
            if (inputEl && p.contains(inputEl)) break;
            if (PROVIDER === "muse" && window.innerWidth > 400 && (r.left < 120 || r.right > window.innerWidth - 200)) break;
            box = p;
        }
        const full = box.innerText || "";
        let last = null, m; re.lastIndex = 0;
        while ((m = re.exec(full)) !== null) { last = m; if (m[0].length === 0) re.lastIndex++; }
        if (!last) return "";
        const textPart = cleanLines(full.slice(last.index + last[0].length));
        const mediaPart = extractMediaMarkdown(box);
        return (textPart + mediaPart).trim();
    }
    function isGenerating() {
        for (const b of document.querySelectorAll('button, [role="button"]')) {
            if (b.offsetParent === null) continue;
            const t = ((b.getAttribute('aria-label') || "") + " " + (b.getAttribute('data-testid') || "") + " " + (b.title || "")).toLowerCase();
            if (/stop|dừng|ngừng/.test(t)) return true;
        }
        return false;
    }
    function watchRaw(task, marker, before) {
        let attempts = 0, lastText = "", stable = 0;
        const interval = every(500, async () => {
            attempts++;
            const cur = replyAfterMarker(marker, before);
            if (cur && cur.trim()) {
                if (cur === lastText) stable++; else { lastText = cur; stable = 0; sendResponseToTool(task.id, cur, false); }
                if (stable >= (isGenerating() ? 30 : 3)) {            // đứng yên 1,5 giây và không còn nút "dừng" (hoặc 15 giây nếu còn nút dừng): coi như xong
                    interval.stop(); busy = false;
                    await sendResponseToTool(task.id, lastText, true);
                    console.log("%c[MUSE BRIDGE] Đã lấy câu trả lời (nguyên văn) -> gửi về Tool.", "color:#10b981;font-weight:bold;");
                    return;
                }
            }
            if (attempts > 600) { interval.stop(); busy = false; if (lastText) sendResponseToTool(task.id, lastText, true); }
        });
    }

    function detectReply(task) {
        let r = replyByToken(task.id);
        if (r === null) r = replyByGeometry(task.text);
        return r || "";
    }

    async function sendResponseToTool(promptId, text, isFinal) {
        if (!text || text === "More") return;
        try {
            const res = await fetch(TOOL_API + "/api/response", {
                method: "POST",
                headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
                body: JSON.stringify({ prompt_id: promptId, text: text, is_final: isFinal })
            });
            if (!res.ok) {
                console.warn("[MUSE BRIDGE] Gửi trả lời thất bại HTTP " + res.status + " -> " + TOOL_API + "/api/response");
            }
        } catch (e) {
            console.warn("[MUSE BRIDGE] Không gửi được trả lời về Tool:", e && e.message ? e.message : e);
        }
    }

    function watchResponse(task) {
        let attempts = 0, lastText = "", stable = 0;
        const MAX = 600;          // tối đa 5 phút (mỗi 0,5 giây một lần)
        const interval = every(500, async () => {
            attempts++;
            const cur = detectReply(task);
            if (cur) {
                const done = cur.indexOf(END_MARK) >= 0;
                const shown = cur.replace(END_MARK, "").trim();
                if (done) {
                    interval.stop(); busy = false;
                    await sendResponseToTool(task.id, shown || cur, true);
                    console.log("%c[MUSE BRIDGE] Muse trả lời xong -> gửi về Tool.", "color:#10b981;font-weight:bold;");
                    return;
                }
                if (shown !== lastText) {
                    lastText = shown; stable = 0;
                    sendResponseToTool(task.id, shown, false);
                } else if (++stable >= 12) {          // 6 giây không đổi và Muse quên dòng kết thúc
                    interval.stop(); busy = false;
                    await sendResponseToTool(task.id, shown, true);
                    console.log("[MUSE BRIDGE] Hết đổi nội dung -> coi như xong.");
                    return;
                }
            }
            if (attempts > MAX) {
                interval.stop(); busy = false;
                if (lastText) sendResponseToTool(task.id, lastText, true);
            }
        });
    }

    /* Huy hiệu góc màn hình + tiêu đề tab: nhìn là biết tab/tài khoản này đang đóng vai nào. Tool bấm "Nhận diện" thì nhấp nháy. */
    let badge = null;
    function applyBadge(info) {
        if (!info) return;
        const roles = (info.roles && info.roles.length) ? info.roles.join(" + ") : "Tự do";
        const text = "🐉 " + info.label + " · " + roles;
        try {
            const base = document.title.replace(/^\[[^\]]*\] /, "");
            const want = "[" + info.label + "] " + base;
            if (document.title !== want) document.title = want;
        } catch (e) {}
        if (!badge || !document.body.contains(badge)) {
            badge = document.createElement("div");
            badge.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:6px 12px;border-radius:999px;background:#7f1d1d;color:#fff;font:600 12px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4);pointer-events:none;opacity:.92";
            document.body.appendChild(badge);
        }
        if (badge.textContent !== text) badge.textContent = text;
        if (info.flash) {
            badge.style.background = "#f59e0b"; badge.style.color = "#111"; badge.style.fontSize = "22px"; badge.style.padding = "12px 22px";
        } else {
            badge.style.background = "#7f1d1d"; badge.style.color = "#fff"; badge.style.fontSize = "12px"; badge.style.padding = "6px 12px";
        }
    }

    let failCount = 0;
    async function checkPendingTasks() {
        if (busy) return;
        try {
            const res = await fetch(TOOL_API + "/api/poll-pending?tab=" + encodeURIComponent(TAB_ID) + "&label=" + encodeURIComponent(LABEL) + "&provider=" + PROVIDER + "&agent=" + encodeURIComponent(AGENT), { headers: authHeaders() });
            if (!res.ok) return;
            if (failCount > 0) console.log("%c[MUSE BRIDGE] Đã nối lại với Tool.", "color:#10b981;font-weight:bold;");
            failCount = 0;
            const data = await res.json();
            if (data.tab) applyBadge(data.tab);
            if (data.has_task && data.task) {
                const inputEl = findChatInput();
                if (!inputEl) { console.warn("[MUSE BRIDGE] Không thấy ô chat trên trang."); return; }
                busy = true;
                const hasMark = String(data.task.text || "").indexOf("[[T-" + data.task.id + "]]") >= 0;
                console.log("%c[MUSE BRIDGE] Nhận việc:", "color:#3b82f6;font-weight:bold;", data.task.id, (data.task.raw || !hasMark) ? "(nguyên văn)" : "");
                if (data.task.raw || !hasMark) {
                    const marker = rawMarker(data.task.text), before = countOcc(marker);
                    submitMessage(inputEl, data.task.text);
                    watchRaw(data.task, marker, before);
                } else {
                    submitMessage(inputEl, data.task.text);
                    watchResponse(data.task);
                }
            }
        } catch (err) {
            // Tool đang tắt hoặc đang khởi động lại: im lặng thử lại, thưa dần để Console không đầy lỗi đỏ
            if (failCount++ === 0) console.warn("[MUSE BRIDGE] Chưa liên lạc được Tool (" + TOOL_API + "). Sẽ tự thử lại, mở run.bat nếu Tool chưa chạy.");
        }
    }
    function loop() {
        checkPendingTasks().finally(() => after(Math.min(30000, 500 + failCount * 3000), loop));
    }

    window.__MUSE_BRIDGE__ = { replyByToken: replyByToken, replyByGeometry: replyByGeometry, cleanLines: cleanLines, replyAfterMarker: replyAfterMarker, countOcc: countOcc, rawMarker: rawMarker };
    startClock();
    loop();
    console.log("%c[MUSE BRIDGE v2.6] ĐÃ SẴN SÀNG! Trang: " + PROVIDER + ". Mã tab: " + TAB_ID + ". Gán vai trò tại " + TOOL_API + "/trieu-dinh", "background:#10b981;color:#fff;padding:4px 8px;border-radius:4px;font-weight:bold;");
})();
