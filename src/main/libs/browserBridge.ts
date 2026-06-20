/**
 * Browser Bridge — HTTP-anchored transport for chrome / edge / firefox
 * extensions to talk to the desktop client.
 *
 * Two transports, both mounted on the sidecar HTTP server (18800):
 *   1. WebSocket  ws://127.0.0.1:18800/browser-bridge
 *      Used by Chrome / Edge. Firefox falls through to SSE because
 *      Firefox upgrades ws://localhost → wss:// under HTTPS-Only Mode
 *      (Bug 1670581), and we can't serve wss without a trusted cert.
 *   2. SSE + POST  http://127.0.0.1:18800/browser-bridge/events  (server→ext)
 *                  http://127.0.0.1:18800/browser-bridge/send?session=<id>  (ext→server)
 *      Used by Firefox as primary; available as fallback for chrome/edge too.
 *      Plain `fetch` to localhost is never upgraded by Firefox HTTPS-Only
 *      Mode, so this path is always reachable.
 *
 * Both transports route through attachBrowserConn() — downstream command
 * dispatch, msg.id correlation, hello/tabs_changed bookkeeping is shared.
 *
 * NM (Native Messaging) was removed in v2.8: registry writes + .bat host
 * scripts kept tripping 360/火绒/Defender heuristics. cleanupLegacyNmResidueOnce()
 * below scrubs residue from older installs so AV scans stay quiet.
 */

import http from 'http';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { isElectronMode, getUserDataPath, getAppPath, getResourcesPath, openExternal } from './platformAdapter';

// Conditionally load Electron modules — unavailable in sidecar mode
let app: any = null;
let BrowserWindow: any = null;
let dialog: any = null;
let shell: any = null;
try {
  if (isElectronMode()) {
    const electron = require('electron');
    app = electron.app;
    BrowserWindow = electron.BrowserWindow;
    dialog = electron.dialog;
    shell = electron.shell;
  }
} catch {}

// Legacy constant — kept for cleanupLegacyNmResidueOnce file/dir naming only.
// NM transport itself is removed (v2.8); this string is just used to match
// the on-disk artifact names previous installs wrote.
const NATIVE_HOST_NAME = 'com.noobclaw.browser';
const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/noobclaw-browser-assistan/abchfdkiphahgkoalhnmlfpfmgkedigf';
const EDGE_STORE_URL = 'https://microsoftedge.microsoft.com/addons/detail/laphnggbfbalnemcgjcgmdjaaehldkbd';
const FIREFOX_STORE_URL = 'https://addons.mozilla.org/addon/noobclaw-browser-assistant/';
const EXTENSION_IDS = [
  // New Chrome Web Store listing ID (current, 2026-04)
  'abchfdkiphahgkoalhnmlfpfmgkedigf',
  // Legacy fixed ID (extensions with manifest.key) — kept so users who
  // still have the dev/sideload build keep working.
  'dhmjehcfpjjliiknpahbnflgljinjdeo',
  // Microsoft Edge Add-ons listing ID. Edge re-signs the CRX with
  // its own private key when accepting a submission without "key" in
  // manifest, so the runtime extension id is DIFFERENT from the
  // Chrome Web Store one even though the source code is identical.
  // Without this entry, Edge users' extensions can connect over TCP
  // but the native messaging host manifest's allowed_origins doesn't
  // accept their chrome-extension:// origin.
  'laphnggbfbalnemcgjcgmdjaaehldkbd',
];

type BrowserType = 'chrome' | 'edge' | 'firefox';

interface DetectedBrowser {
  type: BrowserType;
  name: string;
  path: string;
  storeUrl: string;
}

function detectBrowsers(): DetectedBrowser[] {
  const browsers: DetectedBrowser[] = [];

  if (process.platform === 'win32') {
    const chromePaths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    const edgePaths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    const firefoxPaths = [
      path.join(process.env['PROGRAMFILES'] || '', 'Mozilla Firefox', 'firefox.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Mozilla Firefox', 'firefox.exe'),
    ];

    const chromePath = chromePaths.find(p => fs.existsSync(p));
    if (chromePath) browsers.push({ type: 'chrome', name: 'Google Chrome', path: chromePath, storeUrl: CHROME_STORE_URL });

    const edgePath = edgePaths.find(p => fs.existsSync(p));
    if (edgePath) browsers.push({ type: 'edge', name: 'Microsoft Edge', path: edgePath, storeUrl: EDGE_STORE_URL });

    const firefoxPath = firefoxPaths.find(p => fs.existsSync(p));
    if (firefoxPath) browsers.push({ type: 'firefox', name: 'Firefox', path: firefoxPath, storeUrl: FIREFOX_STORE_URL });

  } else if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/Google Chrome.app')) {
      browsers.push({ type: 'chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app', storeUrl: CHROME_STORE_URL });
    }
    if (fs.existsSync('/Applications/Microsoft Edge.app')) {
      browsers.push({ type: 'edge', name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app', storeUrl: EDGE_STORE_URL });
    }
    if (fs.existsSync('/Applications/Firefox.app')) {
      browsers.push({ type: 'firefox', name: 'Firefox', path: '/Applications/Firefox.app', storeUrl: FIREFOX_STORE_URL });
    }
  } else {
    // Linux
    const { execSync } = require('child_process');
    try { execSync('which google-chrome', { stdio: 'pipe' }); browsers.push({ type: 'chrome', name: 'Google Chrome', path: 'google-chrome', storeUrl: CHROME_STORE_URL }); } catch {}
    try { execSync('which microsoft-edge', { stdio: 'pipe' }); browsers.push({ type: 'edge', name: 'Microsoft Edge', path: 'microsoft-edge', storeUrl: EDGE_STORE_URL }); } catch {}
    try { execSync('which firefox', { stdio: 'pipe' }); browsers.push({ type: 'firefox', name: 'Firefox', path: 'firefox', storeUrl: FIREFOX_STORE_URL }); } catch {}
  }

  return browsers; // Chrome first by default
}

