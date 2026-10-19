// Nối bot Zalo với omnichannel gateway (Libredesk).
// - Tin khách gửi tới: POST {GATEWAY_URL}/v1/inbound.
// - Tin nhân viên trả lời: gateway gọi POST /send trên server HTTP nội bộ này.
// Chỉ bật khi có GATEWAY_URL; token dùng chung qua GATEWAY_TOKEN.
import http from "node:http";

import { ThreadType } from "../dist/index.js";
import { log } from "./common.mjs";

export const GATEWAY_URL = (process.env.GATEWAY_URL || "").replace(/\/+$/, "");
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const LISTEN_PORT = Number(process.env.BOT_HTTP_PORT || 7001);
const CHANNEL = "zalo";
const RECENT_MAX = 4096;

const apis = new Map(); // account -> zca-js API
const groupNames = new Map(); // `${account}:${groupId}` -> tên nhóm
const recentReplies = new Set();

export const gatewayEnabled = () => Boolean(GATEWAY_URL);

async function callGateway(path, body) {
    const response = await fetch(GATEWAY_URL + path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${GATEWAY_TOKEN}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`gateway HTTP ${response.status}`);
}

/** Gắn API của một tài khoản để /send dùng, rồi tạo inbox tương ứng trên Libredesk. */
export async function registerAccount(account, api) {
    apis.set(account, api);
    try {
        await callGateway("/v1/register", { channel: CHANNEL, account });
    } catch (error) {
        // Không chặn listener: gateway sẽ tự tạo inbox ở tin nhắn đầu tiên.
        log(account, "gateway", `Đăng ký inbox thất bại: ${error.message}`);
    }
}

export function unregisterAccount(account) {
    apis.delete(account);
}

/** Chuyển nội dung không phải chữ (ảnh, sticker, file...) thành mô tả ngắn. */
export function describeContent(message) {
    const content = message.data?.content;
    if (typeof content === "string") return content;
    const type = message.data?.msgType || "attachment";
    const parts = [content?.title, content?.description, content?.href].filter(
        (value) => typeof value === "string" && value.trim(),
    );
    return `[${type}]${parts.length ? " " + parts.join(" ") : ""}`;
}

async function threadName(account, api, message, isGroup) {
    if (!isGroup) return message.data?.dName || "";
    const key = `${account}:${message.threadId}`;
    if (!groupNames.has(key)) {
        try {
            const info = await api.getGroupInfo(message.threadId);
            groupNames.set(key, info?.gridInfoMap?.[message.threadId]?.name || "");
        } catch {
            groupNames.set(key, "");
        }
    }
    return groupNames.get(key);
}

/** Chuyển một tin khách gửi tới sang gateway; lỗi chỉ được ghi log. */
export async function forwardMessage(account, api, message) {
    if (message.isSelf) return;
    const isGroup = message.type === ThreadType.Group;
    const text = describeContent(message);
    if (!text.trim()) return;
    try {
        await callGateway("/v1/inbound", {
            channel: CHANNEL,
            account,
            thread_id: String(message.threadId),
            is_group: isGroup,
            thread_name: await threadName(account, api, message, isGroup),
            sender_name: message.data?.dName || "",
            text,
            message_id: String(message.data?.msgId || ""),
        });
    } catch (error) {
        log(account, "gateway", `❌ Không chuyển được tin tới gateway: ${error.message}`);
    }
}

function rememberReply(id) {
    if (!id) return false;
    if (recentReplies.has(id)) return true;
    recentReplies.add(id);
    if (recentReplies.size > RECENT_MAX) recentReplies.delete(recentReplies.values().next().value);
    return false;
}

function reply(res, status, body = "") {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
}

async function handleSend(req, res) {
    if (req.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) return reply(res, 401, "unauthorized");
    let body = "";
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 1 << 20) return reply(res, 413, "too large");
    }
    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        return reply(res, 400, "invalid json");
    }
    const { account, thread_id: threadId, is_group: isGroup, text, message_id: messageId } = payload;
    const api = apis.get(account);
    if (!api) return reply(res, 404, "unknown account");
    if (!threadId || typeof text !== "string" || !text.trim()) return reply(res, 400, "invalid payload");
    if (rememberReply(messageId)) return reply(res, 200, "duplicate");
    try {
        await api.sendMessage(text, String(threadId), isGroup ? ThreadType.Group : ThreadType.User);
        log(account, "gateway", "Đã gửi tin trả lời của nhân viên.");
        reply(res, 200, "ok");
    } catch (error) {
        recentReplies.delete(messageId);
        log(account, "gateway", `❌ Gửi tin trả lời thất bại: ${error?.message || error}`);
        reply(res, 502, "send failed");
    }
}

export function startSendServer() {
    if (GATEWAY_TOKEN.length < 32) {
        log("", "gateway", "GATEWAY_TOKEN phải dài ít nhất 32 ký tự.");
        process.exit(1);
    }
    const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/send") {
            handleSend(req, res).catch(() => reply(res, 500, "error"));
        } else {
            reply(res, 404, "not found");
        }
    });
    server.listen(LISTEN_PORT, "0.0.0.0", () => log("", "gateway", `Nhận tin trả lời tại :${LISTEN_PORT}/send`));
    return server;
}
