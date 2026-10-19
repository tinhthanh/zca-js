// Chạy trong image (cần dist/): xem deploy/README.md, mục Test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { discoverAccounts, isValidCredentials, readCredentials, writePrivateJson } from "../common.mjs";
import {
    findCoordinates,
    groupEventText,
    quoteText,
    reactionEmoji,
    RecentMessages,
    systemNoticeText,
} from "../content.mjs";
import {
    captionOf,
    describeContent,
    downloadAttachment,
    downloadVideoThumb,
    imageSize,
    isBotEcho,
    toAttachmentSource,
    videoText,
} from "../gateway.mjs";

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
    assert.equal(describeContent({ data: { msgType: "chat.sticker", content: {} } }), "[Sticker]");
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

test("captionOf giữ chú thích ảnh/video, bỏ tên file", () => {
    const of = (msgType, title) => captionOf({ data: { msgType, content: { title } } });
    assert.equal(of("chat.photo", "ảnh đẹp"), "ảnh đẹp");
    assert.equal(of("chat.video.msg", "UI-10 video"), "UI-10 video");
    assert.equal(of("share.file", "bao-gia.pdf"), "");
    assert.equal(of("chat.voice", ""), "");
});

test("videoText kèm thời lượng và link; downloadVideoThumb chỉ nhận ảnh", async () => {
    const video = (title, params) => ({
        data: {
            msgType: "chat.video.msg",
            content: { title, href: "https://video.zdn.vn/v.mp4", thumb: "https://thumb.zdn.vn/t.jpg", params },
        },
    });
    assert.equal(
        videoText(video("Clip", JSON.stringify({ duration: 65000 }))),
        "Clip\n🎬 Video · 1:05\n▶️ Xem: https://video.zdn.vn/v.mp4",
    );
    assert.equal(videoText(video("", "không phải json")), "🎬 Video\n▶️ Xem: https://video.zdn.vn/v.mp4");
    const thumb = await downloadVideoThumb(video("", ""), fakeFetch("J", { "content-type": "image/jpeg" }));
    assert.equal(thumb.name, "xem-truoc-video.jpg");
    assert.equal(await downloadVideoThumb(video("", ""), fakeFetch("x", { "content-type": "text/html" })), null);
    assert.equal(
        await downloadVideoThumb({ data: { msgType: "chat.photo", content: { thumb: "https://a/b.jpg" } } }),
        null,
    );
});

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

// --- Nội dung giàu (payload rút gọn từ tin thật, dữ liệu giả) ---

test("describeContent hiển thị link, danh thiếp, bình chọn, vị trí, sticker", () => {
    const link = {
        data: {
            msgType: "chat.recommended",
            content: {
                title: "Xem https://zalo.me",
                href: "https://zalo.me",
                description: "Mô tả",
                action: "recommened.link",
            },
        },
    };
    assert.equal(describeContent(link), "🔗 Xem https://zalo.me\nMô tả"); // tiêu đề đã chứa URL: không lặp
    const card = {
        data: {
            msgType: "chat.recommended",
            content: {
                title: "Nguyễn Văn A",
                description: '{"qrCodeUrl":"https://qr/x.jpg"}',
                action: "recommened.user",
            },
        },
    };
    assert.equal(describeContent(card), "👤 Danh thiếp: Nguyễn Văn A\nMã QR: https://qr/x.jpg");
    const poll = {
        data: {
            msgType: "group.poll",
            content: { action: "create", params: '{"question":"Ăn gì?","dName":"Bình"}' },
        },
    };
    assert.equal(describeContent(poll), "📊 Bình tạo bình chọn: Ăn gì?");
    const place = {
        data: {
            msgType: "chat.location.new",
            content: { title: "Quán", params: '{"latitude":10.77,"longitude":106.7}' },
        },
    };
    assert.equal(describeContent(place), "📍 Vị trí: Quán\nhttps://maps.google.com/?q=10.77,106.7");
    assert.deepEqual(findCoordinates({ params: "not json" }), null);
    assert.equal(describeContent({ data: { msgType: "chat.sticker", content: { id: 1, catId: 2 } } }), "[Sticker]");
    // Thẻ nhắc hẹn ghi từ Zalo desktop: href là ảnh nền, không hiện.
    const ecard = {
        data: {
            msgType: "chat.ecard",
            content: {
                title: "⏰ Họp",
                description: "Thứ Hai, 19 tháng 10 lúc 23:43",
                href: "https://res-zalo.zadn.vn/upload/media/2018/8/3/reminder_02.png",
            },
        },
    };
    assert.equal(describeContent(ecard), "🎴 ⏰ Họp\nThứ Hai, 19 tháng 10 lúc 23:43");
    // Thẻ tài khoản ngân hàng (payload thật rút gọn): không có số tài khoản, chỉ nhãn và link.
    const bank = {
        data: {
            msgType: "chat.webcontent",
            content: {
                title: "",
                href: "",
                action: "zinstant.bankcard",
                params: JSON.stringify({
                    pcItem: { data_url: "https://zinst-stc.zadn.vn/static/x?data=html" },
                    customMsg: { msg: { en: "[Bank account]", vi: "[Tài khoản ngân hàng]" } },
                }),
            },
        },
    };
    assert.equal(
        describeContent(bank),
        "💳 Tài khoản ngân hàng\nXem thẻ: https://zinst-stc.zadn.vn/static/x?data=html",
    );
});

