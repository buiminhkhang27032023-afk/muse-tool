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