// Bridge is "running" once attachBrowserBridge() has wired its routes onto
// the sidecar HTTP server. We don't own the server (sidecar-server.ts does),
// just track whether the wiring is in place.
let bridgeAttached = false;
let bridgePort: number | null = null;

// Multi-browser support (v2.4.9): each connected browser instance owns its
// own socket + cached open-tab URL list. Pre-2.4.9 we kept ONE clientSocket
// global and `if (clientSocket) clientSocket.destroy()` on each new connect
// — which meant logging into XHS in browser A and Twitter in browser B
// killed whichever connected first. Now we keep them all in a Map and
// route each command to the connection whose tabs match the requested
// `tabPattern`. Commands without a pattern fall back to whichever
// connection saw the most recent activity.
interface BrowserConn {
  id: string;
  socket: net.Socket;
  /** Which transport this conn arrived on.
   *    WS  — Chrome / Edge (and any browser whose WebSocket impl handles
   *          ws://localhost correctly). Native ws frames.
   *    SSE — Firefox (and chrome/edge fallback). Server-Sent Events
   *          (server→ext) paired with POST /browser-bridge/send (ext→server),
   *          both adapted into a net.Socket-shaped facade.
   *  Used purely for diagnostic logs and the popup status badge; downstream
   *  command routing treats them identically. */
  transport: 'ws' | 'sse';
  tabs: Array<{ id: number; url: string }>;
  /** Extension version reported in the `hello` message. Empty until the
   *  extension side rolls out v1.2.0+ (older versions don't send it). */
  extensionVersion: string;
  /** v1.4.0+: capabilities advertised by the extension in its hello. Lets
   *  this client opt into protocol extensions (e.g. envelope.isolate when
   *  'isolated_windows' is present) without breaking older extensions
   *  that never set the field. Empty Set = legacy extension. */
  capabilities: Set<string>;
  /** When this connection was accepted by the bridge. The renderer uses
   *  this to distinguish "extension still mid-handshake (just connected,
   *  hello not arrived yet)" from "extension is genuinely too old to send
   *  hello at all" — if connectedAt is more than ~5s ago and version is
   *  still empty, the extension predates the v1.2.0 hello protocol and
   *  the user must update. */
  connectedAt: number;
  lastActivityAt: number;
  /** D1: Last time the bridge received ANY inbound message on this conn
   *  (ping / pong / hello / tabs_changed / command response). Different
   *  from lastActivityAt which only updates on command-correlated traffic.
   *  Used by the global stale-conn scanner to detect "插件 SW 被 Chrome 杀
   *  了 + WS 半开残留" — extension stops sending its 25s ping, we notice
   *  within ~60s and force-destroy the socket. Without this, a dead conn
   *  sits in browserConns until a command happens to be routed to it +
   *  hits the B1 consecutiveTimeouts threshold (which itself takes 2 ×
   *  command timeout = ~60s).
   *
   *  Initialized to connectedAt so a brand-new conn isn't immediately
   *  flagged as stale before its first ping arrives. */
  lastInboundAt: number;
  /** Consecutive sendBrowserCommand timeouts on this conn. After 2 in a
   *  row the socket is considered dead and force-destroyed (the close
   *  handler then removes it from browserConns). Reset to 0 on every
   *  successful response. */
  consecutiveTimeouts: number;
}
const browserConns = new Map<string, BrowserConn>();
let connSeq = 0;

// ─── Legacy NM residue cleanup (file-side) ─────────────────────────
//
// Companion to the Win32 Registry cleanup that the Tauri Rust setup()
// now runs in-process. The Rust side wipes HKCU\...\NativeMessagingHosts
// keys; we (Node side) wipe the matching .bat / .json files our older
// `registerNativeMessagingHost` wrote into %APPDATA%\NoobClaw\. Pure
// fs.unlink — no subprocess, no shell invocation, AV never notices.
//
// Idempotent (errors are swallowed); safe to call on every startup.
// Files removed:
//   - native-messaging-host.bat            (Windows wrapper)
//   - native-messaging-host.sh             (macOS / Linux wrapper)
//   - com.noobclaw.browser.json            (Chrome / Edge manifest)
//   - com.noobclaw.browser.firefox.json    (Firefox manifest)
//   - any matching files under macOS / Linux NM host dirs
export async function cleanupLegacyNmResidueOnce(): Promise<void> {
  const userData = getUserDataPath();
  const candidates: string[] = [
    path.join(userData, 'native-messaging-host.bat'),
    path.join(userData, 'native-messaging-host.sh'),
    path.join(userData, `${NATIVE_HOST_NAME}.json`),
    path.join(userData, `${NATIVE_HOST_NAME}.firefox.json`),
  ];

  // macOS / Linux: legacy installs also wrote NM host JSONs under each
  // browser's NativeMessagingHosts dir directly. Best-effort unlink.
  if (process.platform === 'darwin') {
    const home = process.env.HOME || '~';
    candidates.push(
      path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
      path.join(home, 'Library/Application Support/Microsoft Edge/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
      path.join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
    );
  } else if (process.platform === 'linux') {
    const home = process.env.HOME || '~';
    candidates.push(
      path.join(home, '.config/google-chrome/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
      path.join(home, '.config/microsoft-edge/NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`),
      path.join(home, '.mozilla/native-messaging-hosts', `${NATIVE_HOST_NAME}.json`),
    );
  }

  let cleaned = 0;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        cleaned++;
      }
    } catch { /* best-effort */ }
  }
  if (cleaned > 0) {
    console.log(`[BrowserBridge] cleanupLegacyNmResidueOnce: removed ${cleaned} legacy NM file(s)`);
  }
}

function isAnyBrowserConnected(): boolean {
  for (const c of browserConns.values()) {
    if (!c.socket.destroyed) return true;
  }
  return false;
}

/** Snapshot of every connected browser extension (for the renderer to
 *  detect outdated versions and prompt the user to update). Includes
 *  connectedAt so the renderer can distinguish "still handshaking" from
 *  "definitely too old to send hello at all" (1.1.0 etc.). */
