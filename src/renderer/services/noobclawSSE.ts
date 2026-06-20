// noobclawSSE — 跟 /api/me/events/stream 保持的 EventSource 连接。
//
// 用途:服务端推业务事件 → 通用派发成 DOM CustomEvent。客户端业务组件按需
// 监听 `noobclaw:<eventType>` 事件即可,新增推送类型本文件零改动。
//
// Wire format (跟 backend services/userEventStream.ts 约定):
//   data: {"type":"<eventType>","payload":<json>}\n\n
//
//   不用 SSE 命名事件 (`event:` header) — 那种要 addEventListener('<name>', ...)
//   一一注册,加新推送类型每次回来改这文件。统一 'message' 通道 + payload
//   带 type,客户端 onmessage 拿到后按 type 派发,完全 generic。
//
// 当前后端会推:
//   - rebate-received   : { amount, fromWallet, level, count }
//                         → 'noobclaw:rebate-received' → <RebateDrawer>
//   - server-shutdown   : {} (PM2 reload 时,客户端走更长退避后再连)
//   - 未来新增:后端 pushTo(wallet, 'mission-completed', {...}),客户端业务
//     组件加 window.addEventListener('noobclaw:mission-completed', ...) 即可,
//     本文件不动。
//
// 设计:
//   - 单例 service,由 App.tsx 在 isAuthenticated && authToken 时 start(),
//     false 时 stop()。
//   - 浏览器原生 EventSource 自带重连(~3s 默认)。我们额外处理两种:
//       (1) 401 / CORS 等硬错:onerror 触发后我们主动 close,走指数退避重连。
//       (2) server-shutdown:走更长退避(5s 而不是 base 1.5s),避免 PM2
//           reload 完成的瞬间所有客户端同时回连。
//   - EventSource 不支持 Authorization header,token 走 query param。HTTPS
//     下加密传输;Electron 客户端不存浏览器 history;服务端日志看 token 可
//     接受(同 /api/me/* 其它接口同源)。
//   - 不在这里做任何业务事件解析:谁监听 DOM 事件谁处理 payload。

import { getBackendApiUrl } from './endpoints';

const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30_000;
const SHUTDOWN_BACKOFF_MS = 5_000;  // PM2 reload 时全员退避,防雪崩

interface SSEFrame {
  type: string;
  payload: unknown;
}

class NoobClawSSEService {
  private es: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private currentToken: string | null = null;
  private stopped = true;

  /**
   * 启动 SSE。token 变化时(用户切账号 / refresh token)调用,会自动 close
   * 旧连接再建新的。stopped=false 期间断线 → 自动重连。
   */
  start(token: string): void {
    if (this.es && this.currentToken === token) return;  // 同 token 重复 start 幂等
    this.stop();
    this.currentToken = token;
    this.stopped = false;
    this.open();
  }

  /**
   * 停止 SSE。logout / handleAuthExpired 时调用。
   * 清理重连 timer,关 EventSource,清状态。
   */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.es) {
      try { this.es.close(); } catch { /* already closed */ }
      this.es = null;
    }
    this.currentToken = null;
    this.attempts = 0;
  }

  private open(): void {
    if (this.stopped || !this.currentToken) return;
    const url = `${getBackendApiUrl()}/api/me/events/stream?token=${encodeURIComponent(this.currentToken)}`;

    let es: EventSource;
    try {
      es = new EventSource(url);
    } catch (err) {
      console.warn('[SSE] failed to construct EventSource:', err);
      this.scheduleReconnect(RECONNECT_BASE_MS);
      return;
    }
    this.es = es;

    es.onopen = () => {
      this.attempts = 0;  // reset 退避计数
    };

    es.onmessage = (e: MessageEvent) => {
      // 后端发的注释行(`: ping` / `: connected`)不触发 onmessage —
      // 它们只在网络层保活。这里只处理真正的 data 帧。
      let frame: SSEFrame;
      try {
        frame = JSON.parse(e.data);
      } catch {
        console.warn('[SSE] malformed frame, ignored:', e.data);
        return;
      }
      if (!frame || typeof frame.type !== 'string') {
        console.warn('[SSE] frame missing type, ignored:', frame);
        return;
      }

      // 'server-shutdown' 是基建事件,自己处理(走长退避);其它都是业务事件,
      // 派发 DOM 事件给业务组件。
      if (frame.type === 'server-shutdown') {
        console.info('[SSE] server-shutdown received, backing off before reconnect');
        try { es.close(); } catch { /* */ }
        this.es = null;
        if (!this.stopped) this.scheduleReconnect(SHUTDOWN_BACKOFF_MS);
        return;
      }

      // 通用派发 — 所有业务事件统一翻译成 `noobclaw:<type>` DOM 事件。
      // 业务组件监听 'noobclaw:rebate-received' 等即可,跟 polling 路径同名。
      window.dispatchEvent(new CustomEvent(`noobclaw:${frame.type}`, { detail: frame.payload }));
    };

    es.onerror = () => {
      // EventSource 内部会自动尝试重连,但 401/CORS 等硬错会反复触发 onerror。
      // 主动 close + 指数退避 — 把控制权拿回来,既比浏览器默认 3s 更平滑,
      // 也能在 stopped 时干净放弃。
      try { es.close(); } catch { /* */ }
      this.es = null;
      if (this.stopped) return;
      // 指数退避:1.5s, 3s, 6s, 12s, 24s, 30s (capped)
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts, RECONNECT_MAX_MS);
      this.attempts++;
      this.scheduleReconnect(delay);
    };
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delayMs);
  }
}

export const noobClawSSE = new NoobClawSSEService();
