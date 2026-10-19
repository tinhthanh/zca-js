// Đăng nhập Zalo bằng QR: hiển thị mã QR trên http://localhost:6081, lưu
// credentials.json (cookie, imei, userAgent) cho tài khoản ACCOUNT rồi thoát.
// Không bao giờ in cookie ra log.
import http from "node:http";
import path from "node:path";

import { Zalo } from "../dist/index.js";
import { LoginQRCallbackEventType } from "../dist/apis/loginQR.js";
import {
    ACCOUNTS_DIR,
    ACCOUNT_NAME_PATTERN,
    CREDENTIALS_FILE,
    log,
    readCredentials,
    writePrivateJson,
} from "./common.mjs";

const ACCOUNT = process.env.ACCOUNT || "default";
const FORCE_LOGIN = ["1", "true", "yes"].includes((process.env.FORCE_LOGIN || "").toLowerCase());
const PORT = Number(process.env.LOGIN_PORT || 6081);
const MAX_QR = Number(process.env.MAX_QR || 5); // mỗi mã QR sống ~100 giây

if (!ACCOUNT_NAME_PATTERN.test(ACCOUNT)) {
    log("", "login", `Tên tài khoản không hợp lệ: ${JSON.stringify(ACCOUNT)}`);
    process.exit(1);
}
const credentialsPath = path.join(ACCOUNTS_DIR, ACCOUNT, CREDENTIALS_FILE);

if (!FORCE_LOGIN && readCredentials(credentialsPath)) {
    log(ACCOUNT, "login", "Đã có credentials; bỏ qua đăng nhập (đặt FORCE_LOGIN=1 để đăng nhập lại).");
    process.exit(0);
}

const state = { status: "Đang tạo mã QR...", image: null, version: 0 };

const PAGE = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zalo QR login</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f8;color:#1b1f24;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
img{width:280px;height:280px;background:#fff;border-radius:12px;padding:12px;image-rendering:pixelated}
p{max-width:420px;text-align:center}</style></head>
<body><h2>Đăng nhập Zalo: ${ACCOUNT}</h2><img id="qr" alt="QR"><p id="status"></p>
<p><small>Mở app Zalo trên điện thoại, chọn biểu tượng quét QR, rồi xác nhận đăng nhập.</small></p>
<script>
let version=-1;
async function tick(){try{const s=await (await fetch('/status',{cache:'no-store'})).json();
document.getElementById('status').textContent=s.status;
if(s.version!==version){version=s.version;document.getElementById('qr').src='/qr.png?v='+version;}}catch(e){}}
setInterval(tick,2000);tick();
</script></body></html>`;

const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/?")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
    }
    if (req.url === "/status") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ status: state.status, version: state.version }));
    }
    if (req.url?.startsWith("/qr.png") && state.image) {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        return res.end(Buffer.from(state.image, "base64"));
    }
    res.writeHead(404);
    res.end();
});
server.listen(PORT, "0.0.0.0", () => {
    log(ACCOUNT, "login", `Mở http://localhost:${PORT} và quét mã QR bằng app Zalo.`);
});

let qrCount = 0;
const zalo = new Zalo({ checkUpdate: false, logging: false });

try {
    const api = await zalo.loginQR({}, (event) => {
        switch (event.type) {
            case LoginQRCallbackEventType.QRCodeGenerated:
                qrCount++;
                state.image = event.data.image;
                state.version++;
                state.status = `Quét mã QR (lần ${qrCount}/${MAX_QR}).`;
                log(ACCOUNT, "login", `Đã tạo mã QR ${qrCount}/${MAX_QR}.`);
                break;
            case LoginQRCallbackEventType.QRCodeExpired:
            case LoginQRCallbackEventType.QRCodeDeclined:
                if (qrCount >= MAX_QR) {
                    state.status = "Hết số lần thử. Chạy lại dịch vụ login.";
                    log(ACCOUNT, "login", "Hết số lần tạo mã QR.");
                    event.actions.abort();
                } else {
                    const why = event.type === LoginQRCallbackEventType.QRCodeExpired ? "hết hạn" : "bị từ chối";
                    log(ACCOUNT, "login", `Mã QR ${why}, tạo mã mới.`);
                    event.actions.retry();
                }
                break;
            case LoginQRCallbackEventType.QRCodeScanned:
                state.status = "Đã quét. Xác nhận đăng nhập trên điện thoại.";
                log(ACCOUNT, "login", "Đã quét mã QR, chờ xác nhận.");
                break;
            case LoginQRCallbackEventType.GotLoginInfo:
                state.status = "Đang hoàn tất đăng nhập...";
                break;
        }
    });

    const context = api.getContext();
    writePrivateJson(credentialsPath, {
        cookie: context.cookie.toJSON()?.cookies || [],
        imei: context.imei,
        userAgent: context.userAgent,
    });
    state.status = "Đăng nhập thành công. Có thể đóng trang này.";
    log(ACCOUNT, "login", `Đã lưu credentials vào ${credentialsPath}.`);
    // Cho trang kịp hiển thị trạng thái cuối trước khi tắt server.
    setTimeout(() => server.close(() => process.exit(0)), 3000).unref();
    setTimeout(() => process.exit(0), 5000);
} catch (error) {
    log(ACCOUNT, "login", `Đăng nhập thất bại: ${error?.message || error}`);
    server.close();
    process.exit(1);
}