export function getConnectedExtensions(): Array<{
  id: string;
  version: string;
  tabCount: number;
  connectedAt: number;
}> {
  const out: Array<{ id: string; version: string; tabCount: number; connectedAt: number }> = [];
  for (const c of browserConns.values()) {
    if (c.socket.destroyed) continue;
    out.push({
      id: c.id,
      // Empty string means the extension is so old it pre-dates the
      // hello-with-version protocol (i.e. < 1.2.0).
      version: c.extensionVersion || '',
      tabCount: c.tabs.length,
      connectedAt: c.connectedAt,
    });
  }
  return out;
}

const pendingRequests = new Map<string, {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

// --- Status ---

export function getBrowserBridgeStatus(): {
  running: boolean;
  port: number | null;
  connected: boolean;
  extensionInstalled: boolean;
} {
  return {
    running: bridgeAttached,
    port: bridgePort,
    connected: isAnyBrowserConnected(),
    // v2.8+: NM is gone, so we no longer can detect "extension installed"
    // by inspecting NM manifest paths. The connection-based renderer flow
    // (`connected` above + `getConnectedExtensions`) gives a more accurate
    // signal anyway: if any extension is talking to us, it's installed.
    extensionInstalled: isAnyBrowserConnected(),
  };
}

// --- Extension Installation Detection ---

const extensionPromptTexts: Record<string, Record<string, string>> = {
  en: {
    title: 'NoobClaw Browser Assistant',
    installMsg: 'Enable AI Browser Automation',
    installDetail: 'Install the NoobClaw Browser Assistant to let AI control your browser just like a human — clicking, typing, scrolling, and navigating websites using your real browser with all your login sessions.\n\n• AI operates your browser like a real person — no bot detection\n• Works with your logged-in accounts (social media, email, etc.)\n• 24/7 automated browsing, data collection, and form filling\n• All data stays local, nothing is sent to external servers',
    btnStore: 'Install from Chrome Store',
    btnNotNow: 'Not now',
    btnCancel: 'Cancel',
  },
  zh: {
    title: 'NoobClaw 浏览器助手',
    installMsg: '启用 AI 浏览器自动化',
    installDetail: '安装 NoobClaw 浏览器助手，让 AI 像真人一样操控您的浏览器 — 点击、输入、滚动、导航网页，使用您真实的浏览器及所有登录状态。\n\n• AI 像真人一样操作浏览器 — 不会被网站检测\n• 使用您已登录的账号（社交媒体、邮箱等）\n• 全天候 24 小时自动化浏览、数据采集和表单填写\n• 所有数据留在本地，不会发送到外部服务器',
    btnStore: '从Chrome商店安装',
    btnNotNow: '暂不安装',
    btnCancel: '取消',
  },
  'zh-TW': {
    title: 'NoobClaw 瀏覽器助手',
    installMsg: '啟用 AI 瀏覽器自動化',
    installDetail: '安裝 NoobClaw 瀏覽器助手，讓 AI 像真人一樣操控您的瀏覽器。\n\n• 不會被網站偵測\n• 使用您已登入的帳號\n• 全天候自動化\n• 資料留在本地',
    btnStore: '從Chrome商店安裝',
    btnNotNow: '暫不安裝',
    btnCancel: '取消',
  },
  ja: {
    title: 'NoobClaw ブラウザアシスタント',
    installMsg: 'AIブラウザ自動化を有効にする',
    installDetail: 'AIにブラウザを操作させましょう。\n\n• ボット検知なし\n• ログイン済みアカウントで動作\n• 24時間自動化\n• データはローカル',
    btnStore: 'Chromeストアからインストール',
    btnNotNow: '後で',
    btnCancel: 'キャンセル',
  },
  ko: {
    title: 'NoobClaw 브라우저 어시스턴트',
    installMsg: 'AI 브라우저 자동화 활성화',
    installDetail: 'AI가 브라우저를 사람처럼 제어합니다.\n\n• 봇 탐지 없음\n• 로그인 계정으로 작동\n• 24시간 자동화\n• 로컬 저장',
    btnStore: 'Chrome 스토어에서 설치',
    btnNotNow: '나중에',
    btnCancel: '취소',
  },
};

function getPromptTexts() {
  const locale = (app?.getLocale?.() || Intl.DateTimeFormat().resolvedOptions().locale || 'en').toLowerCase();
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hant')) return extensionPromptTexts['zh-TW'];
  if (locale.startsWith('zh')) return extensionPromptTexts.zh;
  if (locale.startsWith('ja')) return extensionPromptTexts.ja;
  if (locale.startsWith('ko')) return extensionPromptTexts.ko;
  return extensionPromptTexts.en;
}

/**
 * Show extension install prompt. Returns:
 * - 'installed': user chose to install
 * - 'cancelled': user chose "not now"
 */
export async function showExtensionPrompt(): Promise<'installed' | 'cancelled'> {
  const win = BrowserWindow?.getFocusedWindow?.();

  if (win && dialog) {
    // Electron mode: use native dialog. The extension ships in all 3 stores
    // (Chrome / Firefox / Edge), so we no longer offer a local-install path.
    const t = getPromptTexts();
    const result = await dialog.showMessageBox(win, {
      type: 'info',
      title: t.title,
      message: t.installMsg,
      detail: t.installDetail,
      buttons: [t.btnStore, t.btnNotNow],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      const browsers = detectBrowsers();
      const storeUrl = browsers.length > 0 ? browsers[0].storeUrl : CHROME_STORE_URL;
      shell?.openExternal?.(storeUrl) ?? openExternal(storeUrl);
      return 'installed';
    }
    return 'cancelled';
  }

  // Sidecar/Tauri mode: use the global extensionPromptCallback if registered,
  // otherwise open Chrome Store directly
  if (_extensionPromptCallback) {
    try {
      const choice = await _extensionPromptCallback({
        storeUrl: CHROME_STORE_URL,
        title: 'Browser Extension Required',
        message: 'NoobClaw needs the browser extension for full browser automation.\nInstall it now?',
      });
      if (choice === 'cancel') return 'cancelled';
      try { await openExternal(CHROME_STORE_URL); } catch {}
      return 'installed';
    } catch {}
  }

  // Fallback: open Chrome Store directly
  try { await openExternal(CHROME_STORE_URL); } catch {}
  return 'installed';
}

// Callback for extension install prompt — set by sidecar-server to avoid circular import
type ExtensionPromptCallback = (opts: { storeUrl: string; title: string; message: string }) => Promise<'install' | 'cancel'>;
let _extensionPromptCallback: ExtensionPromptCallback | null = null;

export function setExtensionPromptCallback(cb: ExtensionPromptCallback): void {
  _extensionPromptCallback = cb;
}

// Legacy resolver — kept for backward compat
export function resolveExtensionPrompt(_requestId: string, _result: string): void {}

/**
 * Check if extension is actually installed by looking at Chrome's extension directory
 */
export function isExtensionInstalled(): boolean {
  try {
    const homeDir = require('os').homedir();
    // Check both new (Store) and legacy (sideloaded) extension IDs
    const basePaths: string[] = [];
    if (process.platform === 'win32') {
      basePaths.push(
        path.join(homeDir, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions'),
        path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Extensions'),
      );
    } else if (process.platform === 'darwin') {
      basePaths.push(
        path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions'),
        path.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'Extensions'),
      );
    } else {
      basePaths.push(
        path.join(homeDir, '.config', 'google-chrome', 'Default', 'Extensions'),
        path.join(homeDir, '.config', 'microsoft-edge', 'Default', 'Extensions'),
      );
    }
    for (const base of basePaths) {
      for (const id of EXTENSION_IDS) {
        if (fs.existsSync(path.join(base, id))) return true;
      }
    }
    return false;
  } catch { return false; }
}

// --- Connection lifecycle (shared between NM TCP and WS fallback) ---

/**
 * Wire up a transport-agnostic connection. Both the NM TCP listener and the
 * WS upgrade handler call this with whatever socket-shaped object they have.
 * Owns: registration in browserConns, hello/tabs_changed parsing, command
 * response routing, lifecycle teardown.
 */
function attachBrowserConn(socket: net.Socket, transport: 'ws' | 'sse'): void {
  const connId = `conn_${++connSeq}`;
  const conn: BrowserConn = {
    id: connId,
    socket,
    transport,
    tabs: [],
    extensionVersion: '',
    capabilities: new Set<string>(),
    connectedAt: Date.now(),
    lastActivityAt: Date.now(),
    // D1: 初始化成 connectedAt,避免刚连上还没握手就被 60s 扫描器误杀。
    // 之后任何 inbound message 都会刷新它(见 socket.on('data') 顶部)。
    lastInboundAt: Date.now(),
    consecutiveTimeouts: 0,
  };
  // OS-level TCP keepalive — if the socket goes silently dead (system
  // sleep, network blip, native host crash without proper FIN), the OS
  // will probe every ~30s and after a few failed probes will fire
  // socket.on('close'), which removes the stale conn from the map.
  // Without this, dead sockets linger for 2 hours (default Linux/macOS
  // TCP keepalive timer) — long enough that every sendBrowserCommand
  // hits the dead conn first, waits 3s for timeout, returns failure.
  // User-visible symptom: "运行前检查" hangs forever.
  // (WS shim no-ops these; the ws lib has its own ping/pong.)
  try { socket.setKeepAlive(true, 30000); } catch {}
  try { socket.setNoDelay(true); } catch {}
  browserConns.set(connId, conn);
  console.log(`[BrowserBridge] Browser ${connId} connected via ${transport.toUpperCase()} (total: ${browserConns.size})`);

  notifyBridgeStatus(true);
  fireConnectionListeners();

  let recvBuf = '';
  socket.on('data', (data) => {
    // D1: 任何 inbound data 都算 conn "活着" — 哪怕是 ping、空帧、解析失败的
    // 残片。早到上面是因为某些消息类型(pong / 没人接的 ping)会在下面 early
    // return 跳过后续 setter,如果只在每个 case 里写一次容易漏。
    conn.lastInboundAt = Date.now();
    recvBuf += data.toString('utf8');
    let newlineIdx;
    while ((newlineIdx = recvBuf.indexOf('\n')) >= 0) {
      const line = recvBuf.slice(0, newlineIdx);
      recvBuf = recvBuf.slice(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        if (msg.type === 'pong') return;

        // Tab inventory updates from the extension. The extension sends
        // `hello` once on connect, then `tabs_changed` on every tab
        // create / update / remove. We use these to route subsequent
        // commands by tabPattern without round-tripping a query first.
        if (msg.type === 'hello' || msg.type === 'tabs_changed') {
          if (typeof msg.version === 'string' && msg.version) {
            conn.extensionVersion = msg.version;
          }
          // v1.4.0+: extension advertises capability strings in hello so
          // we can opt into protocol extensions (e.g. envelope.isolate).
          // Cleared+rebuilt on every announce so the extension can
          // disable a capability mid-session if needed.
          if (Array.isArray(msg.capabilities)) {
            conn.capabilities = new Set(msg.capabilities.filter((c: any) => typeof c === 'string'));
          }
          if (Array.isArray(msg.tabs)) {
            conn.tabs = msg.tabs.map((t: any) => ({
              id: Number(t.id),
              url: String(t.url || ''),
            }));
            conn.lastActivityAt = Date.now();
          }
          return;
        }

        // Response to a command — could come from ANY connection. The
        // pendingRequests map is keyed by command id which is unique
        // across browsers, so no de-dup needed.
        if (msg.id && pendingRequests.has(msg.id)) {
          const pending = pendingRequests.get(msg.id)!;
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          conn.lastActivityAt = Date.now();
          // B1: 收到响应(无论 success/failure) → 证明这条 conn 还活着,
          // 重置连续超时计数。配合 sendBrowserCommand timer 那边的 ++ 和
          // ">=2 force destroy" 形成自愈环 — 死 conn 自动剔除,不会一直
          // 堵在 pickConnForPattern 选不动。
          conn.consecutiveTimeouts = 0;
          if (msg.success) {
            pending.resolve(msg.data);
          } else {
            pending.reject(new Error(msg.error || 'Command failed'));
          }
        }
      } catch (err) {
        console.error('[BrowserBridge] Failed to parse message:', err);
      }
    }
  });

  socket.on('close', () => {
    console.log(`[BrowserBridge] Browser ${connId} (${transport.toUpperCase()}) disconnected (remaining: ${browserConns.size - 1})`);
    browserConns.delete(connId);
    if (!isAnyBrowserConnected()) notifyBridgeStatus(false);
    // Reject any pending requests that were definitely targeted at this
    // connection. We can't tell from pending entries which conn they
    // were sent to, so on FULL disconnect (no browsers left) we reject
    // all. Otherwise we let them ride — another browser might respond,
    // or they'll time out naturally.
    if (browserConns.size === 0) {
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Extension disconnected'));
        pendingRequests.delete(id);
      }
    }
  });

  socket.on('error', (err) => {
    console.error(`[BrowserBridge] Socket error on ${connId} (${transport.toUpperCase()}):`, err.message);
  });
}

// --- WebSocket fallback (mounts on existing sidecar HTTP server) ---

/**
 * Adapter: wrap a `ws` WebSocket into a net.Socket-shaped facade so the
 * existing browserBridge connection-handling code (designed for net.Socket)
 * can consume it without modification. Only the methods/events actually used
 * by attachBrowserConn are shimmed:
 *   - .write(string|Buffer)
 *   - .destroy()
 *   - .destroyed (bool)
 *   - .setKeepAlive() / .setNoDelay() — no-ops; ws has its own ping/pong
 *   - .on('data' | 'close' | 'error')
 * WS frames are message-bounded; we append '\n' to each frame to match the
 * line-delimited JSON parser inherited from the TCP path.
 */
function wrapWebSocketAsSocket(ws: WsWebSocket): net.Socket {
  const shim: any = new EventEmitter();
  shim.destroyed = false;
  shim.write = (data: string | Buffer) => {
    if (shim.destroyed) return false;
    try {
      ws.send(typeof data === 'string' ? data : data.toString('utf8'));
      return true;
    } catch { return false; }
  };
  shim.destroy = () => {
    if (shim.destroyed) return;
    shim.destroyed = true;
    try { ws.close(1000, 'destroyed'); } catch {}
    try { ws.terminate(); } catch {}
  };
  shim.setKeepAlive = () => {};
  shim.setNoDelay = () => {};

  ws.on('message', (data) => {
    let str: string;
    if (typeof data === 'string') str = data;
    else if (Buffer.isBuffer(data)) str = data.toString('utf8');
    else if (Array.isArray(data)) str = Buffer.concat(data as Buffer[]).toString('utf8');
    else str = String(data);
    if (!str.endsWith('\n')) str += '\n';
    shim.emit('data', Buffer.from(str, 'utf8'));
  });
  ws.on('close', () => {
    if (!shim.destroyed) shim.destroyed = true;
    shim.emit('close');
  });
  ws.on('error', (err) => shim.emit('error', err));
  return shim as net.Socket;
}

let wsServer: WebSocketServer | null = null;

/**
 * Shared Origin gate for both the WS upgrade path and the SSE+POST path.
 *
 *   - chrome-extension://<id>   for one of EXTENSION_IDS (Chrome/Edge)
 *   - moz-extension://<UUID>    for any Firefox install. Firefox derives a
 *                                 fresh UUID per install, so we can't
 *                                 whitelist specific UUIDs the way we do
 *                                 CRX IDs. Instead we accept any
 *                                 moz-extension:// origin and rely on the
 *                                 protocol-level hello message (which
 *                                 carries the extension `name`) for the
 *                                 second-layer identity check.
 *
 * Real browsers can never spoof Origin on a request initiated by an
 * extension — the value comes from the runtime URL scheme. A non-browser
 * local process could craft any Origin, but that's the same threat model
 * the pre-NM (2026-03 era) WebSocket implementation accepted, and a
 * malicious local process already has stronger attack vectors than this.
 */
function isAllowedExtensionOrigin(origin: string): boolean {
  // Empty Origin → accept. Rationale:
  //   1. The HTTP server binds 127.0.0.1, so any request that reaches this
  //      handler came from the local machine. Cross-host CSRF is impossible.
  //   2. The Origin header is browser-controlled and only present on
  //      cross-origin requests initiated from a normal web page (or some
  //      extension fetch flows). Firefox specifically does NOT send Origin
  //      on extension-initiated fetch from a background script / page
  //      (privacy hardening — avoids leaking the extension UUID to the
  //      target server). Sec-Fetch-Site: same-origin is used in its place.
  //      Result: rejecting empty-Origin requests means EVERY Firefox
  //      extension fetch from background gets 403'd silently.
  //   3. Tools like curl / PowerShell / native scripts running locally
  //      also send no Origin header and are legitimate consumers.
  // The Origin check below remains as a CSRF gate against the one case
  // that DOES send Origin: a malicious web page in any browser trying
  // to make this localhost server execute browser commands from its JS.
  if (!origin) return true;
  const allowedChromeOrigins = EXTENSION_IDS.map(id => `chrome-extension://${id}`);
  if (allowedChromeOrigins.includes(origin)) return true;
  // Firefox uses one of two forms when it DOES send Origin (e.g. content
  // script context, page-action, etc.):
  //   - moz-extension://<UUID>     (auto-generated per install)
  //   - moz-extension://<gecko-id> (explicit manifest id, e.g. `hi@noobclaw.com`)
  if (/^moz-extension:\/\/[^/?#]+$/.test(origin)) return true;
  return false;
}

/**
 * Mount the WebSocket endpoint on the given HTTP server. Idempotent.
 * Hijacks the server's `upgrade` event for our /browser-bridge path and
 * leaves non-matching upgrades alone.
 */
export function attachBrowserBridgeWebSocket(httpServer: http.Server): void {
  if (wsServer) return;
  wsServer = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, sock, head) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/browser-bridge') return;

      const origin = String(req.headers.origin || '');
      if (!isAllowedExtensionOrigin(origin)) {
        console.warn(`[BrowserBridge] WS upgrade rejected: Origin=${origin || '(empty)'} not in extension whitelist (chrome:${EXTENSION_IDS.length} ids + moz-extension:*)`);
        try { sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch {}
        try { sock.destroy(); } catch {}
        return;
      }

      wsServer!.handleUpgrade(req, sock as net.Socket, head, (ws) => {
        const shim = wrapWebSocketAsSocket(ws);
        attachBrowserConn(shim, 'ws');
      });
    } catch (err) {
      console.error('[BrowserBridge] WS upgrade error:', err);
      try { sock.destroy(); } catch {}
    }
  });

  console.log('[BrowserBridge] WebSocket mounted at /browser-bridge (Origin-gated)');
}

