// Bot Zalo nhiều tài khoản trong một tiến trình Node (phần deploy của fork).
// Mỗi thư mục /data/accounts/<tên>/credentials.json là một tài khoản.
// Tài khoản lỗi được thử lại với backoff và không làm dừng tài khoản khác;
// trạng thái từng tài khoản được ghi vào ZALO_HEALTH_FILE cho healthcheck.
// Có GATEWAY_URL: mọi tin khách được chuyển tới omnichannel gateway và lệnh
// /ping... bị tắt (đặt BOT_COMMANDS=1 để bật lại).
import fs from "node:fs";
import path from "node:path";

import { ThreadType, Zalo, ZaloApiError } from "../dist/index.js";
import { CatchUp, isRecall, recallOf } from "./catchup.mjs";
import { accountRoutes, describeAccountError, retryDelay, sessionExpired } from "./accounts.mjs";
import { ACCOUNTS_DIR, CREDENTIALS_FILE, discoverAccounts, log, readCredentials } from "./common.mjs";
import {
    forwardFriendEvent,
    forwardSeen,
    forwardTyping,
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
const STABLE_AFTER_MS = 600_000;

const accountStates = {};
const accountProfiles = {}; // name -> {uid, displayName, avatar}: hiển thị trên giao diện
const accountErrors = {}; // name -> {kind, message}: lỗi gần nhất (cần đăng nhập lại hay lỗi kết nối)
const running = new Map(); // name -> {stopped, listener, abort}

function setAccountState(name, value) {
    if (value === null) delete accountStates[name];
    else accountStates[name] = value;
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
async function runAccount(name, dir, ctl) {
    const credentials = readCredentials(path.join(dir, CREDENTIALS_FILE));
    if (!credentials) throw sessionExpired(new Error("credentials.json thiếu hoặc không hợp lệ"));

    log(name, "boot", "Đang đăng nhập bằng credentials...");
    // selfListen: cần thấy tin chủ tài khoản tự gửi (điện thoại/ứng dụng khác) để ghi chú.
    const zalo = new Zalo({ checkUpdate: false, logging: false, selfListen: gatewayEnabled() });
    let api;
    try {
        api = await zalo.login(credentials);
    } catch (error) {
        // Zalo từ chối hẳn (có mã lỗi): cookie hết hạn/bị đăng xuất. Lỗi mạng thì không.
        throw error instanceof ZaloApiError ? sessionExpired(error) : error;
    }
    const { listener } = api;
    ctl.listener = listener;
    if (ctl.stopped) return;
    if (gatewayEnabled()) await registerAccount(name, api);
    try {
        const profile = (await api.fetchAccountInfo())?.profile || {};
        accountProfiles[name] = {
            uid: api.getOwnId(),
            displayName: profile.displayName || "",
            avatar: profile.avatar || "",
        };
    } catch {
        accountProfiles[name] = { uid: api.getOwnId(), displayName: "", avatar: "" };
    }

    const catchUp = new CatchUp(path.join(dir, "catchup.json"));
    try {
        await listenUntilClosed(name, api, listener, catchUp, ctl);
    } finally {
        catchUp.flush();
        unregisterAccount(name);
    }
}

function listenUntilClosed(name, api, listener, catchUp, ctl) {
    return new Promise((resolve, reject) => {
        // stopAccount: listener.stop() không chắc phát "closed", nên kết thúc trực tiếp.
        ctl.abort = resolve;
        listener.on("connected", () => {
            delete accountErrors[name];
            setAccountState(name, "running");
            log(name, "bot", "Listener đã kết nối.");
        });
        listener.on("disconnected", (code) => log(name, "bot", `Mất kết nối (code ${code}), listener tự thử lại.`));
        listener.on("closed", (code, reason) => {
            reject(new Error(`listener đóng (code ${code}${reason ? `: ${reason}` : ""})`));
        });
        listener.on("error", (error) => log(name, "bot", `Lỗi listener: ${error?.message || error}`));
        listener.on("message", (message) => {
            if (!catchUp.acceptLive(message)) return;
            if (gatewayEnabled()) void forwardMessage(name, api, message);
            void handleMessage(name, api, message);
        });
        if (gatewayEnabled()) {
            // Sau mỗi lần (kết nối lại) có khoá giải mã: xin tin bị lỡ từ mốc đã lưu.
            listener.on("cipher_key", () => {
                for (const type of [ThreadType.User, ThreadType.Group]) {
                    const lastId = catchUp.lastId(type);
                    if (lastId) listener.requestOldMessages(type, lastId);
                }
            });
            listener.on("old_messages", (messages) => {
                const missed = messages
                    .filter((m) => catchUp.acceptOld(m))
                    .sort((a, b) => Number(a.data?.ts) - Number(b.data?.ts));
                if (missed.length === 0) return;
                log(name, "bot", `Lấy lại ${missed.length} tin bị lỡ khi bot không chạy.`);
                void (async () => {
                    for (const message of missed) {
                        // Tin cũ bị thu hồi: listener sống phát "undo", tin cũ thì không.
                        if (isRecall(message)) await forwardUndo(name, recallOf(message));
                        else await forwardMessage(name, api, message);
                    }
                })();
            });
            listener.on("undo", (undo) => void forwardUndo(name, undo));
            listener.on("reaction", (reaction) => void forwardReaction(name, reaction));
            listener.on("group_event", (event) => void forwardGroupEvent(name, event));
            listener.on("friend_event", (event) => void forwardFriendEvent(name, api, event));
            listener.on("typing", (typing) => void forwardTyping(name, typing));
            listener.on("seen_messages", (seens) => void forwardSeen(name, seens));
        }
        listener.start({ retryOnClose: true });
    });
}

async function superviseAccount(name, dir, ctl) {
    let attempt = 0;
    while (!ctl.stopped) {
        const started = Date.now();
        setAccountState(name, "starting");
        try {
            await runAccount(name, dir, ctl);
            return true;
        } catch (error) {
            if (ctl.stopped) return true;
            accountErrors[name] = describeAccountError(error);
            attempt = Date.now() - started >= STABLE_AFTER_MS ? 1 : attempt + 1;
            // Hết phiên: thử lại một lần rồi dừng, chờ quét QR lại. Mất mạng: thử mãi.
            const delay = retryDelay(error, attempt);
            if (delay === null) {
                setAccountState(name, "dropped");
                log(name, "multi", `❌ Bỏ tài khoản sau ${attempt} lần lỗi liên tiếp: ${error.message}`);
                return false;
            }
            setAccountState(name, "retrying");
            log(name, "multi", `❌ ${error.message}; thử lại sau ${delay / 1000}s (lần ${attempt}).`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    return true;
}

/** Chạy một tài khoản (không làm gì nếu đang chạy); trả về promise kết quả giám sát. */
function startAccount(name) {
    if (running.has(name)) return Promise.resolve(true);
    const ctl = { stopped: false, listener: null, abort: null };
    running.set(name, ctl);
    return superviseAccount(name, path.join(ACCOUNTS_DIR, name), ctl).finally(() => {
        if (running.get(name) === ctl) running.delete(name);
    });
}

async function stopAccount(name) {
    const ctl = running.get(name);
    if (!ctl) return;
    ctl.stopped = true;
    running.delete(name);
    try {
        ctl.listener?.stop();
    } catch {
        // Listener chưa kết nối.
    }
    ctl.abort?.();
    unregisterAccount(name);
    setAccountState(name, null);
    delete accountProfiles[name];
    delete accountErrors[name];
    log(name, "multi", "Đã dừng tài khoản.");
}

const manager = {
    list: () => {
        const names = new Set([...discoverAccounts().map((a) => a.name), ...Object.keys(accountStates)]);
        return [...names].sort().map((name) => ({
            name,
            state: accountStates[name] || "stopped",
            profile: accountProfiles[name] || null,
            error: accountErrors[name] || null,
        }));
    },
    stop: stopAccount,
    restart: async (name) => {
        await stopAccount(name);
        void startAccount(name);
    },
};

const accounts = discoverAccounts();
log("", "multi", `Chạy ${accounts.length} tài khoản: ${accounts.map((a) => a.name).join(", ") || "(chưa có)"}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
if (gatewayEnabled()) {
    startSendServer(accountRoutes(manager));
} else if (accounts.length === 0) {
    log("", "multi", "Chưa có tài khoản nào trong /data/accounts - chạy dịch vụ login trước.");
    process.exit(1);
}
setAccountState("", null); // ghi file health ngay cả khi chưa có tài khoản

const results = await Promise.all(accounts.map(({ name }) => startAccount(name)));
if (accounts.length && !results.some(Boolean)) {
    // Không thoát: với restart unless-stopped, thoát sẽ khiến Docker restart và
    // đăng nhập lại bằng credentials hỏng mãi mãi. Giữ tiến trình để báo unhealthy;
    // đăng nhập lại từ giao diện (Tài khoản kênh) hoặc dịch vụ login.
    log("", "multi", "❌ Mọi tài khoản đã bị bỏ; đăng nhập lại rồi bấm kết nối lại.");
}
setInterval(() => {}, 1 << 30);
