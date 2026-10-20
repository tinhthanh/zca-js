// Lịch sử kết nối của từng tài khoản: rớt lúc nào, vì sao, nối lại khi nào.
// Hiện ở trang "Tài khoản kênh" (trường `history` của /accounts) và lưu ra
// <tài khoản>/history.json (0600) để khởi động lại vẫn còn. Chỉ ghi nhãn do bot
// tự phân loại, không ghi cookie.
import fs from "node:fs";

import { writePrivateJson } from "./common.mjs";

export const HISTORY_FILE = "history.json";
const HISTORY_MAX = 30;

/** Mã đóng WebSocket của Zalo -> {kind, message}. */
export function closeCause(code) {
    switch (Number(code)) {
        case 1006:
            return { kind: "network", message: "Kết nối Zalo bị đứt đột ngột (mạng chập chờn hoặc mất mạng)." };
        case 3000:
            return {
                kind: "platform",
                message: "Zalo ngắt vì có kết nối trùng (tài khoản mở Zalo Web/PC ở nơi khác).",
            };
        case 3003:
            return { kind: "platform", message: "Zalo chủ động ngắt kết nối của bot (kick)." };
        case 1000:
            return { kind: "disconnected", message: "Kết nối Zalo đóng bình thường." };
        default:
            return { kind: "disconnected", message: `Kết nối Zalo đóng (mã ${code}).` };
    }
}

export class ConnectionHistory {
    constructor(file = null, now = () => new Date()) {
        this.file = file;
        this.now = now;
        this.items = [];
        if (!file) return;
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            if (Array.isArray(data)) this.items = data.filter((i) => i && typeof i === "object").slice(-HISTORY_MAX);
        } catch {
            // Chưa có hoặc hỏng: bắt đầu trống.
        }
    }

    /** Thêm một mốc; trùng mốc ngay trước (cùng kind + message) thì chỉ tăng count. */
    record(kind, message = "") {
        const at = this.now()
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z");
        const last = this.items[this.items.length - 1];
        if (last && last.kind === kind && last.message === message) {
            last.count = (last.count || 1) + 1;
            last.last_at = at;
        } else {
            this.items.push({ at, kind, message });
            this.items.splice(0, Math.max(0, this.items.length - HISTORY_MAX));
        }
        if (!this.file) return;
        try {
            writePrivateJson(this.file, this.items);
        } catch {
            // Lịch sử chỉ để xem: lỗi ghi không làm hỏng bot.
        }
    }

    /** Mới nhất trước. */
    list() {
        return [...this.items].reverse().map((i) => ({ ...i }));
    }
}
