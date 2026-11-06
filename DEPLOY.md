# Đưa Triều Đình lên tên miền

Mục tiêu: mở `https://tên-miền-của-bạn` ở máy nào cũng vào được làng 3D, ra lệnh cho Bệ Hạ, xem các bộ làm việc.
Toàn bộ dữ liệu (công vụ, nhật ký, tường hoa, lịch sử chỉ dụ, danh sách tab Muse, bộ não) nằm ở server đó, không phụ thuộc máy nào.

> Vì sao không dùng link claude.ai: trang đăng ở đó bị trình duyệt chặn không cho nối ra bất kỳ địa chỉ nào ngoài, nên không thể ra lệnh cho Muse. Bản đăng ở đó chỉ để xem. Bản dùng thật là bản chạy ở tên miền của bạn.

## Cách A · Thuê một máy chủ nhỏ (khuyên dùng, chạy 24/7)

1. Thuê VPS Ubuntu (khoảng 1 GB RAM là đủ). Cài Docker: `curl -fsSL https://get.docker.com | sh`
2. Mua tên miền, tạo bản ghi **A** trỏ về IP của VPS (ví dụ `trieudinh.tenmien.com`).
3. Chép cả thư mục `D:\tool muse` lên VPS (WinSCP, `scp -r`...), vào thư mục đó.
4. Tạo file `.env` từ mẫu:
   ```
   cp .env.example .env
   nano .env      # sửa DOMAIN và MUSE_PASSWORD
   ```
5. Chạy: `docker compose up -d --build`
6. Mở `https://tên-miền`, đăng nhập bằng `MUSE_PASSWORD`. Caddy tự xin chứng chỉ HTTPS (cần mở cổng 80 và 443).

Cập nhật sau này: chép đè file mới rồi `docker compose up -d --build`. Dữ liệu nằm trong volume `muse-data` nên không mất.

## Cách B · Vẫn chạy trên máy ở nhà nhưng truy cập qua tên miền

Dùng Cloudflare Tunnel (miễn phí, tên miền phải quản lý ở Cloudflare). Máy chạy Tool phải bật.
1. Cài `cloudflared`, đăng nhập, tạo tunnel trỏ `trieudinh.tenmien.com` về `http://localhost:5000` (làm theo hướng dẫn Cloudflare Zero Trust → Tunnels).
2. Trên máy ở nhà chạy `run_online.bat` (bật chế độ bắt buộc đăng nhập). Mật khẩu nằm ở `data\password.txt`, hoặc đặt biến `MUSE_PASSWORD` trước khi chạy.

## Nối các tài khoản Muse vào tên miền

Ở mỗi trình duyệt có tài khoản Muse (máy nào cũng được):
1. Mở `https://tên-miền/connect`, đăng nhập.
2. Bấm **Tải extension** (đã mang sẵn địa chỉ tên miền và mã bí mật), giải nén, cài ở `chrome://extensions` → Developer mode → Load unpacked. Firefox/Safari dùng nút dấu trang trên cùng trang đó.
3. Mở muse.ai, đăng nhập tài khoản Muse. Tab tự hiện ở Triều Đình → **🔗 Tab Muse**, đặt tên và gán vai.

Mỗi tài khoản Muse ở một trình duyệt hoặc profile riêng; các tab tự nối về cùng một tên miền nên máy nào, nước nào cũng được.

## Bảo mật (quan trọng)

- Trang chỉ vào được khi đăng nhập. Cầu nối dùng một mã riêng sinh từ mật khẩu; **đổi mật khẩu thì mã đổi theo** và phải tải lại extension.
- Mật khẩu dài, khó đoán. Ai có mật khẩu là ra lệnh được cho các tài khoản Muse của bạn.
- Luôn dùng HTTPS (Cách A tự có). Đừng mở cổng 5000 trực tiếp ra Internet.
- Sao lưu: thư mục `data` (hoặc volume `muse-data`).

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `MUSE_PUBLIC=1` | Bật chế độ tên miền: bắt buộc đăng nhập, dùng máy chủ waitress |
| `MUSE_PASSWORD` | Mật khẩu (không đặt thì tự sinh ở `data/password.txt`) |
| `MUSE_HTTPS=1` | Cookie đăng nhập chỉ đi qua HTTPS (đặt khi có HTTPS) |
| `MUSE_DATA` | Thư mục lưu dữ liệu |
| `MUSE_HOST`, `MUSE_PORT` | Địa chỉ và cổng nghe (mặc định 127.0.0.1:5000) |

## Khi sửa làng 3D

`lang.html` là bản build của làng 3D. Khi có bản mới, chép đè `lang.html` rồi khởi động lại.

## Cách C · cPanel Node.js (chung domain CRM tại `/muse`)

Bản chạy chính là **Node.js** trong thư mục `node/` (xem `node/README.md`). Trên Vietnix dùng **Setup Node.js App** (không cần Python):

| Mục | Giá trị |
|---|---|
| Node.js version | 20 (hoặc 18) |
| Application root | `/home/salemmon/muse` |
| Application URL | `crm.buihuuthang.com/muse` |
| Startup file | `app.js` |
| Environment | `MUSE_PUBLIC=1`, `MUSE_HTTPS=1`, `MUSE_BASE=/muse`, `MUSE_DATA=/home/salemmon/muse/data`, `MUSE_PASSWORD=…` |

Gói deploy: các file app ở gốc zip (`app.js`, `server.js`, `lib/`, `templates/`, `lang.html`, `muse_bridge.js`, `extension/`, `brains/`, `package.json`) — không kèm `node_modules`.