// --- SSE + POST transport (Firefox primary; chrome/edge fallback) ---
//
// WebSocket doesn't work in Firefox because Firefox's HTTPS-Only Mode
// upgrades ws://localhost → wss://localhost (Mozilla Bug 1670581 — the
// localhost exemption applies to fetch but not to WebSocket, and the
// HTTPS-Only upgrader doesn't honor the mixed-content checker's localhost
// allowlist). HTTP fetch / EventSource to 127.0.0.1 is never upgraded, so
// we expose the same conversation as:
//   GET  /browser-bridge/events             → SSE stream (server → ext)
//   POST /browser-bridge/send?session=<id>  → ext → server
// First SSE frame sent by the server is `{"type":"session","sessionId":"…"}`
// so the extension can stamp subsequent POSTs with the right session token.
//
// Each SSE connection gets its own net.Socket-shaped shim (sseSessions map),
// fed into attachBrowserConn() with transport='sse' — downstream behavior
// is identical to WS.

interface SseSession {
  shim: net.Socket;
  res: http.ServerResponse;
  heartbeat: ReturnType<typeof setInterval> | null;
}
const sseSessions = new Map<string, SseSession>();
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Wrap an HTTP ServerResponse + a session id into a net.Socket-shaped facade
 * so attachBrowserConn() can consume it. Outbound writes are encoded as SSE
 * `data:` frames; inbound writes are emitted as `data` events by the
 * /browser-bridge/send POST handler (looked up via sessionId).
 */
