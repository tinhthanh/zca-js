// Chuyển tin/sự kiện Zalo thành chữ hiển thị được trong Libredesk (hàm thuần, không gọi mạng).
// Dựa trên payload thật ghi lại từ zca-js: chat.recommended (link, danh thiếp),
// group.poll, chat.sticker, quote, reaction, undo, group_event, friend_event.

import { FriendEventType } from "../dist/index.js";

const REACTION_EMOJI = {
    "/-heart": "❤️",
    "/-strong": "👍",
    ":>": "😆",
    ":o": "😮",
    ":-((": "😢",
    ":-h": "😡",
    ":-*": "😘",
    ":')": "😂",
    "/-shit": "💩",
    "/-rose": "🌹",
    "/-break": "💔",
    "/-weak": "👎",
    ";xx": "😍",
    ";-/": "😕",
    ";-)": "😉",
    "/-fade": "🌸",
    "/-li": "☀️",
    "/-bd": "🎂",
    "/-bome": "💣",
    "/-ok": "👌",
    "/-v": "✌️",
    "/-thanks": "🙏",
    "/-punch": "👊",
    "/-share": "↗️",
    "_()_": "🙏",
    "/-no": "🙅",
    "/-bad": "👎",
    "/-loveu": "🤟",
};

function parseJson(value) {
    if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function joinLines(...lines) {
    return lines.filter((line) => typeof line === "string" && line.trim()).join("\n");
}

/** Tìm toạ độ trong content/params với các tên khoá thường gặp. */
export function findCoordinates(content) {
    const sources = [content, parseJson(content?.params), parseJson(content?.description)].filter(Boolean);
    for (const src of sources) {
        const lat = src.latitude ?? src.lat;
        const lng = src.longitude ?? src.lng ?? src.long ?? src.lon;
        if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== "" && lng !== "") {
            return { lat: Number(lat), lng: Number(lng) };
        }
    }
    return null;
}

/** Nhật ký cuộc gọi (chat.recommended, action recommened.misscall/...): params có callId, duration (giây), calltype. */
function callText(action, params) {
    const kind = Number(params.calltype) === 1 ? "video" : "thoại";
    if (String(action || "").includes("misscall")) return `📞 Cuộc gọi ${kind} nhỡ`;
    const seconds = Number(params.duration) || 0;
    if (seconds <= 0) return `📞 Cuộc gọi ${kind}`;
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, "0");
    return `📞 Cuộc gọi ${kind} · ${mm}:${ss}`;
}

/** Chữ hiển thị cho một tin Zalo (không gồm phần file tải về). */
export function describeContent(message) {
    const data = message.data || {};
    const content = data.content;
    if (typeof content === "string") return content;
    const type = data.msgType || "attachment";
    const c = content && typeof content === "object" ? content : {};
    const params = parseJson(c.params) || {};
    switch (type) {
        case "chat.recommended":
            if (params.callId != null) return callText(c.action, params);
            if (c.action === "recommened.user") {
                const card = parseJson(c.description) || {};
                return joinLines(
                    `👤 Danh thiếp: ${c.title || "(không tên)"}`,
                    card.qrCodeUrl && `Mã QR: ${card.qrCodeUrl}`,
                );
            }
            return joinLines(
                `🔗 ${c.title || c.href || "Liên kết"}`,
                !(c.title || "").includes(c.href || "\u0000") && c.href,
                c.description,
            );
        case "chat.link":
            return joinLines(`🔗 ${c.title || c.href || "Liên kết"}`, c.href, c.description);
        case "group.poll": {
            const question = params.question || c.title || "";
            const verb = c.action === "create" ? "tạo bình chọn" : `bình chọn (${c.action || "cập nhật"})`;
            return `📊 ${params.dName || data.dName || "Thành viên"} ${verb}: ${question}`;
        }
        case "chat.location.new": {
            const where = findCoordinates(c);
            return joinLines(
                `📍 Vị trí${c.title ? `: ${c.title}` : ""}`,
                c.description,
                where && `https://maps.google.com/?q=${where.lat},${where.lng}`,
            );
        }
        case "chat.todo":
            return joinLines(`✅ Việc cần làm: ${c.title || params.content || ""}`, c.description);
        case "chat.sticker":
            return "[Sticker]";
        case "chat.webcontent": {
            // Thẻ "zinstant" (tài khoản ngân hàng...): chỉ có nhãn và link tới thẻ đã render.
            const label = params.customMsg?.msg?.vi || params.customMsg?.msg?.en || c.title || "Thẻ";
            const icon = c.action === "zinstant.bankcard" ? "💳" : "🧩";
            const url = params.pcItem?.data_url || params.item?.data_url;
            return joinLines(`${icon} ${label.replace(/^\[(.*)\]$/, "$1")}`, url && `Xem thẻ: ${url}`);
        }
        case "chat.ecard":
            // Thẻ hệ thống (nhắc hẹn, ...): href chỉ là ảnh nền của thẻ.
            return joinLines(`🎴 ${c.title || "Thẻ"}`, c.description);
        default: {
            const parts = [c.title, c.description, c.href].filter((v) => typeof v === "string" && v.trim());
            return `[${type}]${parts.length ? " " + parts.join(" ") : ""}`;
        }
    }
}

