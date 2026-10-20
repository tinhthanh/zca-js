// Quản lý tài khoản Zalo qua HTTP (gateway gọi, giao diện Libredesk hiển thị):
// danh sách + trạng thái, đăng nhập bằng QR ngay trong bot, kết nối lại, gỡ.
// Tài khoản mới chạy luôn, không cần restart. Không bao giờ trả cookie ra ngoài.
import fs from "node:fs";
import path from "node:path";

import { LoginQRCallbackEventType } from "../dist/apis/loginQR.js";
import { Zalo } from "../dist/index.js";
import { ACCOUNTS_DIR, ACCOUNT_NAME_PATTERN, CREDENTIALS_FILE, log, writePrivateJson } from "./common.mjs";

const MAX_QR = Number(process.env.MAX_QR || 5); // mỗi mã QR sống ~100 giây
const SESSION_KEEP_MS = 10 * 60 * 1000; // giữ kết quả để giao diện kịp đọc

export const SESSION_EXPIRED_MESSAGE = "Phiên Zalo đã hết hạn hoặc bị đăng xuất: cần đăng nhập lại.";

/** Đánh dấu lỗi là "hết phiên" (cần quét QR lại), không phải lỗi kết nối. */
export function sessionExpired(error) {
    error.sessionExpired = true;
    return error;
}

/** Lỗi gần nhất cho trang Channel accounts: {kind, message}. */
export function describeAccountError(error) {
    if (error?.sessionExpired) return { kind: "session_expired", message: SESSION_EXPIRED_MESSAGE };
    return { kind: "connection", message: `Lỗi kết nối: ${error?.message || error}`.slice(0, 200) };
}

/** Phiên đăng nhập QR của một tài khoản (chỉ trong RAM). */
export class LoginSession {
    constructor(account) {
        this.account = account;
        this.status = "pending"; // pending | qr | scanned | confirming | success | error
        this.message = "Đang tạo mã QR...";
        this.image = null; // PNG base64
        this.version = 0;
        this.qrCount = 0;
        this.abort = null;
        this.updatedAt = Date.now();
    }

    get done() {
        return this.status === "success" || this.status === "error";
    }

    set(status, message) {
        this.status = status;
        this.message = message;
        this.updatedAt = Date.now();
    }

    /** Xử lý callback của zca-js loginQR. */
    onEvent(event) {
        switch (event.type) {
            case LoginQRCallbackEventType.QRCodeGenerated:
                this.qrCount++;
                this.image = event.data.image;
                this.version++;
                this.abort = () => event.actions.abort();
                this.set("qr", `Mở app Zalo, quét mã QR (lần ${this.qrCount}/${MAX_QR}).`);
                break;
            case LoginQRCallbackEventType.QRCodeExpired:
            case LoginQRCallbackEventType.QRCodeDeclined:
                if (this.qrCount >= MAX_QR) {
                    this.set("error", "Hết số lần tạo mã QR. Bấm đăng nhập lại để thử tiếp.");
                    event.actions.abort();
                } else {
                    event.actions.retry();
                }
                break;
            case LoginQRCallbackEventType.QRCodeScanned:
                this.set("scanned", "Đã quét. Xác nhận đăng nhập trên điện thoại.");
                break;
            case LoginQRCallbackEventType.GotLoginInfo:
                this.set("confirming", "Đang hoàn tất đăng nhập...");
                break;
        }
    }

    toJSON() {
        return {
            status: this.status,
            message: this.message,
            version: this.version,
            qr: this.image && !this.done ? `data:image/png;base64,${this.image}` : null,
        };
    }
}

/**
 * Tạo bộ xử lý /accounts. `manager` do bot.mjs cung cấp:
 * list() -> [{name, state, profile}], start(name), stop(name), restart(name).
 */
export function accountRoutes(
    manager,
    { createZalo = () => new Zalo({ checkUpdate: false, logging: false }), accountsDir = ACCOUNTS_DIR } = {},
) {
    const sessions = new Map();

    function sessionFor(name) {
        const s = sessions.get(name);
        if (s && s.done && Date.now() - s.updatedAt > SESSION_KEEP_MS) {
            sessions.delete(name);
            return null;
        }
        return s || null;
    }

    function beginLogin(name) {
        const current = sessionFor(name);
        if (current && !current.done) return current;
        const session = new LoginSession(name);
        sessions.set(name, session);
        void (async () => {
            try {
                const api = await createZalo().loginQR({}, (event) => session.onEvent(event));
                if (!api) throw new Error("đăng nhập bị huỷ");
                const context = api.getContext();
                writePrivateJson(path.join(accountsDir, name, CREDENTIALS_FILE), {
                    cookie: context.cookie.toJSON()?.cookies || [],
                    imei: context.imei,
                    userAgent: context.userAgent,
                });
                session.set("success", "Đăng nhập thành công, tài khoản đang kết nối.");
                log(name, "accounts", "Đăng nhập QR thành công, khởi động tài khoản.");
                await manager.restart(name);
            } catch (error) {
                if (!session.done) session.set("error", `Đăng nhập thất bại: ${error?.message || error}`);
                log(name, "accounts", `Đăng nhập QR thất bại: ${error?.message || error}`);
            }
        })();
        return session;
    }

    function list() {
        return manager.list().map((a) => ({ ...a, login: sessionFor(a.name)?.toJSON() || null }));
    }

    async function remove(name) {
        const session = sessions.get(name);
        if (session && !session.done) {
            try {
                session.abort?.();
            } catch {
                // Phiên QR đã kết thúc phía zca-js.
            }
        }
        sessions.delete(name);
        await manager.stop(name);
        fs.rmSync(path.join(accountsDir, name), { recursive: true, force: true });
        log(name, "accounts", "Đã gỡ tài khoản và xoá dữ liệu đăng nhập.");
    }

    /** true nếu đã trả lời request. */
    return async function handle(req, res, reply) {
        const url = new URL(req.url, "http://bot");
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts[0] !== "accounts") return false;
        const json = (status, body) => {
            res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify(body));
        };
        if (parts.length === 1 && req.method === "GET") {
            json(200, list());
            return true;
        }
        const name = parts[1];
        if (!ACCOUNT_NAME_PATTERN.test(name || "")) {
            reply(res, 400, "invalid account name");
            return true;
        }
        const action = parts[2] || "";
        if (action === "login" && req.method === "POST") {
            json(202, beginLogin(name).toJSON());
        } else if (action === "login" && req.method === "GET") {
            const session = sessionFor(name);
            if (session) json(200, session.toJSON());
            else reply(res, 404, "no login session");
        } else if (action === "restart" && req.method === "POST") {
            if (!manager.list().some((a) => a.name === name)) reply(res, 404, "unknown account");
            else {
                await manager.restart(name);
                json(202, { ok: true });
            }
        } else if (action === "" && req.method === "DELETE") {
            await remove(name);
            res.writeHead(204);
            res.end();
        } else {
            reply(res, 404, "not found");
        }
        return true;
    };
}
