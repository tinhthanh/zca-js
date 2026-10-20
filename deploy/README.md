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
├── catchup.mjs                 # lấy lại tin bị lỡ khi bot không chạy
├── accounts.mjs                # /accounts: đăng nhập QR trong bot, kết nối lại, gỡ
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

### Trích dẫn và thu hồi tin nhân viên

- `POST /send` nhận thêm `reply_to` (msgId tin khách): bot nhớ dữ liệu 2048 tin khách gần nhất để gửi trích dẫn thật (`sendMessage({msg, quote})`, chỉ tin chữ). Trả về `{"ok": true, "message_ids": [...]}`.
- `POST /recall {account, thread_id, is_group, message_ids}`: `api.undo` cần cả `cliMsgId`, lấy từ tin bot tự nghe lại (selfListen); chưa nghe lại thì trả 409. Sự kiện `undo` của chính tin đó không ghi chú lặp (gateway đã ghi).

### Trạng thái khách và nhắn trước

- `typing` và `seen_messages` của khách → `POST /v1/presence` (`typing`, `read` kèm msgId); "đang soạn" gửi tối đa 3 giây/lần mỗi hội thoại.
- `POST /resolve {account, to}`: số điện thoại (`0…`, `+84…`, có dấu cách) → `findUser` → `{thread_id, name, avatar}` cho tính năng nhắn khách mới.

### Quản lý tài khoản (/accounts)

Khi bật gateway, server HTTP của bot (cùng `GATEWAY_TOKEN` với `/send`) có thêm các route cho trang **Channel accounts** của Libredesk (gateway gọi, không mở trực tiếp cho trình duyệt):

| Route | Việc |
|---|---|
| `GET /accounts` | Danh sách tài khoản: `name`, `state` (`starting`, `running`, `retrying`, `dropped`, `stopped`), `profile` (`uid`, `displayName`, `avatar`), `error` (lỗi gần nhất: `session_expired` khi Zalo từ chối credentials, cần quét QR lại; `connection` cho lỗi khác), phiên đăng nhập đang có |
| `POST /accounts/<tên>/login` | Bắt đầu đăng nhập QR ngay trong bot (tối đa `MAX_QR` mã) |
| `GET /accounts/<tên>/login` | Trạng thái: `qr` (kèm ảnh `data:image/png`), `scanned`, `confirming`, `success`, `error` |
| `POST /accounts/<tên>/restart` | Kết nối lại |
| `DELETE /accounts/<tên>` | Dừng và xoá thư mục tài khoản |

Đăng nhập thành công thì lưu `credentials.json` (0600) và chạy tài khoản ngay, không cần restart. Bot vẫn khởi động khi chưa có tài khoản nào (chế độ gateway) để thêm từ giao diện; chạy riêng không gateway thì vẫn cần ít nhất một tài khoản.

### Tin giàu nội dung và sự kiện

`content.mjs` (hàm thuần) chuyển từng loại tin thành dạng Libredesk hiển thị được, dựa trên payload thật ghi lại từ Zalo:

-   Sticker: tra ảnh qua `getStickersDetail` rồi gửi như ảnh đính kèm; doodle tải qua `href`.
-   Link (`chat.recommended`/`recommened.link`), danh thiếp (`recommened.user`), bình chọn (`group.poll`), vị trí (`chat.location.new`), việc cần làm (`chat.todo`): chữ có biểu tượng.
-   Trích dẫn (`data.quote`): gửi kèm trường `quote` = `Tên: nội dung`.
-   Video (`chat.video.msg`): tải file mp4 kèm dòng `🎬 Video · m:ss` (thời lượng trong `params`); chú thích (`title`) giữ lại. Giao diện Libredesk đã vá (`omnichannel/libredesk-ui`) phát video ngay trong khung chat.
-   Avatar: `thread_avatar` là `fullAvt`/`avt` của nhóm (`getGroupInfo`) hoặc `avatar` của người (`getUserInfo`), nhớ 6 giờ; tin nhóm gửi thêm `sender_avatar` của người gửi.
-   `undo`, `reaction`, `group_event`: gửi `POST /v1/event`, thành ghi chú nội bộ; nội dung tin bị thu hồi/được thả cảm xúc lấy từ bộ nhớ 4096 tin gần nhất (khoá `tài khoản:cliMsgId`).
-   `group_event` còn ghi: đổi cài đặt nhóm (so với lần trước bot thấy: `Khoá tạo bình chọn: bật`), đổi ảnh nhóm, xin vào nhóm, tham gia/từ chối nhắc hẹn; đổi tên/ảnh nhóm xoá cache để tin sau cập nhật tên/avatar. Ghi chú, nhắc hẹn, ghim ghi chú không ghi vì Zalo đã gửi tin hệ thống `webchat` (thành `ℹ️ Thông báo`).
-   `friend_event`: lời mời kết bạn từ người khác thành **tin của khách** `🤝 Lời mời kết bạn «lời chào»` (tạo hội thoại mới, chống trùng trong ngày); huỷ kết bạn, chặn/bỏ chặn, thu hồi/từ chối lời mời thành ghi chú `friend_event` nếu đã có hội thoại (kết bạn xong thì Zalo đã tự gửi "Bạn vừa kết bạn với ...", thành ghi chú ℹ️). Đã thử thật giữa hai tài khoản kiểm thử. zca-js đặt `threadId` của lời mời là `toUid` (có thể là chính mình), nên bot lấy phía còn lại.
-   Bot bật `selfListen` để thấy tin chủ tài khoản tự gửi từ điện thoại/ứng dụng khác (ghi chú `owner_message`); tin do bot gửi qua `/send` được nhận ra bằng `msgId` trả về hoặc trùng nội dung trong 60 giây và bỏ qua.
-   Tin bị lỡ khi bot không chạy (khởi động lại, mất mạng): mỗi tài khoản lưu mốc tin cuối (1-1 và nhóm) vào `catchup.json`; sau mỗi lần kết nối bot gọi `requestOldMessages` và chỉ chuyển tin mới hơn mốc, theo thứ tự thời gian (tin cũ bị thu hồi thành ghi chú thu hồi), log `Lấy lại N tin bị lỡ khi bot không chạy.`. Lần chạy đầu (chưa có mốc) không lấy lại lịch sử. Gateway cũng chống trùng theo ID tin.
-   `getGroupChatHistory` của zca-js hiện trả 404 nên không dùng.

## 🩺 Healthcheck và tài nguyên

-   Trạng thái từng tài khoản (`starting`, `running`, `retrying`, `dropped`) ghi vào `ZALO_HEALTH_FILE`; container `healthy` khi mọi tài khoản là `running`. Healthcheck dùng `grep` để không khởi động thêm tiến trình Node mỗi phút.
-   Tài khoản lỗi thử lại với backoff (30 giây, nhân đôi). Chỉ phiên hết hạn thật (Zalo từ chối credentials) mới dừng sau 2 lần; mất mạng thì thử lại mãi, tối đa mỗi 2 phút, có mạng lại là tự kết nối; khi mọi tài khoản bị bỏ, tiến trình vẫn chạy để không lặp lại đăng nhập hỏng.
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
