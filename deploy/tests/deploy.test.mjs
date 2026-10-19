// Chạy trong image (cần dist/): xem deploy/README.md, mục Test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { discoverAccounts, isValidCredentials, readCredentials, writePrivateJson } from "../common.mjs";
import { describeContent, downloadAttachment, imageSize, toAttachmentSource } from "../gateway.mjs";

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

function png(width, height) {
    const buf = Buffer.alloc(33);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
}

function jpeg(width, height) {
    // SOI, APP0 (độ dài 16), SOF0 với chiều cao/rộng.
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

test("imageSize đọc PNG, JPEG, GIF và bỏ qua dữ liệu lạ", () => {
    assert.deepEqual(imageSize(png(640, 480)), { width: 640, height: 480 });
    assert.deepEqual(imageSize(jpeg(1280, 720)), { width: 1280, height: 720 });
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([10, 0, 20, 0]), Buffer.alloc(4)]);
    assert.deepEqual(imageSize(gif), { width: 10, height: 20 });
    assert.deepEqual(imageSize(Buffer.from("not an image at all")), {});
});

test("toAttachmentSource thêm đuôi file và kích thước ảnh", () => {
    const source = toAttachmentSource({ name: "anh", content_type: "image/png", data: png(3, 4).toString("base64") });
    assert.equal(source.filename, "anh.png");
    assert.deepEqual(source.metadata, { totalSize: 33, width: 3, height: 4 });
    assert.equal(toAttachmentSource({ name: "x.pdf", content_type: "application/pdf", data: "" }), null);
});

function fakeFetch(body, headers = {}) {
    return async () => new Response(body, { status: 200, headers });
}

test("downloadAttachment lấy file Zalo, dùng title làm tên file", async () => {
    const message = {
        data: { msgType: "share.file", content: { title: "bao-gia.pdf", href: "https://cdn.zalo/x/abc" } },
    };
    const file = await downloadAttachment(message, fakeFetch("PDFDATA", { "content-type": "application/pdf" }));
    assert.deepEqual(file, {
        name: "bao-gia.pdf",
        content_type: "application/pdf",
        data: Buffer.from("PDFDATA").toString("base64"),
    });
    const photo = { data: { msgType: "chat.photo", content: { title: "", href: "https://cdn.zalo/p/img.jpg" } } };
    assert.equal((await downloadAttachment(photo, fakeFetch("J", { "content-type": "image/jpeg" }))).name, "img.jpg");
});

test("downloadAttachment bỏ qua sticker và từ chối file quá lớn", async () => {
    const sticker = { data: { msgType: "chat.sticker", content: { href: "https://x" } } };
    assert.equal(await downloadAttachment(sticker, fakeFetch("x")), null);
    const big = { data: { msgType: "share.file", content: { title: "big.zip", href: "https://cdn.zalo/big" } } };
    await assert.rejects(
        downloadAttachment(big, fakeFetch("x", { "content-length": String(999 * 1024 * 1024) })),
        /quá lớn/,
    );
});
