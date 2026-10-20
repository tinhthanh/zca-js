// Nối bot Zalo với omnichannel gateway (Libredesk).
// - Tin khách gửi tới: POST {GATEWAY_URL}/v1/inbound (kèm file, trích dẫn).
// - Sự kiện (thu hồi, reaction, sự kiện nhóm, chủ tài khoản tự trả lời):
//   POST {GATEWAY_URL}/v1/event, thành ghi chú nội bộ.
// - Tin nhân viên trả lời: gateway gọi POST /send trên server HTTP nội bộ này.
// Chỉ bật khi có GATEWAY_URL; token dùng chung qua GATEWAY_TOKEN.
import http from "node:http";

import { ThreadType, ZaloApiError } from "../dist/index.js";
import { log } from "./common.mjs";
import {
    describeContent,
    friendEventInfo,
    groupEventText,
    quoteText,
    reactionEmoji,
    RecentMessages,
    summarize,
    systemNoticeText,
} from "./content.mjs";

export { describeContent };

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
    "chat.doodle": "image",
};
const CAPTIONED = new Set(["chat.photo", "chat.video.msg"]);
const ECHO_WINDOW_MS = 60_000;
const OWNER = "Chủ tài khoản";
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
const profiles = new Map(); // `${account}:${g|u}:${id}` -> {name, avatar, at}
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000; // sự kiện đổi tên/ảnh nhóm xoá cache sớm hơn
const groupSettings = new Map(); // `${account}:${groupId}` -> groupSetting lần cuối thấy
const recentReplies = new Set();
const recent = new RecentMessages(); // `${account}:${cliMsgId|msgId}` -> {summary, sender}
const botSent = new RecentMessages(2048); // `${account}:${msgId}` của tin bot gửi qua /send
// `${account}:${msgId}` -> dữ liệu tin gốc: zca-js cần nguyên tin để gửi trích dẫn
// khi nhân viên trả lời trích dẫn (gateway gửi reply_to = msgId).
const quotable = new RecentMessages(2048);
// `${account}:${msgId}` -> {msgId, cliMsgId} của tin bot gửi (từ tin tự nghe thấy):
// thu hồi (undo) cần cả cliMsgId mà sendMessage không trả về.
const sentEchoes = new RecentMessages(2048);
const botRecalled = new RecentMessages(512); // `${account}:${msgId|cliMsgId}` bot đã thu hồi
let pendingEchoes = []; // tin bot đang gửi, chờ listener báo lại (isSelf)

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

async function threadFields(account, api, message, isGroup) {
    const profile = await threadProfile(account, api, message, isGroup);
    // Nhóm: thêm ảnh của người gửi để giao diện hiện avatar từng thành viên.
    const sender = isGroup ? await threadProfile(account, api, message, false) : profile;
    return {
        thread_name: isGroup ? profile.name : message.data?.dName || profile.name,
        thread_avatar: profile.avatar,
        sender_avatar: sender.avatar,
    };
}

/** Tên và avatar của hội thoại: nhóm thì của nhóm, 1-1 thì của người gửi. Lỗi tra cứu không chặn tin. */
async function threadProfile(account, api, message, isGroup) {
    const id = isGroup ? message.threadId : message.data?.uidFrom;
    const fallback = { name: isGroup ? "" : message.data?.dName || "", avatar: "" };
    if (!id) return fallback;
    const key = `${account}:${isGroup ? "g" : "u"}:${id}`;
    const cached = profiles.get(key);
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return { ...cached, name: cached.name || fallback.name };
    let found = { name: "", avatar: "" };
    try {
        if (isGroup) {
            const info = (await api.getGroupInfo(id))?.gridInfoMap?.[id];
            found = { name: info?.name || "", avatar: info?.fullAvt || info?.avt || "" };
            if (info?.setting) groupSettings.set(`${account}:${id}`, info.setting);
        } else {
            const changed = (await api.getUserInfo(id))?.changed_profiles || {};
            const user = changed[id] || changed[`${id}_0`];
            found = { name: user?.displayName || user?.zaloName || "", avatar: user?.avatar || "" };
        }
    } catch {
        // Giữ chỗ để không tra lại liên tục khi API lỗi.
    }
    profiles.set(key, { ...found, at: Date.now() });
    return { name: found.name || fallback.name, avatar: found.avatar };
}

function withExtension(name, contentType) {
    const clean = (name || "file").replace(/[\\/]/g, "_").slice(0, 120);
    if (/\.[A-Za-z0-9]{1,8}$/.test(clean)) return clean;
    return `${clean}.${EXT_BY_TYPE[(contentType || "").split(";")[0]] || "bin"}`;
}

