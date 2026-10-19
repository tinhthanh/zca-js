// Bot Zalo nhiều tài khoản trong một tiến trình Node (phần deploy của fork).
// Mỗi thư mục /data/accounts/<tên>/credentials.json là một tài khoản.
// Tài khoản lỗi được thử lại với backoff và không làm dừng tài khoản khác;
// trạng thái từng tài khoản được ghi vào ZALO_HEALTH_FILE cho healthcheck.
// Có GATEWAY_URL: mọi tin khách được chuyển tới omnichannel gateway và lệnh
// /ping... bị tắt (đặt BOT_COMMANDS=1 để bật lại).
import fs from "node:fs";
import path from "node:path";

import { ThreadType, Zalo } from "../dist/index.js";
import { CREDENTIALS_FILE, discoverAccounts, log, readCredentials } from "./common.mjs";
import {
    forwardGroupEvent,
    forwardMessage,
    forwardReaction,
    forwardUndo,
    gatewayEnabled,
    registerAccount,
    startSendServer,
    unregisterAccount,
} from "./gateway.mjs";

const COMMANDS_ENABLED =
    !gatewayEnabled() || ["1", "true", "yes"].includes((process.env.BOT_COMMANDS || "").toLowerCase());

const PREFIX = process.env.BOT_PREFIX || "/";
const HEALTH_FILE = process.env.ZALO_HEALTH_FILE;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 600_000;
const STABLE_AFTER_MS = 600_000;

const accountStates = {};

function setAccountState(name, value) {
    accountStates[name] = value;
    if (!HEALTH_FILE) return;
    try {
        const tmp = `${HEALTH_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(accountStates));
        fs.renameSync(tmp, HEALTH_FILE);
    } catch (error) {
        log("", "multi", `Không ghi được file health: ${error.message}`);
    }
}

const commands = {
    ping: () => "pong",
    id: (message) => `threadId: ${message.threadId}\ntype: ${message.type === ThreadType.Group ? "group" : "user"}`,
    help: () =>
        `Lệnh: ${Object.keys(commands)
            .map((name) => PREFIX + name)
            .join(", ")}`,
};

async function handleMessage(name, api, message) {
    const content = message.data?.content;
    if (!COMMANDS_ENABLED || message.isSelf || typeof content !== "string" || !content.startsWith(PREFIX)) return;
    const command = content.slice(PREFIX.length).trim().split(/\s+/, 1)[0].toLowerCase();
    const handler = commands[command];
    if (!handler) return;
    try {
        await api.sendMessage({ msg: handler(message), quote: message.data }, message.threadId, message.type);
        log(name, "cmd", `/${command}`);
    } catch (error) {
        log(name, "cmd", `❌ /${command}: ${error?.message || error}`);
    }
}

/** Đăng nhập và chạy listener tới khi kết nối đóng hẳn (reject) hoặc bị dừng. */
async function runAccount(name, dir) {
    const credentials = readCredentials(path.join(dir, CREDENTIALS_FILE));
    if (!credentials) throw new Error("credentials.json thiếu hoặc không hợp lệ");

    log(name, "boot", "Đang đăng nhập bằng credentials...");
    // selfListen: cần thấy tin chủ tài khoản tự gửi (điện thoại/ứng dụng khác) để ghi chú.
    const zalo = new Zalo({ checkUpdate: false, logging: false, selfListen: gatewayEnabled() });
    const api = await zalo.login(credentials);
    const { listener } = api;
    if (gatewayEnabled()) await registerAccount(name, api);

    try {
        await listenUntilClosed(name, api, listener);
    } finally {
        unregisterAccount(name);
    }
}

function listenUntilClosed(name, api, listener) {
    return new Promise((resolve, reject) => {
        listener.on("connected", () => {
            setAccountState(name, "running");
            log(name, "bot", "Listener đã kết nối.");
        });
        listener.on("disconnected", (code) => log(name, "bot", `Mất kết nối (code ${code}), listener tự thử lại.`));
        listener.on("closed", (code, reason) => {
            reject(new Error(`listener đóng (code ${code}${reason ? `: ${reason}` : ""})`));
        });
        listener.on("error", (error) => log(name, "bot", `Lỗi listener: ${error?.message || error}`));
        listener.on("message", (message) => {
            if (gatewayEnabled()) void forwardMessage(name, api, message);
            void handleMessage(name, api, message);
        });
        if (gatewayEnabled()) {
            listener.on("undo", (undo) => void forwardUndo(name, undo));
            listener.on("reaction", (reaction) => void forwardReaction(name, reaction));
            listener.on("group_event", (event) => void forwardGroupEvent(name, event));
        }
        listener.start({ retryOnClose: true });
    });
}

async function superviseAccount(name, dir) {
    let attempt = 0;
    for (;;) {
        const started = Date.now();
        setAccountState(name, "starting");
        try {
            await runAccount(name, dir);
            return true;
        } catch (error) {
            attempt = Date.now() - started >= STABLE_AFTER_MS ? 1 : attempt + 1;
            if (attempt >= MAX_ATTEMPTS) {
                setAccountState(name, "dropped");
                log(name, "multi", `❌ Bỏ tài khoản sau ${attempt} lần lỗi liên tiếp: ${error.message}`);
                return false;
            }
            setAccountState(name, "retrying");
            const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
            log(name, "multi", `❌ ${error.message}; thử lại sau ${delay / 1000}s (${attempt}/${MAX_ATTEMPTS}).`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

const accounts = discoverAccounts();
if (accounts.length === 0) {
    log("", "multi", "Chưa có tài khoản nào trong /data/accounts - chạy dịch vụ login trước.");
    process.exit(1);
}
log("", "multi", `Chạy ${accounts.length} tài khoản: ${accounts.map((a) => a.name).join(", ")}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
if (gatewayEnabled()) startSendServer();

const results = await Promise.all(accounts.map(({ name, dir }) => superviseAccount(name, dir)));
if (!results.some(Boolean)) {
    // Không thoát: với restart unless-stopped, thoát sẽ khiến Docker restart và
    // đăng nhập lại bằng credentials hỏng mãi mãi. Giữ tiến trình để báo unhealthy.
    log("", "multi", "❌ Mọi tài khoản đã bị bỏ; đăng nhập lại bằng dịch vụ login rồi restart bot.");
    setInterval(() => {}, 1 << 30);
}
