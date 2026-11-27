// Chạy trong image (cần dist/): xem deploy/README.md, mục Test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LoginQRCallbackEventType } from "../../dist/apis/loginQR.js";
import { FriendEventType, ThreadType, ZaloApiError } from "../../dist/index.js";

import { discoverAccounts, isValidCredentials, onlyAccount, readCredentials, writePrivateJson } from "../common.mjs";
import {
    findCoordinates,
    formatBytes,
    friendEventInfo,
    groupEventText,
    groupSettingChanges,
    pollDetailText,
    pollIdOf,
    quoteText,
    reactionEmoji,
    reactionText,
    reactionIcon,
    RecentMessages,
    summarize,
    systemNoticeText,
    isRedundantNotice,
    tooLargeText,
    voipSummary,
} from "../content.mjs";
import {
    accountRoutes,
    describeAccountError,
    LoginSession,
    retryDelay,
    SESSION_EXPIRED_MESSAGE,
    sessionExpired,
} from "../accounts.mjs";
import { CatchUp, isRecall, recallOf } from "../catchup.mjs";
import { CALL_PATHS, createCallAccounts, ensureVoicecallApi, forwardVoip, validateSignal } from "../call.mjs";
import { DEFAULT_WATCHDOG_STALE_MS, watchdogStaleMs, watchSocket } from "../watchdog.mjs";
import { EventTrace, openTrace, removeTrace, traceAccounts } from "../trace.mjs";
import { closeCause, ConnectionHistory } from "../history.mjs";
import {
    acceptFriend,
    sendFailure,
    createUserReminder,
    requestFriend,
    mp4Info,
    solidPng,
    captionOf,
    describeContent,
    downloadAttachment,
    FileTooLargeError,
    imageSize,
    sniffType,
    isBotEcho,
    toAttachmentSource,
    videoText,
    sendContent,
    forwardSeen,
    forwardTyping,
    normalizePhone,
    splitVoices,
    forgetAccount,
    restoreRecent,
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
        "🖼️ Ảnh\nhttps://x/y.jpg",
    );
    assert.equal(describeContent({ data: { msgType: "chat.sticker", content: {} } }), "🧩 Sticker");
    // Tải tệp thất bại: nhãn, tên/chú thích và link gốc thay cho "[share.file] ...".
    assert.equal(
        describeContent({ data: { msgType: "share.file", content: { title: "kq.pdf", href: "https://f/kq.pdf" } } }),
        "📎 kq.pdf\nhttps://f/kq.pdf",
    );
    assert.equal(
        describeContent({ data: { msgType: "chat.photo", content: { title: "Chào anh", href: "https://x/y.jpg" } } }),
        "🖼️ Ảnh: Chào anh\nhttps://x/y.jpg",
    );
    assert.equal(
        describeContent({ data: { msgType: "chat.voice", content: { href: "https://v/a.aac" } } }),
        "🎤 Tin thoại\nhttps://v/a.aac",
    );
    assert.equal(describeContent({ data: { msgType: "chat.unknown", content: { title: "x" } } }), "[chat.unknown] x");
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

test("videoText giữ chú thích và thêm thời lượng", () => {
    const video = (title, params) => ({ data: { msgType: "chat.video.msg", content: { title, params } } });
    assert.equal(videoText(video("Clip", JSON.stringify({ duration: 65000 }))), "Clip\n🎬 Video · 1:05");
    assert.equal(videoText(video("", "không phải json")), "🎬 Video");
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

test("downloadAttachment tải lại khi CDN trả body rỗng (ảnh album chưa sẵn sàng)", async () => {
    const photo = { data: { msgType: "chat.photo", content: { href: "https://cdn.zalo/p/album.jpg" } } };
    const bodies = ["", "", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])];
    let calls = 0;
    const slept = [];
    const fetchImpl = async () =>
        new Response(bodies[calls++], { status: 200, headers: { "content-type": "image/jpeg" } });
    const file = await downloadAttachment(photo, fetchImpl, { delays: [1, 2, 4], sleep: async (ms) => slept.push(ms) });
    assert.equal(calls, 3);
    assert.deepEqual(slept, [1, 2]);
    assert.equal(file.content_type, "image/jpeg");
    assert.equal(Buffer.from(file.data, "base64").length, 6);

    // Vẫn rỗng sau mọi lần thử: báo lỗi để bot gửi mô tả thay vì tệp rỗng.
    await assert.rejects(downloadAttachment(photo, fakeFetch(""), { delays: [1, 1], sleep: async () => {} }), /rỗng/);
});

test("downloadAttachment nhận loại file theo byte đầu (CDN Zalo ghi GIF là image/jpeg)", async () => {
    const gifBytes = Buffer.from("GIF89a....");
    const gif = { data: { msgType: "chat.gif", content: { href: "https://zgif-v2.zdn.vn/a.gif" } } };
    const file = await downloadAttachment(gif, fakeFetch(gifBytes, { "content-type": "image/jpeg" }));
    assert.equal(file.content_type, "image/gif");
    assert.equal(file.name, "a.gif");
    // Hình vẽ: tên .jpg nhưng là PNG.
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const doodle = { data: { msgType: "chat.doodle", content: { href: "https://cdn.zalo/d/x.jpg" } } };
    const drawn = await downloadAttachment(doodle, fakeFetch(pngBytes, { "content-type": "image/jpeg" }));
    assert.deepEqual([drawn.content_type, drawn.name], ["image/png", "x.png"]);
    assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(sniffType(Buffer.from("RIFF0000WEBPVP8 ")), "image/webp");
    assert.equal(sniffType(Buffer.from("%PDF-1.4")), null);
});

test("downloadAttachment bỏ qua sticker và từ chối file quá lớn", async () => {
    const sticker = { data: { msgType: "chat.sticker", content: { href: "https://x" } } };
    assert.equal(await downloadAttachment(sticker, fakeFetch("x")), null);
    const big = { data: { msgType: "share.file", content: { title: "big.zip", href: "https://cdn.zalo/big" } } };
    await assert.rejects(
        downloadAttachment(big, fakeFetch("x", { "content-length": String(999 * 1024 * 1024) })),
        (error) => error instanceof FileTooLargeError && error.bytes === 999 * 1024 * 1024,
    );
});

