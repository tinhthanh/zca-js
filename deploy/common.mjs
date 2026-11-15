// Tiện ích dùng chung cho login.mjs và bot.mjs (phần deploy của fork).
import fs from "node:fs";
import path from "node:path";

export const ACCOUNTS_DIR = process.env.ZALO_ACCOUNTS_DIR || "/data/accounts";
export const ACCOUNT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const CREDENTIALS_FILE = "credentials.json";

export function log(label, tag, message) {
    const time = new Date().toTimeString().slice(0, 8);
    const prefix = label ? `[${label}] ` : "";
    console.log(`[${time}] ${prefix}[${tag}] ${message}`);
}

export function isValidCredentials(credentials) {
    return Boolean(
        credentials &&
            Array.isArray(credentials.cookie) &&
            credentials.cookie.length > 0 &&
            credentials.imei &&
            credentials.userAgent,
    );
}

export function readCredentials(file) {
    try {
        const credentials = JSON.parse(fs.readFileSync(file, "utf-8"));
        return isValidCredentials(credentials) ? credentials : null;
    } catch {
        return null;
    }
}

/** Ghi JSON atomically với quyền 0600; thư mục cha quyền 0700. */
export function writePrivateJson(file, data) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
    try {
        const fd = fs.openSync(tmp, "w", 0o600);
        try {
            fs.writeSync(fd, JSON.stringify(data, null, 2) + "\n");
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
    } catch (error) {
        fs.rmSync(tmp, { force: true });
        throw error;
    }
}

export function discoverAccounts(root = ACCOUNTS_DIR) {
    if (!fs.existsSync(root)) return [];
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .filter((name) => {
            if (!fs.existsSync(path.join(root, name, CREDENTIALS_FILE))) return false;
            if (ACCOUNT_NAME_PATTERN.test(name)) return true;
            log("", "multi", `Bỏ qua thư mục tài khoản có tên không hợp lệ: ${JSON.stringify(name)}`);
            return false;
        })
        .map((name) => ({ name, dir: path.join(root, name) }));
}