async function fetchFile(href, fetchImpl) {
    const response = await fetchImpl(href, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_FILE_BYTES) throw new Error("file quá lớn");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_FILE_BYTES) throw new Error("file quá lớn");
    return { data, contentType: (response.headers.get("content-type") || "application/octet-stream").split(";")[0] };
}

/** Ảnh của sticker (Zalo chỉ gửi id/catId): tra URL qua getStickersDetail. */
export async function downloadSticker(api, message, fetchImpl = fetch) {
    const content = message.data?.content;
    if (message.data?.msgType !== "chat.sticker" || !content?.id) return null;
    const [detail] = await api.getStickersDetail([Number(content.id)]);
    const href = detail?.stickerWebpUrl || detail?.stickerUrl || detail?.stickerSpriteUrl;
    if (typeof href !== "string" || !/^https:\/\//.test(href)) return null;
    const { data, contentType } = await fetchFile(href, fetchImpl);
    return {
        name: withExtension(`sticker-${content.id}`, contentType),
        content_type: contentType,
        data: data.toString("base64"),
    };
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

/** Chữ + file (đã tải) của một tin; file lỗi thì giữ dòng mô tả. */
/** Chú thích của ảnh/video nằm trong title; với file/sticker title là tên file hoặc rỗng. */
export function captionOf(message) {
    const title = message.data?.content?.title;
    return CAPTIONED.has(message.data?.msgType) && typeof title === "string" ? title.trim() : "";
}

/** Chú thích video kèm thời lượng; giao diện Libredesk (đã vá) phát video ngay trong khung chat. */
export function videoText(message) {
    let params = {};
    try {
        const raw = message.data?.content?.params;
        params = typeof raw === "string" ? JSON.parse(raw) : {};
    } catch {
        params = {};
    }
    const seconds = Math.round((Number(params.duration) || 0) / 1000);
    const length = seconds > 0 ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
    return [captionOf(message), `🎬 Video${length}`].filter(Boolean).join("\n");
}

async function collect(account, api, message) {
    let text = describeContent(message);
    const attachments = [];
    try {
        const file = (await downloadAttachment(message)) || (await downloadSticker(api, message));
        if (file) {
            text = captionOf(message);
            if (message.data?.msgType === "chat.video.msg") text = videoText(message);
            attachments.push(file);
        }
    } catch (error) {
        log(account, "gateway", `Không tải được file đính kèm, gửi mô tả thay thế: ${error.message}`);
    }
    return { text, attachments };
}

function rememberMessage(account, message) {
    const d = message.data || {};
    recent.remember([`${account}:${d.cliMsgId}`, `${account}:${d.msgId}`], {
        summary: summarize(message),
        sender: message.isSelf ? OWNER : d.dName || "",
    });
    if (d.msgId) quotable.remember([`${account}:${d.msgId}`], d);
}

/** Nội dung gửi: kèm trích dẫn tin gốc nếu còn nhớ (chỉ tin chữ; tin có tệp gửi như cũ). */
export function sendContent(text, attachments, quote) {
    if (attachments.length) return { msg: text, attachments };
    return quote ? { msg: text, quote } : text;
}

/** Tin isSelf do chính bot gửi (qua /send) thì không ghi chú lại. */
export function isBotEcho(account, message, now = Date.now()) {
    const d = message.data || {};
    if (botSent.get(`${account}:${d.msgId}`)) return true;
    pendingEchoes = pendingEchoes.filter((p) => p.until > now);
    const index = pendingEchoes.findIndex(
        (p) =>
            p.account === account &&
            p.threadId === String(message.threadId) &&
            (typeof d.content === "string" ? d.content === p.text : p.files > 0),
    );
    if (index < 0) return false;
    const [hit] = pendingEchoes.splice(index, 1);
    if (typeof d.content !== "string" && hit.files > 1) pendingEchoes.push({ ...hit, files: hit.files - 1 });
    return true;
}

async function postEvent(account, threadId, isGroup, kind, senderName, text, messageId, attachments = []) {
    try {
        await callGateway("/v1/event", {
            channel: CHANNEL,
            account,
            thread_id: String(threadId),
            is_group: isGroup,
            sender_name: senderName,
            kind,
            text,
            message_id: messageId ? `${kind}-${messageId}` : "",
            attachments,
        });
    } catch (error) {
        log(account, "gateway", `❌ Không ghi được sự kiện ${kind}: ${error.message}`);
    }
}

/** Chuyển một tin sang gateway: tin khách thành inbound, tin chủ tài khoản thành ghi chú. */
export async function forwardMessage(account, api, message) {
    rememberMessage(account, message);
    const isGroup = message.type === ThreadType.Group;
    const notice = systemNoticeText(message);
    if (notice) {
        // Thông báo hệ thống (kết bạn...) không phải tin khách: ghi chú.
        await postEvent(account, message.threadId, isGroup, "system", "", notice, message.data?.msgId);
        return;
    }
    if (message.isSelf) {
        if (isBotEcho(account, message)) {
            const d = message.data || {};
            if (d.msgId) sentEchoes.remember([`${account}:${d.msgId}`], { msgId: d.msgId, cliMsgId: d.cliMsgId });
            return;
        }
        const { text, attachments } = await collect(account, api, message);
        if (text.trim() || attachments.length) {
            await postEvent(
                account,
                message.threadId,
                isGroup,
                "owner_message",
                OWNER,
                text,
                message.data?.msgId,
                attachments,
            );
        }
        return;
    }
    const { text, attachments } = await collect(account, api, message);
    if (!text.trim() && attachments.length === 0) return;
    try {
        await callGateway("/v1/inbound", {
            channel: CHANNEL,
            account,
            thread_id: String(message.threadId),
            is_group: isGroup,
            ...(await threadFields(account, api, message, isGroup)),
            sender_name: message.data?.dName || "",
            text,
            message_id: String(message.data?.msgId || ""),
            attachments,
            quote: quoteText(message),
        });
    } catch (error) {
        log(account, "gateway", `❌ Không chuyển được tin tới gateway: ${error.message}`);
    }
}

/** Thu hồi tin (của khách hoặc chủ tài khoản) thành ghi chú kèm nội dung đã nhớ. */
export async function forwardUndo(account, undo) {
    const d = undo.data || {};
    // Bot vừa thu hồi theo yêu cầu nhân viên: gateway đã ghi chú, không ghi lặp.
    if (
        botRecalled.get(`${account}:${d.content?.globalMsgId}`) ||
        botRecalled.get(`${account}:${d.content?.cliMsgId}`)
    ) {
        return;
    }
    const target =
        recent.get(`${account}:${d.content?.cliMsgId}`) || recent.get(`${account}:${d.content?.globalMsgId}`);
    const who = undo.isSelf ? OWNER : d.dName || "";
    const text = target ? `«${target.summary}»` : "(nội dung tin không còn trong bộ nhớ của bot)";
    await postEvent(account, undo.threadId, Boolean(undo.isGroup), "recall", who, text, d.msgId);
}

/** Reaction thành ghi chú: emoji + tin được thả cảm xúc. */
export async function forwardReaction(account, reaction) {
    const d = reaction.data || {};
    const ref = (d.content?.rMsg || [])[0] || {};
    const target = recent.get(`${account}:${ref.cMsgID}`) || recent.get(`${account}:${ref.gMsgID}`);
    const who = reaction.isSelf ? OWNER : d.dName || "";
    const text = `${reactionEmoji(d.content?.rIcon)}${target ? ` vào tin «${target.summary}»` : ""}`;
    await postEvent(account, reaction.threadId, Boolean(reaction.isGroup), "reaction", who, text, d.msgId);
}

/** Sự kiện nhóm đáng chú ý (đổi tên, vào/ra, phó nhóm, cài đặt...) thành ghi chú. */
export async function forwardGroupEvent(account, event) {
    const d = event.data || {};
    const settingKey = `${account}:${event.threadId}`;
    const previousSetting = groupSettings.get(settingKey) || null;
    if (d.groupSetting) groupSettings.set(settingKey, d.groupSetting);
    if (event.type === "update" || event.type === "update_avatar") {
        // Tin sau sẽ tra lại tên/ảnh nhóm và gateway cập nhật Libredesk.
        profiles.delete(`${account}:g:${event.threadId}`);
    }
    const text = groupEventText(event, previousSetting);
    if (!text) return;
    const detail = event.type === "update_setting" ? JSON.stringify(d.groupSetting || {}) : d.groupName || "";
    const id = `${event.type}-${d.groupId || event.threadId}-${detail}-${(d.updateMembers || d.uids || []).length}`;
    await postEvent(account, event.threadId, true, "group_event", "", text, `${id}-${Math.floor(Date.now() / 60000)}`);
}

/** Lời mời kết bạn từ người khác thành tin của khách (thường là khách mới); các sự
 *  kiện bạn bè khác thành ghi chú trong hội thoại 1-1 đã có. */
export async function forwardFriendEvent(account, api, event) {
    const info = friendEventInfo(event, api.getOwnId());
    if (!info?.threadId) return;
    const minute = Math.floor(Date.now() / 60000);
    if (info.kind !== "request") {
        await postEvent(
            account,
            info.threadId,
            false,
            "friend_event",
            "",
            info.text,
            `${event.type}-${info.threadId}-${minute}`,
        );
        return;
    }
    const message = { threadId: info.threadId, data: { uidFrom: info.threadId, dName: "" } };
    const fields = await threadFields(account, api, message, false);
    try {
        await callGateway("/v1/inbound", {
            channel: CHANNEL,
            account,
            thread_id: String(info.threadId),
            is_group: false,
            ...fields,
            sender_name: fields.thread_name,
            text: info.text,
            // Gửi lại cùng lời mời trong ngày không tạo tin trùng.
            message_id: `friend-request-${info.threadId}-${Math.floor(minute / 1440)}`,
        });
    } catch (error) {
        log(account, "gateway", `❌ Không chuyển được lời mời kết bạn tới gateway: ${error.message}`);
    }
}

const TYPING_THROTTLE_MS = 3000;
const lastTyping = new Map(); // `${account}:${threadId}` -> lúc gửi "đang soạn" gần nhất

async function postPresence(account, threadId, kind, messageIds = []) {
    try {
        await callGateway("/v1/presence", {
            channel: CHANNEL,
            account,
            thread_id: String(threadId),
            kind,
            message_ids: messageIds.map(String),
        });
    } catch {
        // Trạng thái phụ: mất một lần không sao, không log để khỏi nhiễu.
    }
}

/** Khách đang soạn tin (Zalo gửi lại vài giây một lần): gửi gateway tối đa 3 giây/lần. */
export async function forwardTyping(account, typing, now = Date.now()) {
    if (typing.isSelf) return;
    const key = `${account}:${typing.threadId}`;
    if (now - (lastTyping.get(key) || 0) < TYPING_THROTTLE_MS) return;
    lastTyping.set(key, now);
    if (lastTyping.size > 4096) lastTyping.delete(lastTyping.keys().next().value);
    await postPresence(account, typing.threadId, "typing");
}

/** Khách đã xem tin: msgId (và realMsgId) của tin nhân viên đã gửi. */
export async function forwardSeen(account, seens) {
    for (const seen of Array.isArray(seens) ? seens : [seens]) {
        if (!seen || seen.isSelf) continue;
        const ids = [seen.data?.msgId, seen.data?.realMsgId].filter(Boolean);
        lastTyping.delete(`${account}:${seen.threadId}`);
        await postPresence(account, seen.threadId, "read", ids);
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
    const echo = {
        account,
        threadId: String(threadId),
        text,
        files: attachments.length,
        until: Date.now() + ECHO_WINDOW_MS,
    };
    pendingEchoes.push(echo);
    try {
        const quote = payload.reply_to ? quotable.get(`${account}:${payload.reply_to}`) : undefined;
        const content = sendContent(text, attachments, quote);
        const result = await api.sendMessage(content, String(threadId), isGroup ? ThreadType.Group : ThreadType.User);
        const ids = [result?.message?.msgId, ...(result?.attachment || []).map((a) => a?.msgId)].filter(Boolean);
        botSent.remember(
            ids.map((id) => `${account}:${id}`),
            true,
        );
        log(
            account,
            "gateway",
            `Đã gửi tin trả lời của nhân viên${attachments.length ? ` (${attachments.length} tệp)` : ""}.`,
        );
        // Gateway giữ các id này để nhân viên thu hồi tin sau.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message_ids: ids.map(String) }));
    } catch (error) {
        recentReplies.delete(messageId);
        pendingEchoes = pendingEchoes.filter((p) => p !== echo);
        const permanent = isPermanent(error);
        log(
            account,
            "gateway",
            `❌ Gửi tin trả lời thất bại${permanent ? " (Zalo từ chối)" : ""}: ${error?.message || error}`,
        );
        reply(res, permanent ? 422 : 502, permanent ? "rejected by zalo" : "send failed");
    }
}

/** Đọc body JSON (giới hạn MAX_SEND_BODY); null nếu lỗi (đã trả lời). */
async function readJSON(req, res) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_SEND_BODY) {
            reply(res, 413, "too large");
            return null;
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    } catch {
        reply(res, 400, "invalid json");
        return null;
    }
}

/** Thu hồi tin nhân viên đã gửi (undo cần msgId + cliMsgId đã nhớ khi bot nghe lại tin). */
async function handleRecall(req, res) {
    if (req.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) return reply(res, 401, "unauthorized");
    const payload = await readJSON(req, res);
    if (!payload) return;
    const { account, thread_id: threadId, is_group: isGroup } = payload;
    const ids = Array.isArray(payload.message_ids) ? payload.message_ids.map(String) : [];
    const api = apis.get(account);
    if (!api) return reply(res, 404, "unknown account");
    if (!threadId || ids.length === 0) return reply(res, 400, "invalid payload");
    const targets = ids.map((id) => sentEchoes.get(`${account}:${id}`));
    if (targets.some((t) => !t?.cliMsgId)) {
        return reply(res, 409, "Bot chưa nghe lại tin này từ Zalo nên chưa thu hồi được; thử lại sau ít giây.");
    }
    try {
        for (const target of targets) {
            botRecalled.remember([`${account}:${target.msgId}`, `${account}:${target.cliMsgId}`], true);
            await api.undo(target, String(threadId), isGroup ? ThreadType.Group : ThreadType.User);
        }
        log(account, "gateway", `Đã thu hồi tin nhân viên (${targets.length} tin).`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    } catch (error) {
        const permanent = isPermanent(error);
        log(account, "gateway", `❌ Thu hồi thất bại: ${error?.message || error}`);
        reply(
            res,
            permanent ? 422 : 502,
            permanent ? `Zalo từ chối thu hồi: ${error?.message || error}` : "recall failed",
        );
    }
}

/** Số điện thoại Việt Nam -> dạng Zalo tra được ("84..."); null nếu không giống số điện thoại. */
export function normalizePhone(raw) {
    const digits = String(raw || "").replace(/[\s.()-]/g, "");
    if (!/^\+?\d{9,15}$/.test(digits)) return null;
    if (digits.startsWith("+")) return digits.slice(1);
    if (digits.startsWith("0")) return `84${digits.slice(1)}`;
    return digits;
}

/** Tìm người nhận cho tin nhân viên nhắn trước: số điện thoại -> uid, tên, ảnh. */
async function handleResolve(req, res) {
    if (req.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) return reply(res, 401, "unauthorized");
    const payload = await readJSON(req, res);
    if (!payload) return;
    const api = apis.get(payload.account);
    if (!api) return reply(res, 404, "unknown account");
    const phone = normalizePhone(payload.to);
    if (!phone) return reply(res, 400, "Nhập số điện thoại Zalo của khách.");
    try {
        const user = await api.findUser(phone);
        if (!user?.uid) return reply(res, 404, "Không tìm thấy tài khoản Zalo với số này.");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                thread_id: String(user.uid),
                name: user.display_name || user.zalo_name || "",
                avatar: user.avatar || "",
            }),
        );
    } catch (error) {
        const permanent = isPermanent(error);
        reply(res, permanent ? 404 : 502, permanent ? "Không tìm thấy tài khoản Zalo với số này." : "resolve failed");
    }
}

