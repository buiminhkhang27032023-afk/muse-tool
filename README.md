# MUSE AI TOOL — SYNC BRIDGE

Công cụ chat riêng kết nối đồng bộ trực tiếp với tab web **muse.ai** (Muse — Your Personal AI Agent).

---

## 🚀 Cách sử dụng siêu nhanh (3 bước)

### Bước 1: Khởi động Tool
- Nhấp đúp vào file `run.bat` (hoặc chạy lệnh `python server.py` trong thư mục này).
- Trình duyệt sẽ tự động mở giao diện tại: **http://localhost:5000**

### Bước 2: Nối dây vào tab web muse.ai
Bạn chọn **1 trong 2 cách** sau:

- **Cách A (Nhanh nhất - Không cần cài đặt)**:
  1. Mở tab trình duyệt đang có con Muse của bạn (`muse.ai`).
  2. Bấm phím `F12` (hoặc chuột phải chọn *Inspect*), chuyển sang tab **Console**.
  3. Mở file `muse_bridge.js` (hoặc bấm nút *"Copy mã"* trên giao diện Tool `localhost:5000`), dán vào Console rồi bấm **Enter**.
  4. Bạn sẽ thấy dòng chữ xanh: `[MUSE BRIDGE] ĐÃ SẴN SÀNG!`. Đèn trạng thái trên Tool sẽ chuyển sang màu xanh lá 🟢!

- **Cách B (Cài Extension để tự động vĩnh viễn)**:
  1. Vào trình duyệt Chrome $\rightarrow$ mở địa chỉ `chrome://extensions/`.
  2. Bật công tắc **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
  3. Bấm nút **Load unpacked** (Tải tiện ích đã giải nén) $\rightarrow$ chọn thư mục `D:\tool muse\extension`.
  4. Xong! Từ nay mỗi khi bạn mở `muse.ai`, tab web sẽ tự động kết nối với Tool!

---

## ⚡ Nguyên lý hoạt động
1. Bạn gõ prompt hoặc kịch bản video trên giao diện Tool `http://localhost:5000`.
2. Tool chuyển lệnh sang tab web `muse.ai`.
3. Tab web tự động điền prompt vào ô chat và gửi cho Muse.
4. Muse nhận lệnh, suy nghĩ và trả lời trực tiếp trên màn hình web `muse.ai`.
5. Đồng thời, câu trả lời của Muse cũng được bắt và hiển thị ngay trên giao diện Tool của bạn!

---

## 🐉 TRIỀU ĐÌNH (mới) — mỗi phòng ban một "bộ não" trong Muse

Mở **http://localhost:5000/trieu-dinh** (nút đỏ "Triều Đình" ở đầu trang chat).

1. Nối dây vào tab muse.ai như cũ (dán `muse_bridge.js` v2.0 vào Console, hoặc bấm Reload extension trong `chrome://extensions`).
2. Gõ chỉ dụ của Nhà Vua, chọn:
   - **Nội Các tự chia việc**: Nội Các chọn bộ phù hợp, giao việc, các bộ có thể hỏi nhau (`@hoi`), rồi Nội Các tổng hợp bản tâu.
   - **Hỏi thẳng một bộ**: bộ đó làm, được phép hỏi tối đa 2 bộ khác rồi hoàn thiện.
3. Xem diễn biến từng bước và bản tâu cuối ngay trên trang.

**Bộ não** nằm ở thư mục `brains/` (`noicac, cong, le, ho, binh, hinh, lai`.md), sửa trực tiếp file hoặc bấm nút 🧠 Bộ não trên giao diện. Mỗi lần giao việc, tool dán bộ não đó vào đầu tin gửi cho Muse.

**Một tab hay nhiều tab?**
- Một tab muse.ai: mọi bộ dùng chung một cuộc trò chuyện, làm lần lượt từng bước.
- Nhiều tab: ở mỗi tab muse.ai mở Console, gõ `museSetAgent('cong')` (hoặc `le, ho, binh, hinh, lai, noicac`). Tab đó chỉ nhận việc của bộ mình, mỗi bộ có cuộc trò chuyện riêng. Tab không gắn bộ nhận phần còn lại.

Lưu ý: cầu nối đọc chữ trên giao diện muse.ai, nếu muse.ai đổi giao diện có thể cần chỉnh `muse_bridge.js`. Server chỉ nghe ở 127.0.0.1.

### 🏯 Làng 3D nối thẳng vào Muse
Mở **http://localhost:5000/lang**. Bấm Điện Chính hoặc Bệ Hạ, gõ lệnh ở ô "Ra lệnh cho Bệ Hạ". Bệ Hạ chia việc xuống các bộ, quan trong làng hiện bong bóng nghĩ và nói, bộ này sang nhà bộ kia bàn bạc khi hỏi nhau, việc hiện lên Bảng Công Vụ, bản tâu về thì Bệ Hạ cầm sớ. File `lang.html` là bản build của làng 3D (chép đè khi có bản mới).

### 🌐 Đưa lên tên miền
Xem `DEPLOY.md`: chạy bằng Docker + HTTPS (VPS) hoặc qua Cloudflare Tunnel, bắt buộc đăng nhập, dữ liệu làng nằm trên server, cầu nối/extension tải từ `/connect` đã mang sẵn địa chỉ và mã bí mật. Trang `/` giờ mở thẳng làng 3D; chat thường ở `/chat`.
