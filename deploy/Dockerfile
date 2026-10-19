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
COPY deploy/common.mjs deploy/login.mjs deploy/bot.mjs deploy/gateway.mjs ./deploy/

USER node
ENV NODE_ENV=production \
    ZALO_ACCOUNTS_DIR=/data/accounts \
    ZALO_HEALTH_FILE=/tmp/zalo-health.json

CMD ["node", "deploy/bot.mjs"]
