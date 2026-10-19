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
        default: {
            const parts = [c.title, c.description, c.href].filter((v) => typeof v === "string" && v.trim());
            return `[${type}]${parts.length ? " " + parts.join(" ") : ""}`;
        }
    }
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
