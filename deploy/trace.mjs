// Ghi nguyên payload sự kiện Zalo của các tài khoản trong ZALO_TRACE (vd. "shop1,acc2")
// để đọc cấu trúc loại tin mới. Chỉ dùng cho tài khoản thử: file chứa nội dung tin.
// Mỗi tài khoản một file <ACCOUNTS_DIR>/../trace/<tài khoản>.jsonl, quyền 0600,
// dừng ghi khi chạm TRACE_MAX_BYTES.

import fs from "node:fs";
import path from "node:path";

import { ACCOUNTS_DIR, log } from "./common.mjs";

export const TRACE_MAX_BYTES = 20 << 20;

export function traceAccounts(value = process.env.ZALO_TRACE || "") {
    return new Set(
        value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

export class EventTrace {
    constructor(file, maxBytes = TRACE_MAX_BYTES) {
        this.file = file;
        this.maxBytes = maxBytes;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        // Không ghi đè file cũ, không đi theo symlink có sẵn.
        const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
        fs.fchmodSync(fd, 0o600);
        this.size = fs.fstatSync(fd).size;
        this.fd = fd;
    }

    write(kind, payload) {
        if (this.fd == null || this.size >= this.maxBytes) return;
        let line;
        try {
            line = JSON.stringify({ t: Date.now(), kind, payload }) + "\n";
        } catch {
            return;
        }
        fs.writeSync(this.fd, line);
        this.size += Buffer.byteLength(line);
    }
}

const opened = new Map();

/** EventTrace cho tài khoản nếu nó có trong ZALO_TRACE; null nếu không. Mở một lần mỗi tiến trình. */
export function openTrace(account, accounts = traceAccounts(), dir = path.join(ACCOUNTS_DIR, "..", "trace")) {
    if (!accounts.has(account)) return null;
    const key = path.join(dir, `${account}.jsonl`);
    if (opened.has(key)) return opened.get(key);
    try {
        const trace = new EventTrace(key);
        opened.set(key, trace);
        log(account, "trace", `Đang ghi payload sự kiện (ZALO_TRACE) vào ${trace.file}`);
        return trace;
    } catch (error) {
        log(account, "trace", `Không mở được file trace: ${error.message}`);
        return null;
    }
}