function wrapSseAsSocket(res: http.ServerResponse, sessionId: string): net.Socket {
  const shim: any = new EventEmitter();
  shim.destroyed = false;

  shim.write = (data: string | Buffer) => {
    if (shim.destroyed) return false;
    try {
      const str = typeof data === 'string' ? data : data.toString('utf8');
      // Strip the line-delimited '\n' the attachBrowserConn parser uses —
      // SSE has its own framing (`data: ...\n\n`). One JSON message per
      // SSE event.
      const payload = str.endsWith('\n') ? str.slice(0, -1) : str;
      // Single-line JSON; if it contains literal newlines (shouldn't for
      // our protocol — we never serialize multi-line JSON) we collapse to
      // make sure SSE parses it as one event.
      const safe = payload.replace(/\n/g, ' ');
      res.write(`data: ${safe}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  shim.destroy = () => {
    if (shim.destroyed) return;
    shim.destroyed = true;
    const session = sseSessions.get(sessionId);
    if (session?.heartbeat) clearInterval(session.heartbeat);
    sseSessions.delete(sessionId);
    try { res.end(); } catch {}
  };

  shim.setKeepAlive = () => {};
  shim.setNoDelay = () => {};

  return shim as net.Socket;
}

/**
 * Mount the SSE + POST endpoints on the given HTTP server. Idempotent
 * (re-entry from a second call returns immediately).
 */
let sseAttached = false;
export function attachBrowserBridgeSse(httpServer: http.Server): void {
  if (sseAttached) return;
  sseAttached = true;

  httpServer.on('request', (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      // ─── GET /browser-bridge/events ────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/browser-bridge/events') {
        const origin = String(req.headers.origin || '');
        if (!isAllowedExtensionOrigin(origin)) {
          console.warn(`[BrowserBridge] SSE rejected: Origin=${origin || '(empty)'} not in whitelist`);
          res.writeHead(403); res.end(); return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',           // disable proxy/reverse-proxy buffering
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
        });

        const sessionId = randomUUID();
        const shim = wrapSseAsSocket(res, sessionId);
        const heartbeat = setInterval(() => {
          try { res.write(`:keepalive\n\n`); } catch {}
        }, SSE_HEARTBEAT_MS);
        sseSessions.set(sessionId, { shim, res, heartbeat });

        // First frame announces the session id so the extension knows what
        // to put in POST ?session=<id>.
        res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

        // Hand off to the shared connection handler. attachBrowserConn
        // wires its own data/close/error listeners on the shim.
        attachBrowserConn(shim, 'sse');

        req.on('close', () => {
          shim.destroy();
          shim.emit('close');
        });
        return;
      }

      // ─── POST /browser-bridge/send?session=<id> ────────────────────
      if (req.method === 'POST' && url.pathname === '/browser-bridge/send') {
        const origin = String(req.headers.origin || '');
        if (!isAllowedExtensionOrigin(origin)) {
          res.writeHead(403); res.end(); return;
        }
        const sessionId = url.searchParams.get('session') || '';
        const session = sseSessions.get(sessionId);
        if (!session) {
          res.writeHead(404, { 'Access-Control-Allow-Origin': origin });
          res.end('{"error":"unknown session"}');
          return;
        }
        let buf = '';
        req.on('data', chunk => { buf += chunk.toString('utf8'); });
        req.on('end', () => {
          if (buf.length > 0) {
            // attachBrowserConn parses newline-delimited JSON, so append \n
            // even though we send one POST = one message.
            if (!buf.endsWith('\n')) buf += '\n';
            session.shim.emit('data', Buffer.from(buf, 'utf8'));
          }
          res.writeHead(200, {
            'Access-Control-Allow-Origin': origin,
            'Content-Type': 'application/json',
          });
          res.end('{"ok":true}');
        });
        return;
      }

      // ─── OPTIONS preflight (CORS) ──────────────────────────────────
      // POSTs from extensions with non-trivial headers trigger a preflight.
      // Allow only our two routes.
      if (req.method === 'OPTIONS' &&
          (url.pathname === '/browser-bridge/events' || url.pathname === '/browser-bridge/send')) {
        const origin = String(req.headers.origin || '');
        if (!isAllowedExtensionOrigin(origin)) {
          res.writeHead(403); res.end(); return;
        }
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          // Firefox treats Cache-Control / Accept-Encoding etc. as
          // non-safelisted and would preflight them; advertise broad
          // permission so any extension-side header tweak doesn't cause
          // a silent CORS reject. The Origin gate above is the real
          // security boundary; CORS headers are just protocol plumbing.
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Cache-Control, X-Requested-With',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
    } catch (err) {
      console.error('[BrowserBridge] SSE handler error:', err);
      try { res.writeHead(500); res.end(); } catch {}
    }
    // Not our route — fall through (sidecar's other handlers will see it).
  });

  console.log('[BrowserBridge] SSE mounted at /browser-bridge/events + /browser-bridge/send (Origin-gated)');
}

// D1: 全局 stale-conn 扫描器 —— 每 30s 扫一遍 browserConns,任何 conn 60s
// 没收到 inbound message(包括 ext 那条 25s 间隔的 app-level ping)就视为死,
// 主动 destroy 触发 close handler 把它从 map 移除。
//
// 为什么 60s 阈值:ext 每 25s 发一个 ping,正常情况 2 个 ping 周期 = 50s 内
// 必有消息。留 60s 给 1 个 ping 的容忍(网络抖动 / 事件循环抖动 / ext SW
// 重启间隙)。再保守一档 90s 也行,但 60s 已经能在用户感知前清掉死 conn。
//
// 为什么 30s 间隔:扫描自身开销可忽略,30s 是"发现 → 清理"延迟的上限。
// 死 conn 最坏情况 60s 静默 + 30s 等下一次扫描 = 90s 内被剔除。
//
// 跟 B1 的关系:
//   - B1 治"命令在跑期间死" — 2 次连续 timeout(60s)触发 destroy
//   - D1 治"闲置期间死"     — 60s 没消息触发 destroy
//   合起来覆盖全场景。
let staleConnScanInterval: ReturnType<typeof setInterval> | null = null;
const STALE_CONN_THRESHOLD_MS = 60_000;
const STALE_CONN_SCAN_INTERVAL_MS = 30_000;

function startStaleConnScanner(): void {
  if (staleConnScanInterval) return;
  staleConnScanInterval = setInterval(() => {
    const now = Date.now();
    for (const conn of browserConns.values()) {
      if (conn.socket.destroyed) continue;
      // 刚连上(connectedAt 也 = lastInboundAt)还没 60s 的不扫,避免误杀
      // 还在握手的 conn。
      const silentMs = now - conn.lastInboundAt;
      if (silentMs > STALE_CONN_THRESHOLD_MS) {
        console.warn(`[BrowserBridge] conn ${conn.id} silent for ${Math.round(silentMs / 1000)}s (no ping/response/hello) — force-destroying to clear stale browserConns entry`);
        try { conn.socket.destroy(); } catch {}
      }
    }
  }, STALE_CONN_SCAN_INTERVAL_MS);
  // 让 Node 进程在没别的事时能正常退出 —— 不让这个 interval 锁住事件循环。
  // electron main process 一般有别的 keepalive(BrowserWindow / IPC),所以
  // unref 主要是给 sidecar 模式准备的。
  try { (staleConnScanInterval as any).unref?.(); } catch {}
}

function stopStaleConnScanner(): void {
  if (staleConnScanInterval) {
    clearInterval(staleConnScanInterval);
    staleConnScanInterval = null;
  }
}

/**
 * Single entry point: wire BOTH transports onto the given HTTP server.
 * Replaces the old startBrowserBridge() which used to spin up a separate
 * TCP listener for the Native Messaging host (removed in v2.8).
 */
export function attachBrowserBridge(httpServer: http.Server): void {
  attachBrowserBridgeWebSocket(httpServer);
  attachBrowserBridgeSse(httpServer);
  startStaleConnScanner();
  bridgeAttached = true;
  bridgePort = 18800;
  console.log('[BrowserBridge] Attached (ws + sse + stale-scanner) on shared HTTP server');
}

// --- Lifecycle ---
//
// v2.8: We no longer own a TCP listener. The two transports (ws + sse)
// are attached to the sidecar's existing HTTP server via attachBrowserBridge()
// above. stopBrowserBridge() therefore just tears down active connections
// + pending requests; it cannot stop the HTTP server itself.

export async function stopBrowserBridge(): Promise<void> {
  // D1: 先停扫描器,免得它在我们 destroy 这些 conn 之后还跑一次空扫描
  // (无害,但日志会噪)。
  stopStaleConnScanner();

  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Bridge shutting down'));
    pendingRequests.delete(id);
  }

  // Tear down every browser connection (multi-browser).
  for (const conn of browserConns.values()) {
    if (!conn.socket.destroyed) conn.socket.destroy();
  }
  browserConns.clear();

  // Close any lingering SSE sessions (in case attachBrowserConn's close
  // handler hasn't fired yet for them).
  for (const session of sseSessions.values()) {
    if (session.heartbeat) clearInterval(session.heartbeat);
    try { session.res.end(); } catch {}
  }
  sseSessions.clear();

  console.log('[BrowserBridge] Stopped (connections drained; HTTP server owned by sidecar continues)');
}

// --- Notify renderer ---

function notifyBridgeStatus(connected: boolean) {
  try {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.webContents.send('browser-bridge:status', { connected });
    }
  } catch {}
}

// --- Connection listeners (for auto-retry) ---

const connectionListeners: Array<() => void> = [];

export function onExtensionConnected(callback: () => void): () => void {
  connectionListeners.push(callback);
  return () => {
    const idx = connectionListeners.indexOf(callback);
    if (idx >= 0) connectionListeners.splice(idx, 1);
  };
}

function fireConnectionListeners() {
  const cbs = connectionListeners.splice(0);
  for (const cb of cbs) {
    try { cb(); } catch {}
  }
}

// --- Send command to extension ---

/**
 * Routing options for a command (multi-tab + multi-browser support).
 *   tabPattern: regex string. The bridge picks the connected browser whose
 *               cached open-tab list contains a URL matching the pattern.
 *               If multiple browsers match, the one with the most-recent
 *               activity wins. If none match, falls back to whichever
 *               browser saw the most recent activity (which then
 *               findOrOpenTabByPattern in that browser will auto-open the
 *               anchor URL).
 *   When omitted: pre-multi-browser fallback — most-recently-active conn.
 */
export interface SendBrowserCommandOptions {
  tabPattern?: string;
  /** v2.6+: explicit tab-group label/color for the chrome-extension to use
   *  when grouping the resolved tab. The extension was previously
   *  hardcoding URL→{title,color} mappings, which forced an extension
   *  release every time we added a new platform. Now the client owns the
   *  map (PLATFORM_TAB_GROUPS) and passes the right value with every
   *  command. Old extensions simply ignore the field — backwards compat. */
  tabGroup?: { title: string; color: string };
  /** v1.4.0+: opt into the extension's per-platform isolated-window mode.
   *  Only set this when the target connection advertises the
   *  'isolated_windows' capability — older extensions ignore the flag, so
   *  setting it unconditionally is harmless but would be misleading.
   *  Callers typically derive this via connectionHasCapability(). */
  isolate?: boolean;
  /** v1.4.2+: anchor URL for the platform, read from manifest.anchor_url.
   *  Sent with every routed command so the extension doesn't need a
   *  hardcoded platform → URL map. Adding a new platform now means
   *  updating its scenario manifest only — no extension republish.
   *  Older extensions ignore unknown envelope fields and fall back to
   *  their own anchorUrlFor table for the legacy 3 platforms. */
  anchor_url?: string;
}

/** v1.4.0+: does the connection that would receive a command for this
 *  tabPattern advertise the given capability? Lets callers decide whether
 *  to set protocol-extension fields on the envelope. Returns false when
 *  no connection exists (caller will hit BROWSER_NOT_CONNECTED anyway). */
export function connectionHasCapability(tabPattern: string | undefined, cap: string): boolean {
  const conn = pickConnForPattern(tabPattern);
  return !!conn && conn.capabilities.has(cap);
}

/** Pick the browser connection that should receive a command. */
function pickConnForPattern(tabPattern: string | undefined): BrowserConn | null {
  const conns = Array.from(browserConns.values()).filter(c => !c.socket.destroyed);
  if (conns.length === 0) return null;
  if (conns.length === 1) return conns[0];

  if (tabPattern) {
    let pattern: RegExp;
    try { pattern = new RegExp(tabPattern); }
    catch { return conns.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]; }
    // Prefer a connection that already has a matching tab open.
    const matching = conns.filter(c => c.tabs.some(t => pattern.test(t.url || '')));
    if (matching.length > 0) {
      return matching.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    }
    // No browser has the right tab — fall through to "most-recent" so the
    // extension can auto-open the anchor URL in that browser. (This means
    // Twitter task tries to open x.com in browser A even if user prefers
    // browser B; can revisit if it's annoying. For now: predictable.)
  }

  return conns.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
}

export function sendBrowserCommand(
  command: string,
  params: Record<string, any> = {},
  timeoutMs = 30000,
  options: SendBrowserCommandOptions = {}
): Promise<any> {
  return new Promise((resolve, reject) => {
    const conn = pickConnForPattern(options.tabPattern);
    if (!conn) {
      reject(new Error('BROWSER_NOT_CONNECTED'));
      return;
    }

    const id = randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      // B1: 真正接上 consecutiveTimeouts —— 这条 conn 又超时一次,累加。
      // 满 2 次连续超时(中间没收到任何成功响应)就视为死,主动 destroy 触发
      // 'close' handler 把它从 browserConns 移除。下一次 sendBrowserCommand
      // 的 pickConnForPattern 不会再选它,renderer 那边状态自然变 fail。
      // 修之前:字段一直挂着但没人 ++,死 conn 永远是 0,每个新命令都被路由
      // 到死 conn → 30s timeout 循环。
      conn.consecutiveTimeouts += 1;
      if (conn.consecutiveTimeouts >= 2 && !conn.socket.destroyed) {
        console.warn(`[BrowserBridge] conn ${conn.id} hit ${conn.consecutiveTimeouts} consecutive timeouts on "${command}" — force-destroying socket so a fresh extension reconnect replaces it`);
        try { conn.socket.destroy(); } catch {}
      }
      reject(new Error(`Browser command "${command}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });

    // Wire envelope. tabPattern + tabGroup are both optional — old
    // extensions that don't know about either simply ignore the fields.
    // New extensions (1.2.21+) prefer `tabGroup` for grouping and fall
    // back to their hardcoded platformLabelForPattern when only
    // tabPattern is sent.
    const envelope: Record<string, any> = { id, command, params };
    if (options.tabPattern) envelope.tabPattern = options.tabPattern;
    if (options.tabGroup) envelope.tabGroup = options.tabGroup;
    if (options.isolate) envelope.isolate = true;
    if (options.anchor_url) envelope.anchor_url = options.anchor_url;

    conn.lastActivityAt = Date.now();
    conn.socket.write(JSON.stringify(envelope) + '\n');
  });
}
