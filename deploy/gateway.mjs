// Nối bot Zalo với omnichannel gateway (Libredesk).
// - Tin khách gửi tới: POST {GATEWAY_URL}/v1/inbound.
// - Tin nhân viên trả lời: gateway gọi POST /send trên server HTTP nội bộ này.
// Chỉ bật khi có GATEWAY_URL; token dùng chung qua GATEWAY_TOKEN.
import http from "node:http";

import { ThreadType, ZaloApiError } from "../dist/index.js";
import { log } from "./common.mjs";

export const GATEWAY_URL = (process.env.GATEWAY_URL || "").replace(/\/+$/, "");
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const LISTEN_PORT = Number(process.env.BOT_HTTP_PORT || 7001);
const CHANNEL = "zalo";
const RECENT_MAX = 4096;
const MAX_FILE_BYTES = Number(process.env.GATEWAY_MAX_FILE_MB || 20) * 1024 * 1024;
const MAX_SEND_BODY = 96 * 1024 * 1024; // base64 của vài file 20 MiB
// msgType có file tải được qua href; sticker/link chỉ được mô tả bằng chữ.
const DOWNLOADABLE = {
    "chat.photo": "image",
    "share.file": "file",
    "chat.video.msg": "video",
    "chat.voice": "audio",
    "chat.gif": "image",
};
const EXT_BY_TYPE = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/aac": "aac",
    "application/pdf": "pdf",
};

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

function withExtension(name, contentType) {
    const clean = (name || "file").replace(/[\\/]/g, "_").slice(0, 120);
    if (/\.[A-Za-z0-9]{1,8}$/.test(clean)) return clean;
    return `${clean}.${EXT_BY_TYPE[(contentType || "").split(";")[0]] || "bin"}`;
}

/** Tải file của một tin Zalo; null nếu không phải file hoặc tải lỗi/quá lớn. */
export async function downloadAttachment(message, fetchImpl = fetch) {
    const kind = DOWNLOADABLE[message.data?.msgType];
    const content = message.data?.content;
    const href = content && typeof content === "object" ? content.href : "";
    if (!kind || typeof href !== "string" || !/^https:\/\//.test(href)) return null;
    const response = await fetchImpl(href, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_FILE_BYTES) throw new Error("file quá lớn");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_FILE_BYTES) throw new Error("file quá lớn");
    const contentType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
    const urlName = decodeURIComponent(new URL(href).pathname.split("/").pop() || "");
    const name = withExtension(kind === "file" && content.title ? content.title : urlName, contentType);
    return { name, content_type: contentType, data: data.toString("base64") };
}

/** Chuyển một tin khách gửi tới sang gateway; lỗi chỉ được ghi log. */
export async function forwardMessage(account, api, message) {
    if (message.isSelf) return;
    const isGroup = message.type === ThreadType.Group;
    let text = describeContent(message);
    const attachments = [];
    try {
        const file = await downloadAttachment(message);
        if (file) {
            attachments.push(file);
            // Ảnh có thể kèm chú thích trong title; file thì title là tên file.
            const content = message.data.content;
            text = message.data.msgType === "chat.photo" && content.title ? content.title : "";
        }
    } catch (error) {
        log(account, "gateway", `Không tải được file đính kèm, gửi mô tả thay thế: ${error.message}`);
    }
    if (!text.trim() && attachments.length === 0) return;
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
            attachments,
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

/** Kích thước ảnh PNG/JPEG/GIF/WebP từ header; {} nếu không đọc được. */
export function imageSize(buf) {
    try {
        if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") {
            return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
        }
        if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
            const chunk = buf.toString("ascii", 12, 16);
            if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
            if (chunk === "VP8L") {
                const b = buf.readUInt32LE(21);
                return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
            }
            if (chunk === "VP8 ")
                return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        }
        if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
            let offset = 2;
            while (offset + 9 < buf.length) {
                if (buf[offset] !== 0xff) return {};
                const marker = buf[offset + 1];
                const length = buf.readUInt16BE(offset + 2);
                // SOF0..SOF15 trừ DHT (C4), JPG (C8), DAC (CC).
                if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                    return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
                }
                offset += 2 + length;
            }
        }
    } catch {
        // Header hỏng: để zca-js gửi không kèm kích thước.
    }
    return {};
}

/** Chuyển file từ gateway (base64) thành AttachmentSource của zca-js. */
export function toAttachmentSource(file) {
    const data = Buffer.from(String(file?.data || ""), "base64");
    if (data.length === 0) return null;
    const name = withExtension(file.name, file.content_type);
    const metadata = { totalSize: data.length };
    if ((file.content_type || "").startsWith("image/")) Object.assign(metadata, imageSize(data));
    return { data, filename: name, metadata };
}

/** Lỗi Zalo có mã (tham số sai, bị chặn...) là vĩnh viễn: thử lại vô ích. */
function isPermanent(error) {
    return error instanceof ZaloApiError && error.code != null;
}

async function handleSend(req, res) {
    if (req.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) return reply(res, 401, "unauthorized");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_SEND_BODY) return reply(res, 413, "too large");
        chunks.push(chunk);
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
        return reply(res, 400, "invalid json");
    }
    const { account, thread_id: threadId, is_group: isGroup, message_id: messageId } = payload;
    const text = typeof payload.text === "string" ? payload.text : "";
    const attachments = (Array.isArray(payload.attachments) ? payload.attachments : [])
        .map(toAttachmentSource)
        .filter(Boolean);
    const api = apis.get(account);
    if (!api) return reply(res, 404, "unknown account");
    if (!threadId || (!text.trim() && attachments.length === 0)) return reply(res, 400, "invalid payload");
    if (rememberReply(messageId)) return reply(res, 200, "duplicate");
    try {
        const content = attachments.length ? { msg: text, attachments } : text;
        await api.sendMessage(content, String(threadId), isGroup ? ThreadType.Group : ThreadType.User);
        log(
            account,
            "gateway",
            `Đã gửi tin trả lời của nhân viên${attachments.length ? ` (${attachments.length} tệp)` : ""}.`,
        );
        reply(res, 200, "ok");
    } catch (error) {
        recentReplies.delete(messageId);
        const permanent = isPermanent(error);
        log(
            account,
            "gateway",
            `❌ Gửi tin trả lời thất bại${permanent ? " (Zalo từ chối)" : ""}: ${error?.message || error}`,
        );
        reply(res, permanent ? 422 : 502, permanent ? "rejected by zalo" : "send failed");
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
