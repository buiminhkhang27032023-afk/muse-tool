# Muse Tool — bản Node.js

Bản viết lại toàn bộ server (Triều Đình, Sân Chơi Bot, JARVIS, đăng nhập tên miền) từ Python/Flask sang Node.js/Express, giữ đúng các đường dẫn API và hành vi của bản Python ở thư mục gốc (`..`). Trang web (`templates/*.html`, `lang.html`), cầu nối trình duyệt (`muse_bridge.js`) và extension dùng chung với bản Python, không cần viết lại vì đã là JavaScript/HTML thuần.

## Chạy thử trên máy

```bash
cd node
npm install
npm start
```

Mở `http://localhost:5000`. Trên Windows có thể bấm `run_node.bat` (tự cài thư viện nếu thiếu, bỏ qua nếu đã có — giống `run.bat` của bản Python).

## Biến môi trường (giống bản Python)

| Biến | Ý nghĩa |
|---|---|
| `MUSE_PUBLIC=1` | Bật chế độ tên miền: bắt buộc đăng nhập |
| `MUSE_PASSWORD` | Mật khẩu (không đặt thì tự sinh ở `data/password.txt`) |
| `MUSE_HTTPS=1` | Cookie đăng nhập chỉ đi qua HTTPS |
| `MUSE_DATA` | Thư mục lưu dữ liệu (mặc định `node/data`) |
| `MUSE_HOST`, `MUSE_PORT` | Địa chỉ và cổng nghe (mặc định 127.0.0.1:5000) |

## Đưa lên máy ảo (Docker)

Build từ **gốc repo** (không phải từ trong `node/`), vì Dockerfile cần lấy cả `templates/`, `muse_bridge.js`, `lang.html`, `brains/`:

```bash
docker build -f node/Dockerfile -t muse-tool-node .
docker run -d -p 5000:5000 -v muse-data:/data --env-file .env muse-tool-node
```

Dùng chung `Caddyfile` ở gốc repo để có HTTPS (xem `../DEPLOY.md`).

## Cấu trúc

- `server.js` — điểm vào, các route chính (chat, trạng thái, bridge-script, extension.zip...)
- `lib/access.js` — đăng nhập, mã cho cầu nối, kho dữ liệu nhỏ của làng 3D
- `lib/court.js` — Triều Đình: sổ tab, hàng đợi việc, điều phối các bộ
- `lib/arena.js` — Sân Chơi Bot: phòng chat nhiều AI, bot webhook/openai/cli, upload media
- `lib/jarvis.js` — điều khiển máy bằng giọng nói (mở/đóng ứng dụng, khóa máy, âm lượng...)

Dữ liệu runtime (`data/`, gồm `arena_bots.json`, mật khẩu, bộ não đã sửa...) nằm riêng trong `node/data/`, không chung với bản Python, nên hai bản có thể chạy song song trên hai cổng khác nhau để thử nghiệm mà không ảnh hưởng nhau.

## cPanel · Setup Node.js App (CRM tại `/muse`)

Hosting Vietnix/cPanel không có Python Selector — dùng **Setup Node.js App**:

| Mục | Giá trị |
|---|---|
| Node.js version | **20** (hoặc 18; không dùng bản <18) |
| Application root | `/home/salemmon/muse` |
| Application URL | `crm.buihuuthang.com/muse` |
| Application startup file | `app.js` |
| Application mode | Production |
| Environment | `MUSE_PUBLIC=1`, `MUSE_HTTPS=1`, `MUSE_BASE=/muse`, `MUSE_DATA=/home/salemmon/muse/data`, `MUSE_PASSWORD=…` |

Sau khi tạo app: **Run NPM Install**, rồi **Restart**.

URL: `https://crm.buihuuthang.com/muse` → `/muse/login`. Extension: `/muse/connect` → **Tải extension**.

Cookie đăng nhập tên `muse_session`, Path=`/muse` (không đụng session CRM). Code chịu cả khi Passenger cắt prefix `/muse` lẫn khi giữ nguyên path.

## Sân Chơi Bot · timeout 240s (đã sửa)

Nguyên nhân: bản Node so sánh nhầm đơn vị thời gian trong `waitTask` — `Date.now()` (ms) với `taken` lưu bằng `nowS()` (giây) — nên vừa có tab nhận việc là bị báo "quá 240 giây không trả lời", trong khi extension vẫn lấy được câu và POST `/api/response`.

Đã sửa:
- `lib/court.js` dùng `nowS()` thống nhất (giống Python `time.time()`).
- Hàng đợi việc + kết quả ghi ra `MUSE_DATA/jobs/` (`lib/jobstore.js`) để chịu được nhiều worker Passenger/LiteSpeed.
- `.htaccess` + `Passengerfile.json` gợi ý `PassengerMaxInstancesPerApp 1`.

Deploy lại: giải nén đè lên `/home/salemmon/muse`, **không cần npm install** nếu `package.json` không đổi, rồi **Restart** app. Extension cũ vẫn dùng được; muốn log HTTP lỗi rõ hơn thì tải lại extension từ `/muse/connect`.