test("tooLargeText nói rõ kích thước, giới hạn và giữ link gốc", () => {
    // Video gửi dạng tệp trong nhóm (26/11/2026): 27919601 byte, vượt 20 MiB.
    const file = {
        data: {
            msgType: "share.file",
            content: { title: "Recording 2026-11-26 123845.mp4", href: "https://file-stal.dlfl.vn/gr/x" },
        },
    };
    assert.equal(
        tooLargeText(file, 27919601, 20 * 1024 * 1024),
        "📎 Recording 2026-11-26 123845.mp4 (26,6 MB)\n" +
            "⚠️ Tệp lớn hơn giới hạn 20 MB nên không lưu được vào hộp thư. " +
            "Mở link bên dưới sớm (link Zalo sẽ hết hạn) hoặc xem trên Zalo.\n" +
            "https://file-stal.dlfl.vn/gr/x",
    );
    const video = { data: { msgType: "chat.video.msg", content: { title: "Bé ăn", href: "ftp://x" } } };
    assert.equal(
        tooLargeText(video, 0, 20 * 1024 * 1024),
        "🎬 Video: Bé ăn\n⚠️ Tệp lớn hơn giới hạn 20 MB nên không lưu được vào hộp thư. Xem trên Zalo.",
    );
    assert.equal(formatBytes(5.5 * 1024 * 1024), "5,5 MB");
    assert.equal(formatBytes(1234567), "1,18 MB");
    assert.equal(formatBytes(0), "");
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
    const vote = {
        data: {
            msgType: "group.poll",
            content: { action: "vote", params: '{"question":"Ăn gì?","dName":"Bình","pollId":42}' },
        },
    };
    assert.equal(describeContent(vote), "📊 Bình bỏ phiếu: Ăn gì?");
    assert.equal(pollIdOf(vote), 42);
    assert.equal(pollIdOf(poll), null);
    assert.equal(pollIdOf({ data: { msgType: "webchat", content: "x" } }), null);
    const detail = {
        options: [
            { content: "Phở", votes: 2, voters: ["7", "9"] },
            { content: "Bún", votes: 0, voters: [] },
        ],
    };
    assert.equal(pollDetailText(detail, "create", "7"), "• Phở\n• Bún");
    assert.equal(pollDetailText(detail, "vote", 7), "Chọn: Phở\nKết quả: Phở (2) · Bún (0)");
    // Ẩn người bỏ phiếu: không biết ai chọn gì, vẫn có kết quả.
    assert.equal(pollDetailText(detail, "vote", "8"), "Kết quả: Phở (2) · Bún (0)");
    assert.equal(pollDetailText({}, "create", "7"), "");
    const place = {
        data: {
            msgType: "chat.location.new",
            content: { title: "Quán", params: '{"latitude":10.77,"longitude":106.7}' },
        },
    };
    assert.equal(describeContent(place), "📍 Vị trí: Quán\nhttps://maps.google.com/?q=10.77,106.7");
    assert.deepEqual(findCoordinates({ params: "not json" }), null);
    assert.equal(describeContent({ data: { msgType: "chat.sticker", content: { id: 1, catId: 2 } } }), "🧩 Sticker");
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
    // Tin có tệp: dùng tóm tắt đã nhớ của tin gốc (theo globalMsgId).
    const quoted = { data: { quote: { msg: "", attach: "{...}", fromD: "An", globalMsgId: 42 } } };
    assert.equal(
        quoteText(quoted, (q) => (q.globalMsgId === 42 ? "Chú thích 🎬 Video" : "")),
        "An: Chú thích 🎬 Video",
    );
    // Trích dẫn 1-1 từ Zalo Web/zca-js: không có attach, vẫn tra tin gốc theo id.
    const bare = { data: { quote: { msg: "", attach: "", fromD: "An", globalMsgId: 7 } } };
    assert.equal(
        quoteText(bare, (q) => (q.globalMsgId === 7 ? "🖼️ Ảnh" : "")),
        "An: 🖼️ Ảnh",
    );
    assert.equal(quoteText(bare), "");
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
    // Thẻ lúc tạo nhắc hẹn: ghi chú kèm người tạo, thay cho tin webchat "… tạo nhắc hẹn mới …".
    assert.equal(systemNoticeText(ecard("An")), "⏰ Họp\n23:43\nNgười tạo: An");
    const created = { data: { msgType: "webchat", content: { title: "An tạo nhắc hẹn mới Họp - 23:43." } } };
    assert.equal(isRedundantNotice(created), true);
    assert.equal(isRedundantNotice({ data: { msgType: "webchat", content: { title: "An tạo ghi chú" } } }), false);
    const english = { data: { msgType: "webchat", content: { title: "An created a new time reminder Họp - 23:43." } } };
    assert.equal(isRedundantNotice(english), true);
    // Nhãn cho ghi chú chủ tài khoản gửi GIF/hình vẽ không chú thích.
    assert.equal(
        summarize({ data: { msgType: "chat.gif", content: { title: "", href: "https://g/a.gif" } } }),
        "🖼️ GIF",
    );
    assert.equal(
        summarize({ data: { msgType: "chat.doodle", content: { title: "", href: "https://d/x.jpg" } } }),
        "✏️ Hình vẽ",
    );
});

test("systemNoticeText: thẻ đã kết bạn là ghi chú, không phải tin khách", () => {
    const card = (description) => ({
        data: { msgType: "chat.ecard", dName: "An", uidFrom: "123", content: { title: "", description } },
    });
    assert.equal(
        systemNoticeText(card("Huỳnh Tính Thành just became your friend")),
        "🤝 Huỳnh Tính Thành đã trở thành bạn bè",
    );
    assert.equal(systemNoticeText(card("Nguyen Van B đã đồng ý kết bạn")), "🤝 Nguyen Van B đã đồng ý kết bạn");
    assert.equal(systemNoticeText(card("Thông báo khác")), "Thông báo khác");
});

test("systemNoticeText nhận ra thông báo hệ thống webchat dạng object", () => {
    const notice = { data: { msgType: "webchat", content: { title: "Bạn vừa kết bạn với An" } } };
    assert.equal(systemNoticeText(notice), "Bạn vừa kết bạn với An");
    assert.equal(systemNoticeText({ data: { msgType: "webchat", content: "chào" } }), null);
    assert.equal(systemNoticeText({ data: { msgType: "chat.photo", content: { title: "x" } } }), null);
});

test("CatchUp chỉ nhận tin cũ mới hơn mốc đã lưu và không lặp tin sống", () => {
    const dir = tempDir();
    const file = path.join(dir, "catchup.json");
    const msg = (msgId, ts, type = 0) => ({ type, data: { msgId, ts: String(ts) } });

    // Lần chạy đầu: chưa có mốc, không xin và không nhận tin cũ.
    const first = new CatchUp(file, { saveDelayMs: 0 });
    assert.equal(first.lastId(0), null);
    assert.equal(first.acceptOld(msg("1", 100)), false);
    assert.equal(first.acceptLive(msg("2", 200)), true);
    assert.equal(first.acceptLive(msg("2", 200)), false);
    assert.equal(first.acceptLive(msg("g1", 150, 1)), true);
    first.flush();

    // Khởi động lại: xin từ mốc, chỉ nhận tin mới hơn, mỗi tin một lần.
    const next = new CatchUp(file, { saveDelayMs: 0 });
    assert.equal(next.lastId(0), "2");
    assert.equal(next.lastId(1), "g1");
    assert.equal(next.acceptOld(msg("2", 200)), false);
    assert.equal(next.acceptOld(msg("3", 300)), true);
    assert.equal(next.acceptOld(msg("3", 300)), false);
    assert.equal(next.acceptLive(msg("3", 300)), false);
    assert.equal(next.acceptOld(msg("g0", 120, 1)), false);
    assert.equal(next.acceptOld(msg("g2", 160, 1)), true);
    next.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
        user: { msgId: "3", ts: 300 },
        group: { msgId: "g2", ts: 160 },
    });
});

