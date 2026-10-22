# zca-js - Docker deployment (fork)

[Tiếng Việt](README.md)

The fork-only part of this repository: Zalo QR sign-in through a small web page, a multi-account bot in one Node process and (optionally) a link to the omnichannel gateway. Everything lives in `deploy/`; no upstream file is modified.

## 📂 Layout

```text
deploy/
├── docker-compose.yml          # standalone: project "zalo-bot", volume zalo-data
├── Dockerfile                  # builds dist/ from the TypeScript source, node:22-alpine runtime
├── Dockerfile.dockerignore     # per-Dockerfile ignore file (BuildKit)
├── common.mjs                  # account paths, atomic JSON writes (0600)
├── login.mjs                   # QR sign-in at http://localhost:6081
├── bot.mjs                     # multi-account bot, healthcheck, bounded retries
├── gateway.mjs                 # omnichannel gateway link (when GATEWAY_URL is set)
├── catchup.mjs                 # recovers messages missed while the bot was down
├── accounts.mjs                # /accounts: QR sign-in inside the bot, reconnect, remove
├── content.mjs                 # turns each Zalo message type into Libredesk content (pure functions)
├── watchdog.mjs                # cuts sockets silent longer than ZALO_WATCHDOG_STALE_MS
├── history.mjs                 # per-account connection history (history.json)
└── tests/deploy.test.mjs       # node:test
```

## 🚀 Standalone

```bash
cd deploy
docker compose up -d --build     # login shows a QR at http://localhost:6081; scan it with the Zalo app
ACCOUNT=acc2 docker compose run --rm --service-ports login   # add an account
docker compose restart bot
```

-   `login` stores `cookie`, `imei` and `userAgent` in `/data/accounts/<ACCOUNT>/credentials.json` (mode `0600`, directory `0700`) and exits. Each QR code lives about 100 seconds; the page generates a new one up to `MAX_QR` times (default 5). Sign in again with `FORCE_LOGIN=1`.
-   `bot` signs in again from the stored credentials without a new QR scan. Test commands: `/ping`, `/id`, `/help`.
-   Each account supports one web listener; opening Zalo Web in a browser while the bot runs disconnects the bot's listener.

## 🔗 Omnichannel mode

Set `GATEWAY_URL` and `GATEWAY_TOKEN` (at least 32 characters): every customer message is forwarded to the gateway (`POST /v1/inbound`), the bot serves `POST /send` on `BOT_HTTP_PORT` (default 7001) for agent replies, and `/ping`-style commands are disabled (`BOT_COMMANDS=1` to keep them). Groups carry the group name (`getGroupInfo`, cached). Images, files, videos, voice notes and GIFs are downloaded from Zalo's CDN (up to `GATEWAY_MAX_FILE_MB`, default 20 MiB) and sent as base64; stickers and links become a one-line description. Agent files go out through `sendMessage` with `{data, filename, metadata}`; PNG/JPEG/GIF/WebP dimensions are read from the header, so `sharp` is not needed. When each account connects, the bot calls `POST /v1/register` so the gateway creates the inbox early (if that fails, the gateway creates it on the first message). A `ZaloApiError` with a code (Zalo refused the message) returns 422 so the gateway does not retry; other failures return 502. The full stack lives in the `omnichannel` repository.

### Quoting and recalling agent replies

- `POST /send` also takes `reply_to` (msgId of a customer message): the bot keeps the data of the last 2048 customer messages to send a native quote (`sendMessage({msg, quote})`, text only). It returns `{"ok": true, "message_ids": [...]}`.
- `audio/*` files in `attachments` are sent as Zalo **voice messages** (`uploadAttachment` for the URL, then `sendVoice`); if that fails the file is sent as a plain attachment so the customer still gets it. Other files and text go through `sendMessage` as before.
- `POST /react {account, thread_id, is_group, message_id, emoji}`: an agent reacts to a customer message with `api.addReaction` (❤️ 👍 😆 😮 😢 😡; empty `emoji` removes). It needs the original `msgId` and `cliMsgId` from the message memory (saved to disk, so it survives restarts); 409 when the message is unknown.
- `POST /recall {account, thread_id, is_group, message_ids}`: `api.undo` needs the `cliMsgId` too, taken from the bot hearing its own message (selfListen); before that it answers 409. The `undo` event of that message is not noted twice (the gateway already did).