/** Thông báo hệ thống của Zalo ("Bạn vừa kết bạn với ...") có msgType webchat nhưng
 *  content là object: không phải tin khách, nên thành ghi chú. Trả về chữ hoặc null. */
export function systemNoticeText(message) {
    const data = message.data || {};
    const c = data.content;
    if (data.msgType === "chat.ecard" && (data.uidFrom === "0" || data.dName === "Zalo")) {
        // Nhắc hẹn đến giờ: Zalo tự gửi thẻ vào hội thoại.
        return describeContent(message);
    }
    if (data.msgType !== "webchat" || !c || typeof c !== "object") return null;
    return [c.title, c.description].filter((v) => typeof v === "string" && v.trim()).join("\n") || null;
}

// Tin có tệp: nhãn ngắn thay cho "[chat.photo] URL" khi tóm tắt.
const MEDIA_LABELS = {
    "chat.photo": "🖼️ Ảnh",
    "chat.video.msg": "🎬 Video",
    "chat.voice": "🎤 Tin thoại",
    "chat.gif": "🖼️ GIF",
    "chat.doodle": "✏️ Hình vẽ",
    "chat.sticker": "🧩 Sticker",
};

function mediaSummary(message) {
    const type = message.data?.msgType;
    const c = message.data?.content;
    if (!c || typeof c !== "object") return null;
    const title = typeof c.title === "string" && !/^https?:\/\//.test(c.title.trim()) ? c.title.trim() : "";
    if (type === "share.file") return `📎 ${title || "Tệp"}`;
    if (!MEDIA_LABELS[type]) return null;
    return title && type !== "chat.sticker" ? `${MEDIA_LABELS[type]}: ${title}` : MEDIA_LABELS[type];
}