/** HTTP cho gateway: POST /send (tin nhân viên) và `extra` (vd. /accounts), cùng token. */
export function startSendServer(extra = null) {
    if (GATEWAY_TOKEN.length < 32) {
        log("", "gateway", "GATEWAY_TOKEN phải dài ít nhất 32 ký tự.");
        process.exit(1);
    }
    const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/send") {
            handleSend(req, res).catch(() => reply(res, 500, "error"));
        } else if (req.method === "POST" && req.url === "/resolve") {
            handleResolve(req, res).catch(() => reply(res, 500, "error"));
        } else if (req.method === "POST" && req.url === "/recall") {
            handleRecall(req, res).catch(() => reply(res, 500, "error"));
        } else if (extra && req.headers.authorization === `Bearer ${GATEWAY_TOKEN}`) {
            extra(req, res, reply)
                .then((handled) => handled || reply(res, 404, "not found"))
                .catch((error) => {
                    log("", "gateway", `❌ ${req.method} ${req.url}: ${error?.message || error}`);
                    if (!res.headersSent) reply(res, 500, "error");
                });
        } else if (extra) {
            reply(res, 401, "unauthorized");
        } else {
            reply(res, 404, "not found");
        }
    });
    server.listen(LISTEN_PORT, "0.0.0.0", () => log("", "gateway", `Nhận tin trả lời tại :${LISTEN_PORT}/send`));
    return server;
}
