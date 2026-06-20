/**
 * 指纹内核连接池 —— 矩阵号的命门基础设施。
 *
 * 按 accountId 起多个 fingerprint-chromium 实例(一号一实例:固定指纹种子 +
 * 持久 user-data-dir + 绑定代理 + 独立 debug-port),各自一条 CDP 连接。
 * 发布 driver 只认 ctx.cmd(),与浏览器实现解耦 → 把 driver 的浏览器命令路由到
 * 这里对应 accountId 的 CDP 会话,现有 driver 一行不改即可在指纹内核里跑。
 *
 * 与单实例的 cdpBrowser.ts 区别:这里是 Map<accountId, session> 的池,且每个
 * 会话有【独立的消息 id 空间与 pending 表】,避免多实例间 CDP 响应串话。
 *
 * 内核选型:adryfish/fingerprint-chromium(BSD-3,引擎级指纹)。MVP 阶段内核
 * 二进制还没 bundle 时,可传普通 Chrome 路径先验证连接池+driver 链路(指纹 flag
 * 会被普通 Chrome 忽略,不影响管线验证)。
 */

import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { coworkLog } from '../coworkLogger';
import type { Fingerprint, Proxy } from './types';

export interface KernelSession {
  accountId: string;
  process: ChildProcess | null;
  debugPort: number;
  userDataDir: string;
  pageWs: WebSocket | null;       // 当前操作的 page 连接
  pageTargetId: string | null;
  msgId: number;                  // 本会话独立 id 空间
  pending: Map<number, { resolve: (d: any) => void; reject: (e: Error) => void }>;
}

export interface LaunchKernelOptions {
  accountId: string;
  kernelPath?: string;            // fingerprint-chromium 路径;缺省回落到普通 Chrome(仅 MVP 验证用)
  userDataDir: string;            // 持久 profile 目录
  fingerprint: Fingerprint;
  proxy?: Proxy;
  headless?: boolean;
}

const sessions = new Map<string, KernelSession>();
let nextDebugPort = 9300;        // 每号一个端口,递增分配

// ── 内核/浏览器路径探测(MVP 回落用) ──

function detectChromePath(): string | null {
  const c: string[] = [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pfx = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || '';
    c.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pfx, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    c.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    c.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium');
  }
  for (const p of c) if (fs.existsSync(p)) return p;
  return null;
}

// ── 启动参数:指纹 + 代理 + 防泄漏 ──

function buildKernelArgs(opts: LaunchKernelOptions, debugPort: number): string[] {
  const { fingerprint: fp, proxy } = opts;
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 引擎级指纹(fingerprint-chromium;普通 Chrome 会忽略这些 flag)
    `--fingerprint=${fp.seed}`,
  ];
  if (fp.platformOs) args.push(`--fingerprint-platform=${fp.platformOs}`);
  if (fp.brand) args.push(`--fingerprint-brand=${fp.brand}`);
  if (fp.hardwareConcurrency) args.push(`--fingerprint-hardware-concurrency=${fp.hardwareConcurrency}`);
  if (fp.lang) { args.push(`--lang=${fp.lang}`, `--accept-lang=${fp.lang}`); }
  if (fp.timezone) args.push(`--timezone=${fp.timezone}`);

  if (proxy) {
    // 带 auth 的代理走本地中转端口(Chromium --proxy-server 不支持内联账密);
    // 无 auth 直连。socks5h 在 chromium 里用 socks5(socks5 默认远程 DNS)。
    const scheme = proxy.protocol === 'socks5h' ? 'socks5' : proxy.protocol;
    if (proxy.username && proxy.localBridgePort) {
      args.push(`--proxy-server=socks5://127.0.0.1:${proxy.localBridgePort}`);
    } else {
      if (proxy.username) {
        coworkLog('WARN', 'kernelPool', `proxy for ${opts.accountId} has auth but no localBridgePort; auth not applied (MVP)`);
      }
      args.push(`--proxy-server=${scheme}://${proxy.host}:${proxy.port}`);
    }
    // 防 WebRTC 漏真实 IP(fingerprint-chromium flag)
    args.push('--disable-non-proxied-udp');
  }

  if (opts.headless) args.push('--headless=new');
  return args;
}

// ── 启动一个号的内核实例 ──

