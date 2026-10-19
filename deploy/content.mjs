// Chuyển tin/sự kiện Zalo thành chữ hiển thị được trong Libredesk (hàm thuần, không gọi mạng).
// Dựa trên payload thật ghi lại từ zca-js: chat.recommended (link, danh thiếp),
// group.poll, chat.sticker, quote, reaction, undo, group_event.

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

/** Dòng tóm tắt một tin để nhớ (cho thu hồi/reaction) và để trích dẫn. */
export function summarize(message) {
    const text = describeContent(message).replace(/\s+/g, " ").trim();
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

/** Chữ cho group_event; null nếu loại sự kiện không đáng ghi chú. */
export function groupEventText(event) {
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
}