/** Dòng tóm tắt một tin để nhớ (cho thu hồi/reaction) và để trích dẫn. */
export function summarize(message) {
    const text = (mediaSummary(message) || describeContent(message)).replace(/\s+/g, " ").trim();
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** "Tên: nội dung" của tin được trích dẫn, hoặc "" nếu không có quote. */
export function quoteText(message) {
    const quote = message.data?.quote;
    if (!quote || typeof quote !== "object") return "";
    const body = (typeof quote.msg === "string" && quote.msg.trim()) || (quote.attach ? "[Tệp đính kèm]" : "");
    if (!body) return "";
    return quote.fromD ? `${quote.fromD}: ${body}` : body;
}

export function reactionEmoji(icon) {
    return REACTION_EMOJI[icon] || icon || "❓";
}

/** Chữ ghi chú cho reaction: emoji (hoặc bỏ cảm xúc) + tin được thả, kèm người gửi tin trong nhóm. */
export function reactionText(icon, target, isGroup) {
    const action = icon ? reactionEmoji(icon) : "Bỏ cảm xúc";
    if (!target) return `${action} vào một tin cũ (bot không còn nhớ nội dung)`;
    const owner = isGroup && target.sender ? ` của ${target.sender}` : "";
    return `${action} vào tin${owner} «${target.summary}»`;
}

// Cài đặt nhóm Zalo (groupSetting) -> nhãn cho nhân viên.
const GROUP_SETTING_LABELS = {
    blockName: "Chỉ trưởng/phó nhóm đổi tên, ảnh nhóm",
    signAdminMsg: "Làm nổi tin của trưởng/phó nhóm",
    addMemberOnly: "Chỉ trưởng/phó nhóm thêm thành viên",
    setTopicOnly: "Chỉ trưởng/phó nhóm ghim tin, tạo ghi chú, nhắc hẹn",
    enableMsgHistory: "Thành viên mới xem được tin cũ",
    joinAppr: "Duyệt thành viên mới",
    lockCreatePost: "Khoá tạo ghi chú, nhắc hẹn",
    lockCreatePoll: "Khoá tạo bình chọn",
    lockSendMsg: "Chỉ trưởng/phó nhóm được gửi tin",
    lockViewMember: "Ẩn danh sách thành viên",
};

/** Dòng mô tả các cài đặt nhóm đã đổi so với lần trước; [] nếu không biết lần trước. */
export function groupSettingChanges(previous, next) {
    if (!previous || !next) return [];
    return Object.entries(GROUP_SETTING_LABELS)
        .filter(([key]) => key in next && Boolean(previous[key]) !== Boolean(next[key]))
        .map(([key, label]) => `${label}: ${next[key] ? "bật" : "tắt"}`);
}

/** Chữ cho group_event; null nếu loại sự kiện không đáng ghi chú. Ghi chú, nhắc hẹn
 *  và ghim ghi chú không xử lý ở đây: Zalo đã gửi kèm tin hệ thống webchat. */
export function groupEventText(event, previousSetting = null) {
    const d = event.data || {};
    const names = (d.updateMembers || [])
        .map((m) => (typeof m === "string" ? m : m?.dName))
        .filter(Boolean)
        .join(", ");
    switch (event.type) {
        case "join":
            return `${names || "Thành viên mới"} đã vào nhóm`;
        case "leave":
            return `${names || "Một thành viên"} đã rời nhóm`;
        case "remove_member":
            return `${names || "Một thành viên"} bị mời ra khỏi nhóm`;
        case "block_member":
            return `${names || "Một thành viên"} bị chặn khỏi nhóm`;
        case "update":
            return d.groupName ? `Nhóm đổi tên thành «${d.groupName}»` : "Thông tin nhóm thay đổi";
        case "add_admin":
            return `${names || "Một thành viên"} được làm phó nhóm`;
        case "remove_admin":
            return `${names || "Một thành viên"} không còn là phó nhóm`;
        case "new_link":
            return "Nhóm tạo link mời mới";
        case "update_avatar":
            return "Nhóm đổi ảnh đại diện";
        case "update_setting": {
            const changes = groupSettingChanges(previousSetting, d.groupSetting);
            return changes.length ? `Cài đặt nhóm thay đổi:\n${changes.join("\n")}` : "Cài đặt nhóm thay đổi";
        }
        case "join_request": {
            const count = (d.uids || []).length || 1;
            return `${count} người xin vào nhóm${d.totalPending ? ` (đang chờ duyệt: ${d.totalPending})` : ""}`;
        }
        case "accept_remind":
            return `${(d.updateMembers || []).length || 1} người tham gia nhắc hẹn`;
        case "reject_remind":
            return `${(d.updateMembers || []).length || 1} người từ chối nhắc hẹn`;
        default:
            return null;
    }
}

/** Sự kiện bạn bè -> {threadId, kind, text} để ghi chú/chuyển; null nếu bỏ qua.
 *  `kind` là "request" (lời mời từ người khác: thành tin của khách) hoặc "note".
 *  zca-js đặt threadId của REQUEST/UNDO/REJECT là toUid (có thể là chính mình),
 *  nên lấy phía còn lại theo ownId. */
export function friendEventInfo(event, ownId) {
    const d = event.data;
    const other = (r) => (String(r?.fromUid) === String(ownId) ? r?.toUid : r?.fromUid);
    switch (event.type) {
        case FriendEventType.REQUEST: {
            const fromMe = String(d?.fromUid) === String(ownId);
            const msg = typeof d?.message === "string" ? d.message.trim() : "";
            if (fromMe) {
                return {
                    threadId: d?.toUid,
                    kind: "note",
                    text: `Chủ tài khoản đã gửi lời mời kết bạn${msg ? `: «${msg}»` : ""}`,
                };
            }
            return { threadId: d?.fromUid, kind: "request", text: joinLines("🤝 Lời mời kết bạn", msg && `«${msg}»`) };
        }
        case FriendEventType.UNDO_REQUEST:
            return { threadId: other(d), kind: "note", text: "Lời mời kết bạn đã bị thu hồi" };
        case FriendEventType.REJECT_REQUEST:
            return { threadId: other(d), kind: "note", text: "Lời mời kết bạn bị từ chối" };
        case FriendEventType.ADD:
            // Zalo đã gửi tin hệ thống "Bạn vừa kết bạn với ..." (ghi chú ℹ️): không lặp.
            return null;
        case FriendEventType.REMOVE:
            return { threadId: event.threadId, kind: "note", text: "Đã huỷ kết bạn" };
        case FriendEventType.BLOCK:
            return { threadId: event.threadId, kind: "note", text: "Chủ tài khoản đã chặn người này" };
        case FriendEventType.UNBLOCK:
            return { threadId: event.threadId, kind: "note", text: "Chủ tài khoản đã bỏ chặn người này" };
        default:
            return null;
    }
}

/** LRU nhỏ nhớ tin gần đây theo khoá (account + cliMsgId/msgId). */
export class RecentMessages {
    constructor(max = 4096) {
        this.max = max;
        this.items = new Map();
    }
    remember(keys, value) {
        for (const key of keys.filter(Boolean)) {
            this.items.delete(key);
            this.items.set(key, value);
        }
        while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
    }
    get(key) {
        return key ? this.items.get(key) : undefined;
    }
    /** Các cặp [key, value] để lưu xuống file (cũ trước, mới sau). */
    entries() {
        return [...this.items];
    }
    /** Nạp lại từ entries() đã lưu; bỏ qua dữ liệu hỏng. */
    restore(entries) {
        if (!Array.isArray(entries)) return;
        for (const entry of entries) {
            if (Array.isArray(entry) && typeof entry[0] === "string") this.remember([entry[0]], entry[1]);
        }
    }
}
