// Chạy trong image (cần dist/): xem deploy/README.md, mục Test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { discoverAccounts, isValidCredentials, readCredentials, writePrivateJson } from "../common.mjs";
import { describeContent } from "../gateway.mjs";

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "zalo-deploy-"));
}

const credentials = { cookie: [{ key: "zpw_sek", value: "x" }], imei: "imei", userAgent: "ua" };

test("isValidCredentials cần cookie, imei và userAgent", () => {
    assert.equal(isValidCredentials(credentials), true);
    assert.equal(isValidCredentials({ ...credentials, cookie: [] }), false);
    assert.equal(isValidCredentials({ ...credentials, imei: "" }), false);
    assert.equal(isValidCredentials(null), false);
});

test("writePrivateJson ghi atomically với quyền 0600 và thư mục 0700", () => {
    const root = tempDir();
    const file = path.join(root, "acc", "credentials.json");
    writePrivateJson(file, credentials);
    assert.deepEqual(readCredentials(file), credentials);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(
        fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
        [],
    );
});

test("readCredentials trả null khi file hỏng", () => {
    const root = tempDir();
    const file = path.join(root, "credentials.json");
    fs.writeFileSync(file, "{not json");
    assert.equal(readCredentials(file), null);
});

test("discoverAccounts chỉ lấy thư mục có credentials và tên hợp lệ", () => {
    const root = tempDir();
    for (const name of ["beta", "alpha", "-bad"])
        writePrivateJson(path.join(root, name, "credentials.json"), credentials);
    fs.mkdirSync(path.join(root, "empty"));
    assert.deepEqual(
        discoverAccounts(root).map((account) => account.name),
        ["alpha", "beta"],
    );
    assert.deepEqual(discoverAccounts(path.join(root, "missing")), []);
});

test("describeContent giữ chữ và mô tả file đính kèm", () => {
    assert.equal(describeContent({ data: { content: "xin chào" } }), "xin chào");
    assert.equal(
        describeContent({ data: { msgType: "chat.photo", content: { title: "", href: "https://x/y.jpg" } } }),
        "[chat.photo] https://x/y.jpg",
    );
    assert.equal(describeContent({ data: { msgType: "chat.sticker", content: {} } }), "[chat.sticker]");
});
