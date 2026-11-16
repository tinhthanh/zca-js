# Build context: thư mục gốc repo zca-js (xem deploy/docker-compose.yml).
# Ignore file: Dockerfile.dockerignore cạnh file này (BuildKit).

# --- Stage 1: build dist/ từ source TypeScript của fork ---
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN node scripts/buildAPI.js && npx tsc

# --- Stage 2: runtime tối giản, chỉ dependency production ---
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts \
    && mkdir -p /data \
    && chown node:node /data
COPY --from=build /src/dist ./dist
COPY deploy/common.mjs deploy/login.mjs deploy/bot.mjs deploy/gateway.mjs deploy/content.mjs deploy/catchup.mjs deploy/accounts.mjs deploy/watchdog.mjs deploy/history.mjs deploy/call.mjs deploy/trace.mjs ./deploy/

USER node
ENV NODE_ENV=production \
    ZALO_ACCOUNTS_DIR=/data/accounts \
    ZALO_HEALTH_FILE=/tmp/zalo-health.json

# Container của từng tài khoản trên máy omi không có healthcheck trong compose: healthy khi file
# health đã có và không tài khoản nào starting/retrying/dropped (chưa có tài khoản vẫn healthy).
# Dùng grep thay vì node để không khởi động thêm tiến trình Node mỗi phút. Compose có thể ghi đè;
# container chạy login.mjs thì tắt healthcheck này (healthcheck: disable).
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=2 \
    CMD test -f "$ZALO_HEALTH_FILE" && ! grep -qE '"(starting|retrying|dropped)"' "$ZALO_HEALTH_FILE"

CMD ["node", "deploy/bot.mjs"]
