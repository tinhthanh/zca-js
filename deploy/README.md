# zca-js - Triển khai bằng Docker (fork)

[English](README_EN.md)

Phần riêng của fork: đăng nhập Zalo bằng QR qua trang web nhỏ, chạy bot nhiều tài khoản trong một tiến trình Node và (tuỳ chọn) nối với omnichannel gateway. Mọi thứ nằm trong `deploy/`, không sửa file nào của upstream.

## 📂 Cấu trúc

```text
deploy/
├── docker-compose.yml          # chạy riêng: project "zalo-bot", volume zalo-data
├── Dockerfile                  # build dist/ từ source TypeScript, runtime node:22-alpine
├── Dockerfile.dockerignore     # ignore file riêng (BuildKit)
├── common.mjs                  # đường dẫn tài khoản, ghi JSON atomically (0600)
├── login.mjs                   # đăng nhập QR tại http://localhost:6081
├── bot.mjs                     # bot nhiều tài khoản, healthcheck, thử lại có giới hạn
├── gateway.mjs                 # nối omnichannel gateway (khi có GATEWAY_URL)
└── tests/deploy.test.mjs       # node:test
```

## 🚀 Chạy riêng

```bash
cd deploy
docker compose up -d --build     # login hiển thị QR tại http://localhost:6081, quét bằng app Zalo
ACCOUNT=acc2 docker compose run --rm --service-ports login   # thêm tài khoản
docker compose restart bot
```

-   `login` lưu `cookie`, `imei`, `userAgent` vào `/data/accounts/<ACCOUNT>/credentials.json` (quyền `0600`, thư mục `0700`) rồi tự dừng. Mỗi mã QR sống khoảng 100 giây; trang tự tạo mã mới tối đa `MAX_QR` lần (mặc định 5). Đăng nhập lại: thêm `FORCE_LOGIN=1`.
-   `bot` đăng nhập lại bằng credentials đã lưu, không cần quét QR. Lệnh thử: `/ping`, `/id`, `/help`.
-   Mỗi tài khoản chỉ chạy được một listener web; mở Zalo Web trên trình duyệt khi bot đang chạy sẽ ngắt listener của bot.

## 🔗 Chế độ omnichannel

Đặt `GATEWAY_URL` và `GATEWAY_TOKEN` (ít nhất 32 ký tự): mọi tin khách được chuyển tới gateway (`POST /v1/inbound`), bot mở `POST /send` tại `BOT_HTTP_PORT` (mặc định 7001) để nhận tin nhân viên trả lời, và lệnh `/ping`... bị tắt (`BOT_COMMANDS=1` để bật lại). Nhóm được gửi kèm tên nhóm (`getGroupInfo`, có cache). Ảnh, file, video, voice, GIF được tải từ CDN của Zalo (tối đa `GATEWAY_MAX_FILE_MB`, mặc định 20 MiB) và gửi kèm base64; sticker và link chỉ thành dòng mô tả. File nhân viên gửi đi bằng `sendMessage` với `{data, filename, metadata}`; kích thước ảnh PNG/JPEG/GIF/WebP được đọc từ header nên không cần `sharp`. Lỗi `ZaloApiError` có mã (Zalo từ chối hẳn) trả 422 để gateway không thử lại; lỗi khác trả 502. Stack đầy đủ nằm ở repo `omnichannel`.

## 🩺 Healthcheck và tài nguyên

-   Trạng thái từng tài khoản (`starting`, `running`, `retrying`, `dropped`) ghi vào `ZALO_HEALTH_FILE`; container `healthy` khi mọi tài khoản là `running`. Healthcheck dùng `grep` để không khởi động thêm tiến trình Node mỗi phút.
-   Tài khoản lỗi thử lại với backoff (30 giây, nhân đôi, tối đa 10 phút), bỏ sau 5 lần liên tiếp; khi mọi tài khoản bị bỏ, tiến trình vẫn chạy để không lặp lại đăng nhập hỏng.
-   Đo lúc rảnh: 1 tài khoản ~27 MiB, mỗi tài khoản thêm ~8-10 MiB; trang login ~30 MiB. Image 172 MB.

## 🧪 Test

```bash
docker compose build
docker run --rm -v "$PWD":/app/deploy:ro --entrypoint node zalo-bot --test deploy/tests/deploy.test.mjs
```

## 🔄 Đồng bộ với upstream

```bash
git fetch upstream && git merge upstream/main
cd deploy && docker compose build && docker compose up -d
```

Fork chỉ thêm `deploy/`, nên merge không conflict. Các API upstream mà deploy dùng: `Zalo` (`login`, `loginQR`), `LoginQRCallbackEventType` (import từ `dist/apis/loginQR.js`), `ThreadType`, `api.listener` (sự kiện `connected`, `disconnected`, `closed`, `error`, `message`), `api.sendMessage`, `api.getGroupInfo`, `api.getContext`.
