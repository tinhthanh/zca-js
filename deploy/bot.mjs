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
import { watchSocket } from "./watchdog.mjs";
import { closeCause, ConnectionHistory, HISTORY_FILE } from "./history.mjs";
import { accountRoutes, describeAccountError, retryDelay, sessionExpired } from "./accounts.mjs";
import { ACCOUNTS_DIR, CREDENTIALS_FILE, discoverAccounts, log, readCredentials } from "./common.mjs";
import {
    forwardFriendEvent,
    forwardSeen,
    forwardTyping,
    forwardGroupEvent,
    forwardMessage,
    forwardReaction,
    flushRecent,
    forwardUndo,
    gatewayEnabled,
    registerAccount,
    restoreRecent,
    startSendServer,
    unregisterAccount,
} from "./gateway.mjs";

const COMMANDS_ENABLED =
    !gatewayEnabled() || ["1", "true", "yes"].includes((process.env.BOT_COMMANDS || "").toLowerCase());

const PREFIX = process.env.BOT_PREFIX || "/";
const HEALTH_FILE = process.env.ZALO_HEALTH_FILE;
const STABLE_AFTER_MS = 600_000;
// Watchdog kết nối (watchdog.mjs): 0 = tắt. ZALO_WATCHDOG_OBSERVE=1 chỉ ghi khoảng lặng.
const WATCHDOG_OBSERVE = process.env.ZALO_WATCHDOG_OBSERVE === "1";
const WATCHDOG_STALE_MS = WATCHDOG_OBSERVE ? Infinity : Number(process.env.ZALO_WATCHDOG_STALE_MS || 0);

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
        if (!(error instanceof ZaloApiError)) throw error;
        error.sessionCause =
            `Zalo từ chối đăng nhập${error.code ? ` (mã ${error.code})` : ""}: ` +
            "tài khoản đã đăng xuất bot trên điện thoại (Quản lý thiết bị), đổi mật khẩu hoặc phiên quá hạn.";
        throw sessionExpired(error);
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
        let stopWatchdog = () => {};
        ctl.abort = () => {
            stopWatchdog();
            resolve();
        };
        listener.on("connected", () => {
            delete accountErrors[name];
            historyOf(name).record("connected", "Đã kết nối");
            // Kết nối chết không có gói đóng (mất mạng): tự phát hiện bằng ping/pong.
            stopWatchdog();
            stopWatchdog = watchSocket(listener.ws, {
                staleMs: WATCHDOG_STALE_MS,
                onDead: (ms) => {
                    log(
                        name,
                        "bot",
                        `Không nhận được gì từ Zalo trong ${Math.round(ms / 1000)}s, đóng kết nối để nối lại.`,
                    );
                    historyOf(name).record(
                        "network",
                        `Không nhận được dữ liệu từ Zalo trong ${Math.round(ms / 60000)} phút (mạng treo), bot tự nối lại.`,
                    );
                },
                onGap: WATCHDOG_OBSERVE
                    ? (ms) => log(name, "watchdog", `khoảng lặng dài nhất ${Math.round(ms / 1000)}s`)
                    : undefined,
            });
            setAccountState(name, "running");
            log(name, "bot", "Listener đã kết nối.");
        });
        listener.on("disconnected", (code) => {
            stopWatchdog();
            const cause = closeCause(code);
            historyOf(name).record(cause.kind, cause.message);
            log(name, "bot", `Mất kết nối (code ${code}), listener tự thử lại.`);
        });
        listener.on("closed", (code, reason) => {
            stopWatchdog();
            // "disconnected" đã ghi nguyên nhân vào lịch sử: không ghi lặp.
            reject(
                Object.assign(new Error(`listener đóng (code ${code}${reason ? `: ${reason}` : ""})`), {
                    recorded: true,
                }),
            );
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
            listener.on("reaction", (reaction) => void forwardReaction(name, api, reaction));
            listener.on("group_event", (event) => void forwardGroupEvent(name, event));
            listener.on("friend_event", (event) => void forwardFriendEvent(name, api, event));
            listener.on("typing", (typing) => void forwardTyping(name, typing));
            listener.on("seen_messages", (seens) => void forwardSeen(name, seens));
        }
        listener.start({ retryOnClose: true });
    });
}

// tên tài khoản -> lịch sử kết nối (đọc lại từ file khi cần).
const histories = new Map();
function historyOf(name) {
    if (!histories.has(name)) {
        histories.set(name, new ConnectionHistory(path.join(ACCOUNTS_DIR, name, HISTORY_FILE)));
    }
    return histories.get(name);
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
            if (error?.sessionExpired) historyOf(name).record("session_expired", accountErrors[name].message);
            else if (!error?.recorded)
                historyOf(name).record("network", `Không kết nối được Zalo: ${error.message}`.slice(0, 200));
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
    histories.delete(name);
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
            history: historyOf(name).list(),
        }));
    },
    stop: stopAccount,
    restart: async (name) => {
        await stopAccount(name);
        historyOf(name).record("manual", "Khởi động lại tài khoản (đăng nhập lại hoặc bấm Kết nối lại)");
        void startAccount(name);
    },
};

const accounts = discoverAccounts();
log("", "multi", `Chạy ${accounts.length} tài khoản: ${accounts.map((a) => a.name).join(", ") || "(chưa có)"}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        flushRecent();
        process.exit(0);
    });
}
if (gatewayEnabled()) {
    restoreRecent();
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
