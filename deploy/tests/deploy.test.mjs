// Chạy trong image (cần dist/): xem deploy/README.md, mục Test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LoginQRCallbackEventType } from "../../dist/apis/loginQR.js";
import { FriendEventType, ThreadType } from "../../dist/index.js";

import { discoverAccounts, isValidCredentials, readCredentials, writePrivateJson } from "../common.mjs";
import {
    findCoordinates,
    friendEventInfo,
    groupEventText,
    groupSettingChanges,
    quoteText,
    reactionEmoji,
    reactionText,
    reactionIcon,
    RecentMessages,
    summarize,
    systemNoticeText,
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
import { watchSocket } from "../watchdog.mjs";
import { closeCause, ConnectionHistory } from "../history.mjs";
import {
    captionOf,
    describeContent,
    downloadAttachment,
    imageSize,
    isBotEcho,
    toAttachmentSource,
    videoText,
    sendContent,
    forwardSeen,
    forwardTyping,
    normalizePhone,
    splitVoices,
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
