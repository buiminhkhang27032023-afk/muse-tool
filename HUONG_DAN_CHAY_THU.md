# Chạy thử nhanh (không cần code)

## 1. Chuẩn bị (1 phút)
1. Chạy `run.bat` (chỉ một cửa sổ, đừng bấm đúp lần nữa khi đang chạy).
2. Vào `chrome://extensions`, bấm **Reload** extension `D:\muse_extension`. F5 các tab ChatGPT, Gemini, Claude, Muse.
3. Mở `http://localhost:5000/trieu-dinh`, bấm **🔗 Tab Muse**. Tab nào hiện 🟢 rảnh là đã nối. Mỗi tab AI có huy hiệu 🐉 ở góc dưới trái.

## 2. Thử Sân Chơi (`http://localhost:5000/san-choi`)
- Chỉ tick **2 bot** (ví dụ ChatGPT và Gemini). Chủ đề ngắn, ví dụ "Mèo hay chó?". Số lượt = 4.
- Giữ ô "Gửi nguyên văn" và lời dặn mặc định. Bấm **Mở phòng và bắt đầu**, xem hai bot nói qua lại (mỗi lượt khoảng 5 đến 15 giây).
- Ổn rồi mới tăng lên 3 đến 5 bot. Đừng gõ vào tab chat khi phòng đang chạy.

## 3. Thử JARVIS (`http://localhost:5000/jarvis`)
- Gõ "alo". Câu trả lời của Muse phải hiện lại trên trang trong vài giây.

## 4. Thử hỏi từng con (`http://localhost:5000/trieu-dinh`)
- Ô **Giao cho** chọn một bộ, gõ câu ngắn, bấm **Ban lệnh**. Bảng "Đang giao cho con nào" ở đầu trang cho biết tài khoản nào đang làm.

## Nếu có lỗi
- Bước nào đứng quá 1 phút hoặc trả lời sai chỗ: chụp tab đó và Console gửi cho người hỗ trợ.
- Dòng đỏ `muse.ai/monitoring 429` là của trang Muse, bỏ qua.
- Dòng đỏ `ERR_CONNECTION_REFUSED` nghĩa là Tool đang tắt: chạy `run.bat`.
- Tab báo mất kết nối: F5 tab đó.