test("sự kiện nhóm mới: cài đặt, ảnh, xin vào nhóm, nhắc hẹn", () => {
    const before = { lockCreatePoll: 0, joinAppr: 0, signAdminMsg: 1 };
    const after = { lockCreatePoll: 1, joinAppr: 0, signAdminMsg: 1 };
    assert.deepEqual(groupSettingChanges(before, after), ["Khoá tạo bình chọn: bật"]);
    assert.deepEqual(groupSettingChanges(null, after), []);
    assert.equal(
        groupEventText({ type: "update_setting", data: { groupSetting: after } }, before),
        "Cài đặt nhóm thay đổi:\nKhoá tạo bình chọn: bật",
    );
    assert.equal(groupEventText({ type: "update_setting", data: { groupSetting: after } }), "Cài đặt nhóm thay đổi");
    assert.equal(groupEventText({ type: "update_avatar", data: {} }), "Nhóm đổi ảnh đại diện");
    assert.equal(
        groupEventText({ type: "join_request", data: { uids: ["1", "2"], totalPending: 3 } }),
        "2 người xin vào nhóm (đang chờ duyệt: 3)",
    );
    assert.equal(
        groupEventText({ type: "accept_remind", data: { updateMembers: ["1"] } }),
        "1 người tham gia nhắc hẹn",
    );
    // Đã có tin hệ thống webchat / thẻ nhắc hẹn của Zalo: không ghi chú trùng.
    for (const type of ["new_pin_topic", "update_pin_topic", "update_topic", "remove_board", "remind_topic"]) {
        assert.equal(groupEventText({ type, data: {} }), null, type);
    }
});

test("friendEventInfo: lời mời của khách thành tin, còn lại thành ghi chú", () => {
    const me = "100";
    assert.deepEqual(
        friendEventInfo(
            {
                type: FriendEventType.REQUEST,
                threadId: me,
                data: { fromUid: "7", toUid: me, message: " Xin chào shop " },
            },
            me,
        ),
        {
            threadId: "7",
            kind: "request",
            text: "🤝 Lời mời kết bạn\n«Xin chào shop»",
        },
    );
    assert.deepEqual(
        friendEventInfo(
            { type: FriendEventType.REQUEST, threadId: "7", data: { fromUid: me, toUid: "7", message: "" } },
            me,
        ),
        {
            threadId: "7",
            kind: "note",
            text: "Chủ tài khoản đã gửi lời mời kết bạn",
        },
    );
    assert.equal(
        friendEventInfo({ type: FriendEventType.UNDO_REQUEST, threadId: me, data: { fromUid: "7", toUid: me } }, me)
            .threadId,
        "7",
    );
    assert.equal(friendEventInfo({ type: FriendEventType.ADD, threadId: "7", data: "7" }, me), null);
    assert.equal(friendEventInfo({ type: FriendEventType.SEEN_FRIEND_REQUEST, threadId: me, data: [] }, me), null);
});

test("tin cũ bị thu hồi chuyển thành sự kiện undo", () => {
    const old = {
        type: ThreadType.Group,
        threadId: "g1",
        isSelf: false,
        data: { msgType: "chat.undo", msgId: "9", content: { deleteMsg: 0, cliMsgId: "c1", globalMsgId: "g9" } },
    };
    assert.equal(isRecall(old), true);
    assert.equal(isRecall({ data: { content: "hi" } }), false);
    assert.deepEqual(recallOf(old), { data: old.data, threadId: "g1", isSelf: false, isGroup: true });
});

test("LoginSession theo dõi các bước đăng nhập QR", () => {
    const session = new LoginSession("shop");
    let retried = 0;
    const actions = { retry: () => retried++, abort: () => {} };
    session.onEvent({ type: LoginQRCallbackEventType.QRCodeGenerated, data: { image: "AAA" }, actions });
    assert.equal(session.toJSON().status, "qr");
    assert.equal(session.toJSON().qr, "data:image/png;base64,AAA");
    session.onEvent({ type: LoginQRCallbackEventType.QRCodeExpired, actions });
    assert.equal(retried, 1);
    session.onEvent({ type: LoginQRCallbackEventType.QRCodeScanned, actions });
    assert.equal(session.status, "scanned");
    session.set("success", "ok");
    assert.equal(session.toJSON().qr, null);
});

