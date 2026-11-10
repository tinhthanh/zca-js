// Báo hiệu cuộc gọi Zalo cho zalo-call (omnichannel docs/plan-zalo-call.md, D21).
// zalo-call lo media và trình tự cuộc gọi; zalo-bot chỉ ký và gửi /api/voicecall/* bằng phiên
// của chính nó, để cookie và khoá phiên không rời zalo-bot (mở phiên Zalo thứ hai làm phiên này chết).

/** Endpoint báo hiệu được phép, theo bảng lệnh 401..416, 12006 của Zalo PC (ctdozlite `call.rs`). */
export const CALL_PATHS = new Set([
    "requestcall", // 401
    "request", // 416
    "ringring", // 407
    "answer", // 402
    "answerack", // 408
    "cancel", // 405
    "endcall", // 409
    "logendcall", // 406
    "conf", // 12006: bật/tắt mic, camera
]);

/** Lệnh tạo cuộc gọi mới: cần `calleeId`. */
const DIAL_PATHS = new Set(["requestcall", "request"]);

/** Thời gian nhớ danh sách tài khoản được gọi điện lấy từ gateway. */
export const CALL_ACCOUNTS_TTL_MS = 30_000;

/**
 * Tài khoản được gọi điện: admin bật/tắt trên trang Tài khoản kênh, gateway lưu và trả qua
 * `GET /v1/calls/accounts`. Nhớ 30 giây; gateway không trả lời thì dùng danh sách lần trước
 * (lần đầu là rỗng: không tài khoản nào gọi được).
 */
export function createCallAccounts({
    url = process.env.GATEWAY_URL,
    token = process.env.GATEWAY_TOKEN,
    fetchImpl = fetch,
    now = Date.now,
} = {}) {
    let cached = new Set();
    let fetchedAt = -Infinity;
    return async function allowedAccounts() {
        if (now() - fetchedAt < CALL_ACCOUNTS_TTL_MS) return cached;
        if (!url) return cached;
        try {
            const res = await fetchImpl(`${String(url).replace(/\/+$/, "")}/v1/calls/accounts`, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
                const body = await res.json();
                cached = new Set(Array.isArray(body?.zalo_accounts) ? body.zalo_accounts.map(String) : []);
                fetchedAt = now();
            }
        } catch {
            // giữ danh sách cũ
        }
        return cached;
    };
}

const allowedAccounts = createCallAccounts();

/**
 * Kiểm tra yêu cầu `{account, path, params, with_imei}`. Trả `{error, status}` nếu không hợp lệ,
 * ngược lại `{path, params}` đã chuẩn hoá. Mọi lệnh (không chỉ lệnh gọi) đều cần tài khoản được bật,
 * để tài khoản thật không bao giờ phát sinh lưu lượng gọi điện ngoài ý muốn.
 */
export function validateSignal(payload, allowed) {
    if (!payload || typeof payload !== "object") return { status: 400, error: "invalid payload" };
    const { account, path } = payload;
    if (!account || typeof account !== "string") return { status: 400, error: "missing account" };
    if (!allowed.has(account)) return { status: 403, error: "Tài khoản này chưa được bật gọi điện." };
    if (!CALL_PATHS.has(path)) return { status: 400, error: "unsupported path" };
    const raw = payload.params;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: 400, error: "invalid params" };
    const params = { ...raw };
    if (DIAL_PATHS.has(path) && !params.calleeId) return { status: 400, error: "missing calleeId" };
    return { path, params, withImei: payload.with_imei === true };
}

/** Gắn `api.voicecallSignal(path, params, withImei)` một lần cho mỗi API zca-js. */
export function ensureVoicecallApi(api) {
    if (typeof api.voicecallSignal === "function") return api.voicecallSignal;
    api.custom("voicecallSignal", async ({ ctx, utils, props }) => {
        const base = [].concat(api.zpwServiceMap?.voice_call || [])[0];
        if (!base) throw new Error("Phiên Zalo không có domain voice_call");
        const body = props.withImei ? { ...props.params, imei: ctx.imei } : props.params;
        const encrypted = utils.encodeAES(JSON.stringify(body));
        if (!encrypted) throw new Error("Không mã hoá được params");
        const url = utils.makeURL(`${String(base).replace(/\/+$/, "")}/api/voicecall/${props.path}`, {
            params: encrypted,
        });
        return utils.resolve(await utils.request(url, { method: "GET" }));
    });
    return api.voicecallSignal;
}

/**
 * POST /call/signal: `{account, path, params, with_imei}` -> `{ok, data}`.
 * Lỗi Zalo (có mã) trả 422 kèm lý do; lỗi mạng trả 502 để zalo-call tự quyết thử lại.
 */
export async function handleCallSignal({ payload, apis, reply, res, log, isPermanent, allowed = allowedAccounts }) {
    const checked = validateSignal(payload, await allowed());
    if (checked.error) return reply(res, checked.status, checked.error);
    const api = apis.get(payload.account);
    if (!api) return reply(res, 404, "unknown account");
    try {
        const signal = ensureVoicecallApi(api);
        const data = await signal({ path: checked.path, params: checked.params, withImei: checked.withImei });
        log(payload.account, "call", `${checked.path} ok callId=${checked.params.callId ?? "?"}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, data: data ?? null }));
    } catch (error) {
        const permanent = isPermanent(error);
        const code = error?.code ?? "";
        log(payload.account, "call", `❌ ${checked.path} lỗi ${code}: ${error?.message || error}`);
        reply(
            res,
            permanent ? 422 : 502,
            permanent ? `Zalo từ chối (${code}): ${error?.message || error}` : "signal failed",
        );
    }
}

/**
 * Chuyển sự kiện voip (`{act, act_type, data}`) sang zalo-call (`ZALO_CALL_EVENTS_URL`, vd.
 * `http://zalo-call:7009/call/event`). Chỉ tài khoản được bật gọi điện (gateway); tài khoản khác không bao giờ rời bot.
 * Không chặn listener: lỗi mạng chỉ trả false.
 */
export async function forwardVoip(
    account,
    control,
    {
        url = process.env.ZALO_CALL_EVENTS_URL,
        token = process.env.GATEWAY_TOKEN,
        allowed = allowedAccounts,
        fetchImpl = fetch,
    } = {},
) {
    if (!url || !(await allowed()).has(account)) return false;
    try {
        const res = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ account, control }),
            signal: AbortSignal.timeout(3000),
        });
        return res.ok;
    } catch {
        return false;
    }
}