### Customer state and messaging first

- Customer `typing` and `seen_messages` → `POST /v1/presence` (`typing`, `read` with msgIds); typing is sent at most every 3 seconds per thread.
- `POST /resolve {account, to}`: a phone number (`0…`, `+84…`, with spaces) → `findUser` → `{thread_id, name, avatar}` for messaging a new customer.

### Account management (/accounts)

With the gateway enabled, the bot's HTTP server (same `GATEWAY_TOKEN` as `/send`) also serves routes for the Libredesk **Channel accounts** page (called by the gateway, never exposed to browsers):

| Route | Action |
|---|---|
| `GET /accounts` | Accounts: `name`, `state` (`starting`, `running`, `retrying`, `dropped`, `stopped`), `profile` (`uid`, `displayName`, `avatar`), `error` (last error: `session_expired` when Zalo rejects the credentials, scan a QR again; `connection` otherwise; on expiry `message` adds "Nguyên nhân: …" with the Zalo error code), `history` (connection history, newest first: `at`, `kind` `connected`/`manual`/`network`/`disconnected`/`platform`/`session_expired`, `message`, `count`/`last_at`; close code 1006 = network, 3000 = duplicate Zalo Web/PC connection, 3003 = kicked by Zalo; the watchdog cutting a silent socket is `network`; saved in `<account>/history.json` 0600, at most 30 entries), current sign-in session |
| `POST /accounts/<name>/login` | Start a QR sign-in inside the bot (up to `MAX_QR` codes) |
| `GET /accounts/<name>/login` | Status: `qr` (with a `data:image/png` image), `scanned`, `confirming`, `success`, `error` |
| `POST /accounts/<name>/restart` | Reconnect |
| `DELETE /accounts/<name>` | Stop and delete the account directory |

A successful sign-in writes `credentials.json` (0600) and starts the account right away, no restart needed. In gateway mode the bot also starts with no accounts so they can be added from the UI; standalone (no gateway) still needs at least one account.

### Rich content and events

`content.mjs` (pure functions) turns each message type into something Libredesk can show, based on real payloads captured from Zalo:

-   Stickers: the image is looked up through `getStickersDetail` and sent as an image attachment; doodles are downloaded from `href`.
-   Links (`chat.recommended`/`recommened.link`), contact cards (`recommened.user`), polls (`group.poll`), locations (`chat.location.new`) and to-dos (`chat.todo`): text with an icon.
-   Quotes (`data.quote`): sent as the `quote` field, `Name: text`.
-   Videos (`chat.video.msg`): the mp4 is attached with a `🎬 Video · m:ss` line (duration from `params`); the caption (`title`) is kept. The patched Libredesk UI (`omnichannel/libredesk-ui`) plays videos inline.
-   Avatars: `thread_avatar` is the group's `fullAvt`/`avt` (`getGroupInfo`) or the person's `avatar` (`getUserInfo`), cached for 6 hours; group messages also send the sender's `sender_avatar`.
-   `undo`, `reaction` and `group_event` go to `POST /v1/event` and become private notes; the recalled/reacted message text comes from a cache of about the last 4096 messages across accounts (key `account:cliMsgId`), saved to `ZALO_RECENT_FILE` (default `/data/recent-messages.json`, mode 0600) so it survives restarts. A reaction note names who reacted (looked up with `getUserInfo` by `uidFrom`, since the event usually has no `dName`), names the sender of the message in groups and shows files briefly (`🖼️ Ảnh`, `📎 file name`, `🎬 Video`); removing a reaction becomes "Bỏ cảm xúc". The event also carries `target_ids` (gMsgID, cMsgID), `reactor_id` (uidFrom, `self` for the account owner) and `reaction` (emoji, empty when removed) so the gateway can attach it to the right Libredesk message; then no note is written.
-   `group_event` also records group setting changes (diffed against the last setting the bot saw: `Khoá tạo bình chọn: bật`), group picture changes, join requests and reminder accept/reject; name/picture changes clear the cache so the next message refreshes name/avatar. Notes, reminders and pinned notes are skipped because Zalo already sends a `webchat` system message (shown as `ℹ️ Thông báo`).
-   `friend_event`: a friend request from someone else becomes a **customer message** `🤝 Lời mời kết bạn «greeting»` (opens a new conversation, deduped per day); friend removed, block/unblock and undone/rejected requests become `friend_event` notes when a conversation exists (on acceptance Zalo itself sends "Bạn vừa kết bạn với ...", shown as an ℹ️ note). Tested live between the two test accounts. zca-js sets a request's `threadId` to `toUid` (possibly ourselves), so the bot takes the other side.
-   The bot enables `selfListen` to see messages the owner sends from a phone or another app (`owner_message` notes); messages the bot itself sent through `/send` are recognised by the returned `msgId` or by matching text within 60 seconds and skipped.
-   Messages missed while the bot was down (restart, network loss): each account stores the last handled message (1-1 and group) in `catchup.json`; after every connect the bot calls `requestOldMessages` and forwards only messages newer than that mark, oldest first (recalled old messages become recall notes), logging `Lấy lại N tin bị lỡ khi bot không chạy.`. The first run (no mark yet) does not replay history. The gateway also dedupes by message ID.
-   zca-js `getGroupChatHistory` currently returns 404, so it is not used.

