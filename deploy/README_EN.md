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

Set `GATEWAY_URL` and `GATEWAY_TOKEN` (at least 32 characters): every customer message is forwarded to the gateway (`POST /v1/inbound`), the bot serves `POST /send` on `BOT_HTTP_PORT` (default 7001) for agent replies, and `/ping`-style commands are disabled (`BOT_COMMANDS=1` to keep them). Groups carry the group name (`getGroupInfo`, cached). Images, files, videos, voice notes and GIFs are downloaded from Zalo's CDN (up to `GATEWAY_MAX_FILE_MB`, default 20 MiB) and sent as base64; stickers and links become a one-line description. Agent files go out through `sendMessage` with `{data, filename, metadata}`; PNG/JPEG/GIF/WebP dimensions are read from the header, so `sharp` is not needed. A `ZaloApiError` with a code (Zalo refused the message) returns 422 so the gateway does not retry; other failures return 502. The full stack lives in the `omnichannel` repository.

### Rich content and events

`content.mjs` (pure functions) turns each message type into something Libredesk can show, based on real payloads captured from Zalo:

-   Stickers: the image is looked up through `getStickersDetail` and sent as an image attachment; doodles are downloaded from `href`.
-   Links (`chat.recommended`/`recommened.link`), contact cards (`recommened.user`), polls (`group.poll`), locations (`chat.location.new`) and to-dos (`chat.todo`): text with an icon.
-   Quotes (`data.quote`): sent as the `quote` field, `Name: text`.
-   Videos (`chat.video.msg`): the mp4 is attached with a `🎬 Video · m:ss` line (duration from `params`); the caption (`title`) is kept. The patched Libredesk UI (`omnichannel/libredesk-ui`) plays videos inline.
-   Avatars: `thread_avatar` is the group's `fullAvt`/`avt` (`getGroupInfo`) or the person's `avatar` (`getUserInfo`), cached for 6 hours; group messages also send the sender's `sender_avatar`.
-   `undo`, `reaction` and `group_event` go to `POST /v1/event` and become private notes; the recalled/reacted message text comes from a cache of the last 4096 messages (key `account:cliMsgId`).
-   The bot enables `selfListen` to see messages the owner sends from a phone or another app (`owner_message` notes); messages the bot itself sent through `/send` are recognised by the returned `msgId` or by matching text within 60 seconds and skipped.
-   zca-js `getGroupChatHistory` currently returns 404, so it is not used.

## 🩺 Healthcheck and resources

-   Each account's state (`starting`, `running`, `retrying`, `dropped`) is written to `ZALO_HEALTH_FILE`; the container is `healthy` when every account is `running`. The healthcheck uses `grep` so it does not start an extra Node process every minute.
-   A failing account retries with backoff (30 seconds, doubling, capped at 10 minutes) and is dropped after 5 consecutive failures; when every account is dropped the process keeps running so broken sign-ins are not repeated.
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

The fork only adds `deploy/`, so merges do not conflict. Upstream APIs the deployment uses: `Zalo` (`login`, `loginQR`), `LoginQRCallbackEventType` (imported from `dist/apis/loginQR.js`), `ThreadType`, `api.listener` (events `connected`, `disconnected`, `closed`, `error`, `message`), `api.sendMessage`, `api.getGroupInfo`, `api.getContext`.