test("accountRoutes: danh sách, đăng nhập QR lưu credentials rồi chạy tài khoản", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zalo-acc-"));
    process.env.ZALO_ACCOUNTS_DIR = dir;
    const calls = [];
    const manager = {
        list: () => [{ name: "shop", state: "running", profile: null }],
        stop: async (name) => calls.push(["stop", name]),
        restart: async (name) => calls.push(["restart", name]),
    };
    const fakeZalo = () => ({
        loginQR: async (_opts, cb) => {
            cb({ type: LoginQRCallbackEventType.QRCodeGenerated, data: { image: "QR" }, actions: {} });
            return {
                getContext: () => ({
                    cookie: { toJSON: () => ({ cookies: [{ key: "a" }] }) },
                    imei: "i",
                    userAgent: "u",
                }),
            };
        },
    });
    const handle = accountRoutes(manager, { createZalo: fakeZalo, accountsDir: dir });
    const call = async (method, url) => {
        const res = {
            status: 0,
            body: "",
            writeHead(status) {
                this.status = status;
            },
            end(body = "") {
                this.body = body;
            },
        };
        const handled = await handle({ method, url }, res, (r, status, body) => r.writeHead(status) || r.end(body));
        return { handled, ...res };
    };
    assert.equal((await call("GET", "/send")).handled, false);
    assert.equal(JSON.parse((await call("GET", "/accounts")).body)[0].name, "shop");
    assert.equal((await call("POST", "/accounts/..%2Fetc/login")).status, 400);
    assert.equal((await call("POST", "/accounts/new1/login")).status, 202);
    await new Promise((r) => setTimeout(r, 20));
    const status = JSON.parse((await call("GET", "/accounts/new1/login")).body);
    assert.equal(status.status, "success");
    assert.ok(readCredentials(path.join(dir, "new1", "credentials.json")));
    assert.deepEqual(calls, [["restart", "new1"]]);
    assert.equal((await call("DELETE", "/accounts/new1")).status, 204);
    assert.equal(fs.existsSync(path.join(dir, "new1")), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("describeAccountError: hết phiên cần quét QR lại, còn lại là lỗi kết nối", () => {
    const expired = describeAccountError(sessionExpired(new Error("bị từ chối")));
    assert.equal(expired.kind, "session_expired");
    assert.ok(expired.message.startsWith(`${SESSION_EXPIRED_MESSAGE} Nguyên nhân: `));
    const rejected = Object.assign(sessionExpired(new Error("x")), { sessionCause: "Zalo từ chối đăng nhập (mã 2)" });
    assert.match(describeAccountError(rejected).message, /Nguyên nhân: Zalo từ chối đăng nhập \(mã 2\)$/);
    assert.deepEqual(describeAccountError(new Error("fetch failed")), {
        kind: "connection",
        message: "Lỗi kết nối: fetch failed",
    });
    assert.equal(describeAccountError(new Error("x".repeat(500))).message.length, 200);
});

test("sendContent: trích dẫn tin gốc khi nhân viên trả lời trích dẫn", () => {
    const quote = { msgId: "9", cliMsgId: "c9", content: "giá?" };
    assert.deepEqual(sendContent("Dạ 5 triệu", [], quote), { msg: "Dạ 5 triệu", quote });
    assert.equal(sendContent("Dạ", [], undefined), "Dạ");
    const files = [{ filename: "a.jpg" }];
    assert.deepEqual(sendContent("Ảnh", files, quote), { msg: "Ảnh", attachments: files });
});

test("forwardTyping/forwardSeen: bỏ qua tin của mình, chặn gửi dồn", async () => {
    const posted = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        posted.push(JSON.parse(init.body));
        return { ok: true };
    };
    try {
        await forwardTyping("shop", { threadId: "u1", isSelf: false }, 10_000);
        await forwardTyping("shop", { threadId: "u1", isSelf: false }, 11_000); // trong 3 giây: bỏ
        await forwardTyping("shop", { threadId: "u1", isSelf: true }, 20_000);
        await forwardSeen("shop", [
            { threadId: "u1", isSelf: false, data: { msgId: "77", realMsgId: "0" } },
            { threadId: "g1", isSelf: true, data: { msgId: "88" } },
        ]);
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.deepEqual(
        posted.map((p) => [p.kind, p.thread_id, p.message_ids]),
        [
            ["typing", "u1", []],
            ["read", "u1", ["77", "0"]],
        ],
    );
});

test("normalizePhone: số Việt Nam về dạng 84...", () => {
    assert.equal(normalizePhone("0901 234.567"), "84901234567");
    assert.equal(normalizePhone("+84901234567"), "84901234567");
    assert.equal(normalizePhone("84901234567"), "84901234567");
    assert.equal(normalizePhone("abc"), null);
    assert.equal(normalizePhone("123"), null);
});

test("retryDelay: mất mạng thử mãi (tối đa 2 phút), hết phiên dừng sau 2 lần", () => {
    const offline = new Error("fetch failed");
    assert.equal(retryDelay(offline, 1), 30_000);
    assert.equal(retryDelay(offline, 3), 120_000);
    assert.equal(retryDelay(offline, 50), 120_000); // không bao giờ null
    const expired = sessionExpired(new Error("bị từ chối"));
    assert.equal(retryDelay(expired, 1), 30_000);
    assert.equal(retryDelay(expired, 2), null);
});

test("watchSocket: cắt kết nối khi im lặng quá lâu, giữ nguyên khi còn nhận frame", async () => {
    const { EventEmitter } = await import("node:events");
    const fakeSocket = () => {
        const ws = new EventEmitter();
        ws.readyState = 1;
        ws.terminated = false;
        ws.terminate = () => {
            ws.terminated = true;
            ws.readyState = 3;
        };
        return ws;
    };
    let clock = 0;
    const now = () => clock;
    const alive = fakeSocket();
    const dead = fakeSocket();
    let deadReported = 0;
    const gaps = [];
    const stopAlive = watchSocket(alive, { staleMs: 100, checkMs: 5, now, onGap: (ms) => gaps.push(ms) });
    watchSocket(dead, { staleMs: 100, checkMs: 5, now, onDead: () => deadReported++ });
    for (let i = 0; i < 6; i++) {
        clock += 60;
        alive.emit("message", "frame");
        await new Promise((r) => setTimeout(r, 15));
    }
    stopAlive();
    assert.equal(alive.terminated, false);
    assert.equal(dead.terminated, true);
    assert.equal(deadReported, 1);
    assert.ok(gaps.length > 0 && Math.max(...gaps) === 60);
    assert.doesNotThrow(() => watchSocket(null, { staleMs: 1 })()); // socket chưa có: bỏ qua
    assert.doesNotThrow(() => watchSocket(alive, { staleMs: 0 })()); // tắt: không theo dõi
});

test("splitVoices: audio thành tin thoại, tệp khác gửi kèm", () => {
    const b64 = Buffer.from("x").toString("base64");
    const { voices, files } = splitVoices([
        { name: "ghi-am.m4a", content_type: "audio/mp4", data: b64 },
        { name: "anh.jpg", content_type: "image/jpeg", data: b64 },
        { name: "rong.pdf", content_type: "application/pdf", data: "" },
    ]);
    assert.deepEqual(
        voices.map((v) => v.filename),
        ["ghi-am.m4a"],
    );
    assert.deepEqual(
        files.map((f) => f.filename),
        ["anh.jpg"],
    );
});

test("reactionText và summarize: tên người gửi tin, nhãn tệp gọn, tin cũ", () => {
    const photo = { data: { msgType: "chat.photo", content: { title: "", href: "https://photo-stal.zdn.vn/x.jpg" } } };
    const file = {
        data: { msgType: "share.file", content: { title: "kq-sinh-hoa.pdf", href: "https://file-stal.dlfl.vn/x" } },
    };
    const video = { data: { msgType: "chat.video.msg", content: { title: "", href: "https://video-stal.dlmd.me/x" } } };
    assert.equal(summarize(photo), "🖼️ Ảnh");
    assert.equal(summarize(file), "📎 kq-sinh-hoa.pdf");
    assert.equal(summarize(video), "🎬 Video");
    assert.equal(summarize({ data: { content: "chào" } }), "chào");
    const target = { summary: "📎 kq-sinh-hoa.pdf", sender: "Đỗ Hường" };
    assert.equal(reactionText("/-heart", target, true), "❤️ vào tin của Đỗ Hường «📎 kq-sinh-hoa.pdf»");
    assert.equal(reactionText("/-heart", target, false), "❤️ vào tin «📎 kq-sinh-hoa.pdf»");
    assert.equal(reactionText("", target, false), "Bỏ cảm xúc vào tin «📎 kq-sinh-hoa.pdf»");
    assert.match(reactionText(":>", undefined, true), /^😆 vào một tin cũ/);
});

test("RecentMessages: entries/restore giữ thứ tự và bỏ dữ liệu hỏng", () => {
    const a = new RecentMessages(3);
    a.remember(["k1", "k2"], { summary: "x" });
    a.remember(["k3"], { summary: "y" });
    const b = new RecentMessages(3);
    b.restore(JSON.parse(JSON.stringify(a.entries())));
    b.restore("hỏng");
    b.restore([null, [1, 2]]);
    assert.deepEqual(b.entries(), a.entries());
});

test("ConnectionHistory: gộp mốc trùng, lưu file 0600, đọc lại sau khởi động", () => {
    const file = path.join(tempDir(), "acc", "history.json");
    let t = Date.parse("2026-10-20T10:00:00Z");
    const now = () => new Date(t);
    const h = new ConnectionHistory(file, now);
    h.record("connected", "Đã kết nối");
    t += 60_000;
    h.record("network", "mất mạng");
    t += 60_000;
    h.record("network", "mất mạng");
    const again = new ConnectionHistory(file).list();
    assert.deepEqual(
        again.map((i) => i.kind),
        ["network", "connected"],
    );
    assert.equal(again[0].count, 2);
    assert.equal(again[0].last_at, "2026-10-20T10:02:00Z");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, "{hỏng");
    assert.deepEqual(new ConnectionHistory(file).list(), []);
});

test("closeCause: phân loại mã đóng WebSocket của Zalo", () => {
    assert.equal(closeCause(1006).kind, "network");
    assert.match(closeCause(3000).message, /kết nối trùng/);
    assert.equal(closeCause(3003).kind, "platform");
    assert.match(closeCause(4001).message, /mã 4001/);
});

test("reactionIcon: emoji nhân viên chọn thành mã Zalo, bỏ qua biến thể FE0F", () => {
    assert.equal(reactionIcon("❤️"), "/-heart");
    assert.equal(reactionIcon("❤"), "/-heart");
    assert.equal(reactionIcon("👍"), "/-strong");
    assert.equal(reactionIcon("😆"), ":>");
    assert.equal(reactionIcon("😡"), ":-h");
    assert.equal(reactionIcon(""), "");
    assert.equal(reactionIcon("🦄"), null);
    assert.equal(reactionIcon(null), null);
});

test("voipSummary prints ids and key names but never relay addresses or sessions", () => {
    const line = voipSummary({
        act: "request",
        act_type: "voip",
        data: {
            callId: 464564007,
            callerId: "123",
            callType: 1,
            rtpAddress: "171.244.128.51:4200",
            session: "sess_secret",
            extendData: { serverAddr: "10.0.0.1" },
        },
    });
    assert.match(line, /^act=request /);
    assert.match(line, /callId=464564007/);
    assert.match(line, /callerId=123/);
    assert.match(line, /data\(object\)=\[callId,callType,callerId,extendData,rtpAddress,session\]/);
    assert.doesNotMatch(line, /171\.244|sess_secret|10\.0\.0\.1/);
});

test("voipSummary tolerates unparsed and missing data", () => {
    assert.equal(
        voipSummary({ act: "x", act_type: "voip", data: "not json" }),
        "act=x keys=[act,act_type,data] data(string)=[]",
    );
    assert.equal(voipSummary(null), "act=? keys=[] data(undefined)=[]");
});

test("call accounts come from the gateway, are cached and survive a gateway outage", async () => {
    let clock = 0;
    let calls = 0;
    let answer = { ok: true, json: async () => ({ zalo_accounts: ["acc2", "shop1"] }) };
    const fetchImpl = async (url, options) => {
        calls++;
        assert.equal(url, "http://gateway:8080/v1/calls/accounts");
        assert.equal(options.headers.authorization, "Bearer t");
        if (answer instanceof Error) throw answer;
        return answer;
    };
    const allowed = createCallAccounts({ url: "http://gateway:8080/", token: "t", fetchImpl, now: () => clock });
    assert.deepEqual([...(await allowed())], ["acc2", "shop1"]);
    clock += 10_000;
    await allowed();
    assert.equal(calls, 1, "cached for 30 s");
    clock += 30_000;
    answer = new Error("down");
    assert.deepEqual([...(await allowed())], ["acc2", "shop1"], "keeps the last list");
    answer = { ok: true, json: async () => ({ zalo_accounts: [] }) };
    assert.equal((await allowed()).size, 0, "turned off in the UI");
    const never = createCallAccounts({ url: "", fetchImpl });
    assert.equal((await never()).size, 0, "off without a gateway");
});

test("validateSignal only lets allowlisted accounts reach known voicecall paths", () => {
    const allowed = new Set(["acc2"]);
    assert.equal(validateSignal({ account: "default", path: "cancel", params: {} }, allowed).status, 403);
    assert.equal(validateSignal({ account: "acc2", path: "../message/send", params: {} }, allowed).status, 400);
    assert.equal(
        validateSignal({ account: "acc2", path: "requestcall", params: {} }, allowed).error,
        "missing calleeId",
    );
    assert.equal(validateSignal({ account: "acc2", path: "cancel", params: [] }, allowed).status, 400);
    assert.deepEqual(
        validateSignal(
            { account: "acc2", path: "requestcall", params: { calleeId: "1", callId: 7 }, with_imei: true },
            allowed,
        ),
        { path: "requestcall", params: { calleeId: "1", callId: 7 }, withImei: true },
    );
    assert.ok(CALL_PATHS.has("endcall"));
});

test("ensureVoicecallApi signs params with the session and calls the voice_call host", async () => {
    const calls = [];
    const api = {
        zpwServiceMap: { voice_call: ["https://voicecall-wpa.chat.zalo.me/"] },
        custom(name, callback) {
            const ctx = { imei: "imei-1" };
            const utils = {
                encodeAES: (text) => `enc(${text})`,
                makeURL: (base, params) => `${base}?params=${params.params}`,
                request: async (url, options) => {
                    calls.push({ url, options });
                    return "response";
                },
                resolve: async (res) => ({ resolved: res }),
            };
            Object.defineProperty(this, name, { value: (props) => callback({ ctx, utils, props }) });
        },
    };
    const signal = ensureVoicecallApi(api);
    assert.equal(ensureVoicecallApi(api), signal, "registers once");
    const data = await signal({ path: "requestcall", params: { calleeId: "9" }, withImei: true });
    assert.deepEqual(data, { resolved: "response" });
    assert.equal(
        calls[0].url,
        'https://voicecall-wpa.chat.zalo.me/api/voicecall/requestcall?params=enc({"calleeId":"9","imei":"imei-1"})',
    );
    assert.equal(calls[0].options.method, "GET");
});

test("forwardVoip only sends allowlisted accounts to zalo-call", async () => {
    const sent = [];
    const fetchImpl = async (url, options) => {
        sent.push({ url, options });
        return { ok: true };
    };
    const opts = {
        url: "http://zalo-call:7009/call/event",
        token: "t",
        allowed: async () => new Set(["acc2"]),
        fetchImpl,
    };
    const control = { act: "answer", act_type: "voip", data: { callId: 1 } };
    assert.equal(await forwardVoip("default", control, opts), false);
    assert.equal(await forwardVoip("acc2", control, { ...opts, url: "" }), false);
    assert.equal(sent.length, 0);
    assert.equal(await forwardVoip("acc2", control, opts), true);
    assert.equal(sent[0].options.headers.authorization, "Bearer t");
    assert.deepEqual(JSON.parse(sent[0].options.body), { account: "acc2", control });
    const failing = async () => {
        throw new Error("down");
    };
    assert.equal(await forwardVoip("acc2", control, { ...opts, fetchImpl: failing }), false);
});

test("ZALO_TRACE chỉ ghi tài khoản được chọn, file 0600, dừng ở giới hạn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ztrace-"));
    assert.deepEqual([...traceAccounts(" shop1, ,acc2 ")], ["shop1", "acc2"]);
    assert.equal(openTrace("default", traceAccounts("shop1"), dir), null);
    const trace = openTrace("shop1", traceAccounts("shop1"), dir);
    assert.equal(openTrace("shop1", traceAccounts("shop1"), dir), trace);
    trace.write("message", { data: { msgType: "chat.gif" } });
    const file = path.join(dir, "shop1.jsonl");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const row = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert.equal(row.kind, "message");
    assert.equal(row.payload.data.msgType, "chat.gif");
    const small = new EventTrace(path.join(dir, "cap.jsonl"), 10);
    small.write("message", { big: "x".repeat(50) });
    small.write("message", { more: 1 });
    assert.equal(fs.readFileSync(path.join(dir, "cap.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
});

test("RecentMessages.forget bỏ đúng khoá của một tài khoản", () => {
    const r = new RecentMessages(10);
    r.remember(["acc2:1", "acc2:2"], { summary: "của acc2" });
    r.remember(["shop1:1"], { summary: "của shop1" });
    assert.equal(r.forget("acc2:"), 2);
    assert.equal(r.get("acc2:1"), undefined);
    assert.equal(r.get("shop1:1").summary, "của shop1");
});

test("forgetAccount xoá tin của tài khoản đã gỡ khỏi recent-messages.json, giữ tài khoản khác", () => {
    const dir = tempDir();
    const file = path.join(dir, "recent-messages.json");
    writePrivateJson(file, [
        ["acc2:11", { summary: "tin của acc2", sender: "Khách" }],
        ["shop1:22", { summary: "tin của shop1", sender: "Khách" }],
    ]);
    restoreRecent(file);
    forgetAccount("acc2", file);
    const saved = fs.readFileSync(file, "utf8");
    assert.ok(!saved.includes("tin của acc2"));
    assert.ok(saved.includes("tin của shop1"));
    fs.rmSync(dir, { recursive: true, force: true });
});

test("removeTrace đóng và xoá file trace của tài khoản", () => {
    const dir = tempDir();
    const trace = openTrace("acc2", new Set(["acc2"]), dir);
    trace.write("message", { text: "x" });
    removeTrace("acc2", dir);
    assert.equal(fs.existsSync(path.join(dir, "acc2.jsonl")), false);
    trace.write("message", { text: "sau khi gỡ" }); // không lỗi, không ghi
    assert.equal(fs.existsSync(path.join(dir, "acc2.jsonl")), false);
    removeTrace("chua-co", dir); // không có file: không lỗi
    fs.rmSync(dir, { recursive: true, force: true });
});

test("accountRoutes: gỡ tài khoản quên luôn dữ liệu ngoài thư mục của nó", async () => {
    const dir = tempDir();
    const calls = [];
    const manager = {
        list: () => [],
        stop: async (name) => calls.push(["stop", name]),
        restart: async (name) => calls.push(["restart", name]),
        forget: async (name) => calls.push(["forget", name]),
    };
    const handle = accountRoutes(manager, { accountsDir: dir });
    fs.mkdirSync(path.join(dir, "acc2"));
    const res = {
        status: 0,
        writeHead(s) {
            this.status = s;
        },
        end() {},
    };
    await handle({ method: "DELETE", url: "/accounts/acc2" }, res, () => {});
    assert.equal(res.status, 204);
    assert.deepEqual(calls, [
        ["stop", "acc2"],
        ["forget", "acc2"],
    ]);
    assert.equal(fs.existsSync(path.join(dir, "acc2")), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("accountRoutes: QR quét xong sau khi tài khoản đã gỡ thì không lưu, không chạy lại", async () => {
    const dir = tempDir();
    const calls = [];
    const manager = {
        list: () => [],
        stop: async (name) => calls.push(["stop", name]),
        restart: async (name) => calls.push(["restart", name]),
    };
    let scanned;
    const fakeZalo = () => ({
        // Chưa phát "QR generated" nên phiên chưa có abort: gỡ không huỷ được phía zca-js.
        loginQR: () =>
            new Promise((resolve) => {
                scanned = () =>
                    resolve({
                        getContext: () => ({
                            cookie: { toJSON: () => ({ cookies: [{ key: "a" }] }) },
                            imei: "i",
                            userAgent: "u",
                        }),
                    });
            }),
    });
    const handle = accountRoutes(manager, { createZalo: fakeZalo, accountsDir: dir });
    const res = () => ({
        status: 0,
        writeHead(s) {
            this.status = s;
        },
        end() {},
    });
    await handle({ method: "POST", url: "/accounts/acc2/login" }, res(), () => {});
    await handle({ method: "DELETE", url: "/accounts/acc2" }, res(), () => {});
    scanned();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.existsSync(path.join(dir, "acc2", "credentials.json")), false);
    assert.deepEqual(calls, [["stop", "acc2"]]);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("BOT_ACCOUNT: chỉ tìm thấy đúng tài khoản của container, tên sai thì không chạy", () => {
    const dir = tempDir();
    for (const name of ["vetgo-uat.acc2", "vetgo-uat.shop1"]) {
        writePrivateJson(path.join(dir, name, "credentials.json"), credentials);
    }
    assert.deepEqual(
        discoverAccounts(dir, "vetgo-uat.acc2").map((a) => a.name),
        ["vetgo-uat.acc2"],
    );
    assert.equal(discoverAccounts(dir, "").length, 2);
    assert.equal(onlyAccount(" vetgo-uat.acc2 "), "vetgo-uat.acc2");
    assert.equal(onlyAccount(""), "");
    assert.throws(() => onlyAccount("../etc"));
    fs.rmSync(dir, { recursive: true, force: true });
});

test("accountRoutes một tài khoản: tài khoản khác không đăng nhập, không gỡ được, không hiện", async () => {
    const dir = tempDir();
    const calls = [];
    const manager = {
        list: () => [
            { name: "a.acc2", state: "running" },
            { name: "a.shop1", state: "running" },
        ],
        stop: async (name) => calls.push(["stop", name]),
        restart: async (name) => calls.push(["restart", name]),
    };
    const handle = accountRoutes(manager, { accountsDir: dir, only: "a.acc2" });
    const call = async (method, url) => {
        const res = {
            status: 0,
            body: "",
            writeHead(s) {
                this.status = s;
            },
            end(b = "") {
                this.body = b;
            },
        };
        await handle({ method, url }, res, (r, status, body) => r.writeHead(status) || r.end(body));
        return res;
    };
    assert.deepEqual(
        JSON.parse((await call("GET", "/accounts")).body).map((a) => a.name),
        ["a.acc2"],
    );
    assert.equal((await call("POST", "/accounts/a.shop1/login")).status, 404);
    assert.equal((await call("DELETE", "/accounts/a.shop1")).status, 404);
    assert.equal((await call("POST", "/accounts/a.shop1/restart")).status, 404);
    assert.deepEqual(calls, []);
    fs.rmSync(dir, { recursive: true, force: true });
});

test("watchdogStaleMs: mặc định 6 phút, 0 thì tắt, OBSERVE chỉ đo", () => {
    assert.equal(DEFAULT_WATCHDOG_STALE_MS, 360_000);
    assert.equal(watchdogStaleMs({}), 360_000);
    assert.equal(watchdogStaleMs({ ZALO_WATCHDOG_STALE_MS: "" }), 360_000);
    assert.equal(watchdogStaleMs({ ZALO_WATCHDOG_STALE_MS: "0" }), 0);
    assert.equal(watchdogStaleMs({ ZALO_WATCHDOG_STALE_MS: "90000" }), 90_000);
    assert.equal(watchdogStaleMs({ ZALO_WATCHDOG_STALE_MS: "abc" }), 360_000);
    assert.equal(watchdogStaleMs({ ZALO_WATCHDOG_STALE_MS: "0", ZALO_WATCHDOG_OBSERVE: "1" }), Infinity);
});

test("acceptFriend chấp nhận lời mời bằng phiên của bot, kiểm tra uid", async () => {
    const calls = [];
    const api = { acceptFriendRequest: async (id) => calls.push(id) };
    assert.deepEqual(await acceptFriend(api, " 6189264738021234567 "), { status: 200, message: "accepted" });
    assert.deepEqual(calls, ["6189264738021234567"]);
    assert.equal((await acceptFriend(api, "abc")).status, 400);
    assert.equal((await acceptFriend(api, "")).status, 400);
    const failing = {
        acceptFriendRequest: async () => {
            throw new Error("network down");
        },
    };
    assert.equal((await acceptFriend(failing, "123456")).status, 502);
});

function mp4Box(kind, body) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(kind, 4, "latin1");
    return Buffer.concat([head, body]);
}

test("mp4Info đọc thời lượng (mvhd) và kích thước video (tkhd), bỏ track âm thanh", () => {
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(1000, 12); // timescale
    mvhd.writeUInt32BE(8500, 16); // 8,5 giây
    const tkhd = (w, h) => {
        const body = Buffer.alloc(84);
        body.writeUInt32BE(w << 16, 76);
        body.writeUInt32BE(h << 16, 80);
        return mp4Box("tkhd", body);
    };
    const moov = mp4Box(
        "moov",
        Buffer.concat([mp4Box("mvhd", mvhd), mp4Box("trak", tkhd(0, 0)), mp4Box("trak", tkhd(720, 1280))]),
    );
    const file = Buffer.concat([mp4Box("ftyp", Buffer.from("isom0000")), moov]);
    assert.deepEqual(mp4Info(file), { duration: 8500, width: 720, height: 1280 });
    assert.deepEqual(mp4Info(Buffer.from("not an mp4 at all")), {});
});

test("solidPng tạo PNG hợp lệ đúng kích thước; splitVoices tách video mp4", () => {
    const png = solidPng(320, 180, [32, 32, 32]);
    assert.deepEqual(imageSize(png), { width: 320, height: 180 });
    const b64 = (s) => Buffer.from(s).toString("base64");
    const { voices, videos, files } = splitVoices([
        { name: "a.m4a", content_type: "audio/mp4", data: b64("A") },
        { name: "v.mp4", content_type: "video/mp4", data: b64("V") },
        { name: "x.pdf", content_type: "application/pdf", data: b64("P") },
        { name: "rong.mp4", content_type: "video/mp4", data: "" },
    ]);
    assert.deepEqual([voices.length, videos.length, files.length], [1, 1, 1]);
    assert.equal(videos[0].filename, "v.mp4");
});

/** api giả cho /friend/request: mỗi hàm là kết quả hoặc lỗi cần ném. */
function fakeFriendApi({ user, state, find, send, accept } = {}) {
    const calls = [];
    const run = (value) => {
        if (value instanceof Error) throw value;
        return value;
    };
    return {
        calls,
        findUser: async (phone) => {
            calls.push(["findUser", phone]);
            return find ? run(find) : user;
        },
        getFriendRequestStatus: async (uid) => {
            calls.push(["status", uid]);
            return run(state ?? { is_friend: 0, is_requested: 0, is_requesting: 0 });
        },
        acceptFriendRequest: async (uid) => {
            calls.push(["accept", uid]);
            return run(accept ?? "");
        },
        sendFriendRequest: async (msg, uid) => {
            calls.push(["send", msg, uid]);
            return run(send ?? "");
        },
    };
}

const zaloUser = {
    uid: "111222333",
    globalId: "G123",
    display_name: "Khách A",
    zalo_name: "A",
    avatar: "https://a/x.jpg",
};
const zaloInfo = { uid: "111222333", global_id: "G123", name: "Khách A", avatar: "https://a/x.jpg" };

test("requestFriend: số sai dạng hoặc mã 219 là invalid_phone (422)", async () => {
    const api = fakeFriendApi({ user: zaloUser });
    assert.deepEqual((await requestFriend(api, { phone: "abc" })).status, 422);
    assert.equal(api.calls.length, 0); // không gọi Zalo khi số sai dạng
    const bad = fakeFriendApi({ find: new ZaloApiError("Số điện thoại không hợp lệ", 219) });
    assert.deepEqual(await requestFriend(bad, { phone: "0901234567" }), {
        status: 422,
        body: { status: "invalid_phone", code: 219, error: "Số điện thoại không hợp lệ." },
    });
});

test("requestFriend: tự đổi số về 84... trước findUser, không phụ thuộc ngôn ngữ phiên", async () => {
    const api = fakeFriendApi({ user: zaloUser, state: { is_friend: 1 } });
    await requestFriend(api, { phone: "0901 234.567" });
    assert.deepEqual(api.calls[0], ["findUser", "84901234567"]);
});

test("requestFriend: không có uid (zca-js nuốt mã 216) là not_found (404)", async () => {
    for (const user of [undefined, null, {}, { uid: "" }]) {
        const res = await requestFriend(fakeFriendApi({ user }), { phone: "0901234567" });
        assert.equal(res.status, 404);
        assert.equal(res.body.status, "not_found");
    }
});

test("requestFriend: lỗi khác của findUser là 502 giữ mã thô; lỗi mạng mã null", async () => {
    const res = await requestFriend(fakeFriendApi({ find: new ZaloApiError("quá giới hạn", 221) }), {
        phone: "0901234567",
    });
    assert.deepEqual(res, { status: 502, body: { status: "error", code: 221, error: "quá giới hạn" } });
    const net = await requestFriend(fakeFriendApi({ find: new Error("fetch failed") }), { phone: "0901234567" });
    assert.deepEqual(net, { status: 502, body: { status: "error", code: null, error: "fetch failed" } });
});

test("requestFriend: theo getFriendRequestStatus (bạn, đã mời, khách mời mình)", async () => {
    const friend = fakeFriendApi({ user: zaloUser, state: { is_friend: 1, is_requested: 0, is_requesting: 0 } });
    assert.deepEqual(await requestFriend(friend, { phone: "0901234567" }), {
        status: 200,
        body: { status: "friend", ...zaloInfo },
    });
    assert.ok(!friend.calls.some(([name]) => name === "send"));

    const requested = fakeFriendApi({ user: zaloUser, state: { is_friend: 0, is_requested: 1, is_requesting: 0 } });
    assert.deepEqual((await requestFriend(requested, { phone: "0901234567" })).body.status, "sent");
    assert.ok(!requested.calls.some(([name]) => name === "send"));

    const requesting = fakeFriendApi({ user: zaloUser, state: { is_friend: 0, is_requested: 0, is_requesting: 1 } });
    const res = await requestFriend(requesting, { phone: "0901234567" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "friend");
    assert.deepEqual(requesting.calls.at(-1), ["accept", "111222333"]);

    const acceptFails = fakeFriendApi({
        user: zaloUser,
        state: { is_requesting: 1 },
        accept: new ZaloApiError("lỗi", 500),
    });
    assert.deepEqual((await requestFriend(acceptFails, { phone: "0901234567" })).body.code, 500);
});

test("requestFriend: gửi lời mời và ánh xạ mã 225, 222, 215, mã khác", async () => {
    const api = fakeFriendApi({ user: zaloUser });
    assert.deepEqual(await requestFriend(api, { phone: "+84901234567", message: "Chào bạn" }), {
        status: 200,
        body: { status: "sent", ...zaloInfo },
    });
    assert.deepEqual(api.calls.at(-1), ["send", "Chào bạn", "111222333"]);

    for (const code of [225, 222]) {
        const res = await requestFriend(fakeFriendApi({ user: zaloUser, send: new ZaloApiError("x", code) }), {
            phone: "0901234567",
        });
        assert.deepEqual(res, { status: 200, body: { status: "friend", ...zaloInfo } });
    }
    const blocked = await requestFriend(fakeFriendApi({ user: zaloUser, send: new ZaloApiError("chặn", 215) }), {
        phone: "0901234567",
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.status, "blocked");
    assert.equal(blocked.body.code, 215);

    const other = await requestFriend(fakeFriendApi({ user: zaloUser, send: new ZaloApiError("lạ", 223) }), {
        phone: "0901234567",
    });
    assert.deepEqual(other, { status: 502, body: { status: "error", code: 223, error: "lạ" } });
    const net = await requestFriend(fakeFriendApi({ user: zaloUser, state: new Error("timeout") }), {
        phone: "0901234567",
    });
    assert.deepEqual(net, { status: 502, body: { status: "error", code: null, error: "timeout" } });
});

test("createUserReminder: nhắc hẹn 1-1, kiểm tra đầu vào, giữ mã lỗi Zalo", async () => {
    const calls = [];
    const api = {
        createReminder: async (options, threadId, type) => {
            calls.push([options, threadId, type]);
            return { reminderId: "R1", toUid: threadId };
        },
    };
    const payload = { thread_id: "111222333", title: "Lịch tái khám", start_time: 1_764_000_000_000 };
    assert.deepEqual(await createUserReminder(api, payload), { status: 200, body: { reminder_id: "R1" } });
    assert.deepEqual(calls[0], [
        { title: "Lịch tái khám", startTime: 1_764_000_000_000 },
        "111222333",
        ThreadType.User,
    ]);
    await createUserReminder(api, { ...payload, emoji: "🐶" });
    assert.equal(calls[1][0].emoji, "🐶");

    assert.equal((await createUserReminder(api, { ...payload, thread_id: "abc" })).status, 400);
    assert.equal((await createUserReminder(api, { ...payload, title: " " })).status, 400);
    assert.equal((await createUserReminder(api, { ...payload, start_time: "1764000000000" })).status, 400);
    assert.equal((await createUserReminder(api, { ...payload, start_time: 0 })).status, 400);
    assert.equal(calls.length, 2);

    const failing = { createReminder: async () => Promise.reject(new ZaloApiError("không được", 114)) };
    assert.deepEqual(await createUserReminder(failing, payload), {
        status: 502,
        body: { code: 114, error: "không được" },
    });
    const net = { createReminder: async () => Promise.reject(new Error("fetch failed")) };
    assert.deepEqual(await createUserReminder(net, payload), {
        status: 502,
        body: { code: null, error: "fetch failed" },
    });
    const empty = { createReminder: async () => ({}) };
    assert.equal((await createUserReminder(empty, payload)).status, 502);
});

test("sendFailure: Zalo refusal keeps Zalo's Vietnamese reason and code (422); other errors are temporary (502)", () => {
    const refused = sendFailure(
        new ZaloApiError(
            "Bạn chưa thể gửi tin nhắn đến người này vì người này chặn không nhận tin nhắn từ người lạ.",
            114,
        ),
    );
    assert.equal(refused.status, 422);
    assert.equal(refused.body.code, 114);
    assert.match(refused.body.error, /^Zalo từ chối: Bạn chưa thể gửi tin nhắn.*\(mã 114\)\.$/);
    const temp = sendFailure(new Error("socket hang up"));
    assert.equal(temp.status, 502);
    assert.equal(temp.body.error, "Không gửi được qua Zalo: socket hang up.");
    assert.equal(sendFailure(new ZaloApiError("", 7)).body.error, "Zalo từ chối: không rõ lý do (mã 7).");
});