export async function launchKernel(opts: LaunchKernelOptions): Promise<KernelSession> {
  const existing = sessions.get(opts.accountId);
  if (existing && existing.process && !existing.process.killed) {
    coworkLog('INFO', 'kernelPool', `reuse kernel for ${opts.accountId}`);
    return existing;
  }

  const kernelPath = opts.kernelPath || detectChromePath();
  if (!kernelPath) throw new Error('fingerprint-chromium / Chrome not found');

  if (!fs.existsSync(opts.userDataDir)) fs.mkdirSync(opts.userDataDir, { recursive: true });

  const debugPort = existing?.debugPort ?? nextDebugPort++;
  const args = buildKernelArgs(opts, debugPort);

  coworkLog('INFO', 'kernelPool', `launch kernel ${opts.accountId}`, { debugPort, seed: opts.fingerprint.seed });
  const proc = spawn(kernelPath, args, { detached: false, stdio: 'ignore' });
  proc.on('error', (err) => coworkLog('ERROR', 'kernelPool', `kernel ${opts.accountId} error: ${err.message}`));

  // 等调试端口起来
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (r.ok) { ready = true; break; }
    } catch { /* not ready */ }
  }
  if (!ready) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error(`kernel ${opts.accountId} failed to open debug port ${debugPort}`);
  }

  const session: KernelSession = {
    accountId: opts.accountId,
    process: proc,
    debugPort,
    userDataDir: opts.userDataDir,
    pageWs: null,
    pageTargetId: null,
    msgId: 1,
    pending: new Map(),
  };
  sessions.set(opts.accountId, session);
  coworkLog('INFO', 'kernelPool', `kernel ${opts.accountId} ready on ${debugPort}`);
  return session;
}

// ── 单会话 CDP 通信(每会话独立 id 空间) ──

async function getPage(accountId: string): Promise<KernelSession> {
  const s = sessions.get(accountId);
  if (!s) throw new Error(`no kernel session for ${accountId}`);
  if (s.pageWs && s.pageWs.readyState === WebSocket.OPEN) return s;

  const list: any[] = await (await fetch(`http://127.0.0.1:${s.debugPort}/json/list`)).json();
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    target = await (await fetch(`http://127.0.0.1:${s.debugPort}/json/new`)).json();
  }
  s.pageTargetId = target.id;

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${s.debugPort}/devtools/page/${target.id}`);
    sock.on('open', () => resolve(sock));
    sock.on('error', (e) => reject(e));
    sock.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && s.pending.has(msg.id)) {
          const h = s.pending.get(msg.id)!;
          s.pending.delete(msg.id);
          msg.error ? h.reject(new Error(msg.error.message)) : h.resolve(msg.result);
        }
      } catch { /* ignore */ }
    });
  });
  s.pageWs = ws;
  await send(s, 'Page.enable');
  return s;
}

function send(s: KernelSession, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = s.msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    s.pending.set(id, {
      resolve: (d) => { clearTimeout(timer); resolve(d); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    s.pageWs!.send(JSON.stringify({ id, method, params }));
  });
}

// ── 高层操作(按 accountId) ──

export async function kernelNavigate(accountId: string, url: string): Promise<void> {
  const s = await getPage(accountId);
  await send(s, 'Page.navigate', { url });
  await sleep(1000);
}

export async function kernelEval(accountId: string, expression: string): Promise<any> {
  const s = await getPage(accountId);
  const r = await send(s, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
}

export async function kernelClick(accountId: string, x: number, y: number): Promise<void> {
  const s = await getPage(accountId);
  await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/**
 * 原生文件注入 —— 把本地文件直接灌进 file input(CDP DOM.setFileInputFiles)。
 * 比扩展的 upload_file_from_url(注册本地 HTTP + fetch blob)干净:CDP 直接给
 * 元素 objectId + 本地路径,内核侧零网络。返回是否成功。
 */
export async function kernelSetFileInput(accountId: string, selector: string, filePaths: string[]): Promise<boolean> {
  const s = await getPage(accountId);
  const evalRes = await send(s, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  const objectId = evalRes?.result?.objectId;
  if (!objectId) return false;
  await send(s, 'DOM.setFileInputFiles', { files: filePaths, objectId });
  return true;
}

// ── 生命周期 ──

export function getSession(accountId: string): KernelSession | undefined {
  return sessions.get(accountId);
}

export function listSessions(): string[] {
  return Array.from(sessions.keys());
}

export function closeKernel(accountId: string): void {
  const s = sessions.get(accountId);
  if (!s) return;
  try { s.pageWs?.close(); } catch { /* ignore */ }
  try { if (s.process && !s.process.killed) s.process.kill(); } catch { /* ignore */ }
  sessions.delete(accountId);
  coworkLog('INFO', 'kernelPool', `closed kernel ${accountId}`);
}

export function closeAllKernels(): void {
  for (const id of Array.from(sessions.keys())) closeKernel(id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
