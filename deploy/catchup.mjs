// Lấy lại tin Zalo bị lỡ khi bot không chạy (khởi động lại, mất mạng).
// zca-js chỉ đẩy tin mới qua websocket; tin trong lúc ngắt phải xin lại bằng
// listener.requestOldMessages(type, lastMsgId) và đến qua sự kiện old_messages.
// Mỗi tài khoản lưu mốc tin cuối đã xử lý (1-1 và nhóm riêng) để sau khi khởi
// động lại chỉ chuyển tin mới hơn mốc: không gửi lặp lịch sử vào Libredesk.
import fs from "node:fs";

import { ThreadType } from "../dist/index.js";
import { writePrivateJson } from "./common.mjs";
import { RecentMessages } from "./content.mjs";

const SAVE_DELAY_MS = 2000;

function kindOf(message) {
    return message.type === ThreadType.Group ? "group" : "user";
}

export class CatchUp {
    constructor(file, { saveDelayMs = SAVE_DELAY_MS } = {}) {
        this.file = file;
        this.saveDelayMs = saveDelayMs;
        this.state = {};
        this.seen = new RecentMessages(8192);
        this.timer = null;
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            if (data && typeof data === "object") this.state = data;
        } catch {
            // Chưa có mốc: lần chạy đầu chỉ bắt đầu ghi, không xin tin cũ.
        }
    }

    /** msgId cuối đã xử lý cho ThreadType.User/Group, hoặc null nếu chưa có mốc. */
    lastId(type) {
        return this.state[type === ThreadType.Group ? "group" : "user"]?.msgId || null;
    }

    /** Tin sống: true nếu chưa xử lý trong phiên này (tin cũ có thể đến trước). */
    acceptLive(message) {
        const id = String(message.data?.msgId || "");
        if (id && this.seen.get(id)) return false;
        this.mark(message);
        return true;
    }

    /** Tin cũ: chỉ nhận tin mới hơn mốc đã lưu và chưa xử lý. */
    acceptOld(message) {
        const id = String(message.data?.msgId || "");
        const ts = Number(message.data?.ts) || 0;
        const last = this.state[kindOf(message)];
        if (!last || !id || this.seen.get(id) || ts <= (Number(last.ts) || 0)) return false;
        this.mark(message);
        return true;
    }

    mark(message) {
        const id = String(message.data?.msgId || "");
        const ts = Number(message.data?.ts) || 0;
        if (id) this.seen.remember([id], true);
        const kind = kindOf(message);
        if (!id || ts < (Number(this.state[kind]?.ts) || 0)) return;
        this.state[kind] = { msgId: id, ts };
        this.scheduleSave();
    }

    scheduleSave() {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.saveDelayMs);
        this.timer.unref?.();
    }

    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        try {
            writePrivateJson(this.file, this.state);
        } catch {
            // Mất mốc chỉ làm lần sau không xin được tin cũ; không chặn tin hiện tại.
        }
    }
}
