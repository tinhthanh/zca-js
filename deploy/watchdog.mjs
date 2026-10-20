// Phát hiện kết nối Zalo đã chết mà listener không biết (mất mạng không có gói
// đóng). Máy chủ Zalo không trả lời ping chuẩn WebSocket, nên thay vào đó theo dõi
// lần cuối nhận được dữ liệu: zca-js gửi ping tầng ứng dụng định kỳ và máy chủ
// trả lời. Quá `staleMs` không nhận được gì thì cắt kết nối để bot tự nối lại.

export const WATCHDOG_CHECK_MS = 15_000;

/** Theo dõi socket hiện tại; gọi lại mỗi lần "connected". Trả hàm dừng.
 *  observeOnly: chỉ báo khoảng lặng dài nhất (đo trước khi bật cắt kết nối). */
export function watchSocket(ws, { staleMs, checkMs = WATCHDOG_CHECK_MS, onDead, onGap, now = Date.now } = {}) {
    if (!ws || typeof ws.on !== "function" || !(staleMs > 0)) return () => {};
    let last = now();
    let longest = 0;
    const onFrame = () => {
        const t = now();
        longest = Math.max(longest, t - last);
        last = t;
    };
    ws.on("message", onFrame);
    const tick = setInterval(() => {
        if (ws.readyState !== 1) return; // 1 = OPEN
        const silent = now() - last;
        onGap?.(Math.max(longest, silent));
        if (silent > staleMs) {
            stop();
            onDead?.(silent);
            ws.terminate();
        }
    }, checkMs);
    tick.unref?.();
    function stop() {
        clearInterval(tick);
        ws.off?.("message", onFrame);
    }
    return stop;
}