## 🩺 Healthcheck and resources

-   Each account's state (`starting`, `running`, `retrying`, `dropped`) is written to `ZALO_HEALTH_FILE`; standalone: the container is `healthy` when every account is `running`; gateway mode: zero accounts is still `healthy`, it passes when no account is `starting`/`retrying`/`dropped`. `ZALO_HEALTH_FILE` defaults to `/tmp/zalo-health.json`. The healthcheck uses `grep` so it does not start an extra Node process every minute.
-   A failing account retries with backoff (30 seconds, doubling). Only a really expired session (Zalo rejects the credentials) stops after 2 attempts; network loss is retried forever, at most every 2 minutes, so the account reconnects once the network is back. A socket that dies without a close (network lost mid-connection) is caught by a watchdog: no frame for `ZALO_WATCHDOG_STALE_MS` (default 0 = off; the omnichannel compose sets 360000 = 6 minutes; Zalo answers its app ping about every 3 minutes; 0 = off) and it is cut and reconnected. `ZALO_WATCHDOG_OBSERVE=1` only logs the longest silence every 15 seconds, to measure before changing the threshold; when every account is dropped the process keeps running so broken sign-ins are not repeated.
-   Measured at idle: one account ~27 MiB, each extra account ~8-10 MiB; the login page ~30 MiB. Image 172 MB.

## 🧪 Tests

```bash
docker compose build
docker run --rm -v "$PWD":/app/deploy:ro --entrypoint node zalo-bot --test deploy/tests/deploy.test.mjs
```

## 🔄 Syncing with upstream

```bash
git fetch upstream && git merge upstream/main
cd deploy && docker compose build && docker compose up -d
```

The fork only adds `deploy/`, so merges do not conflict. Upstream APIs the deployment uses (check them when merging upstream): `Zalo` (`login`, `loginQR`), `LoginQRCallbackEventType` (imported from `dist/apis/loginQR.js`), `ThreadType`, `api.listener` (events `connected`, `disconnected`, `closed`, `error`, `message`, `undo`, `reaction`, `typing`, `seen_messages`, `group_event`, `friend_event`, `old_messages`, `cipher_key`; `requestOldMessages`), `api.sendMessage`, `api.sendVoice`, `api.uploadAttachment`, `api.addReaction`, `api.undo`, `api.findUser`, `api.getUserInfo`, `api.getGroupInfo`, `api.getStickersDetail`, `api.fetchAccountInfo`, `api.getOwnId`, `api.getContext`.

Other environment variables: `LOGIN_PORT` (6081), `ZALO_ACCOUNTS_DIR` (`/data/accounts`), `BOT_PREFIX` (`/`), `BOT_CPUS`/`BOT_MEMORY_LIMIT` (standalone compose).