test("quoteText, reactionEmoji và groupEventText", () => {
    assert.equal(quoteText({ data: { quote: { msg: "giá?", fromD: "An" } } }), "An: giá?");
    assert.equal(quoteText({ data: { quote: { msg: "", attach: "{...}", fromD: "An" } } }), "An: [Tệp đính kèm]");
    assert.equal(quoteText({ data: {} }), "");
    assert.equal(reactionEmoji("/-heart"), "❤️");
    assert.equal(reactionEmoji("/-unknown"), "/-unknown");
    assert.equal(groupEventText({ type: "update", data: { groupName: "Nhóm mới" } }), "Nhóm đổi tên thành «Nhóm mới»");
    assert.equal(
        groupEventText({ type: "join", data: { updateMembers: [{ dName: "An" }, { dName: "Bình" }] } }),
        "An, Bình đã vào nhóm",
    );
    assert.equal(groupEventText({ type: "update_board", data: {} }), null);
});

test("RecentMessages giới hạn kích thước theo LRU", () => {
    const cache = new RecentMessages(2);
    cache.remember(["a", "b"], 1);
    cache.remember(["c"], 2);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("c"), 2);
});

test("isBotEcho bỏ qua tin isSelf vừa được bot gửi, giữ tin chủ tài khoản tự gửi", () => {
    // Không có tin chờ: tin isSelf là của chủ tài khoản.
    assert.equal(isBotEcho("acc", { threadId: "t1", data: { msgId: "x1", content: "chào" } }), false);
});

test("describeContent hiển thị nhật ký cuộc gọi Zalo", () => {
    const call = (action, params) =>
        describeContent({
            data: {
                msgType: "chat.recommended",
                content: {
                    title: "sendBubbleMessage",
                    description: "Cuộc gọi",
                    action,
                    params: JSON.stringify(params),
                },
            },
        });
    // Payload thật của cuộc gọi nhỡ từ Zalo desktop.
    assert.equal(
        call("recommened.misscall", { callId: 1427313081, duration: 0, reason: 0, isCaller: 0, calltype: 0 }),
        "📞 Cuộc gọi thoại nhỡ",
    );
    assert.equal(call("recommened.calltime", { callId: 1, duration: 83, calltype: 1 }), "📞 Cuộc gọi video · 1:23");
    assert.equal(call("recommened.calltime", { callId: 1, duration: 0, calltype: 0 }), "📞 Cuộc gọi thoại");
});

test("systemNoticeText: nhắc hẹn đến giờ do Zalo gửi là thông báo", () => {
    const ecard = (dName) => ({
        data: { msgType: "chat.ecard", dName, uidFrom: "123", content: { title: "⏰ Họp", description: "23:43" } },
    });
    assert.equal(systemNoticeText(ecard("Zalo")), "🎴 ⏰ Họp\n23:43");
    assert.equal(systemNoticeText(ecard("An")), null);
});

test("systemNoticeText nhận ra thông báo hệ thống webchat dạng object", () => {
    const notice = { data: { msgType: "webchat", content: { title: "Bạn vừa kết bạn với An" } } };
    assert.equal(systemNoticeText(notice), "Bạn vừa kết bạn với An");
    assert.equal(systemNoticeText({ data: { msgType: "webchat", content: "chào" } }), null);
    assert.equal(systemNoticeText({ data: { msgType: "chat.photo", content: { title: "x" } } }), null);
});
