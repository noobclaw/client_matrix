/**
 * 指纹内核安装器(B1:按需下载,走自家 OSS,国内可达)。
 *
 * 不 bundle 进包(包小、可多版本)。首次使用时从后端下发的 OSS 地址下载内核,
 * 解压到 userData/runtimes/fingerprint-chromium-<platform>/,之后复用。
 *   · win:下 .zip → Expand-Archive → chrome.exe
 *   · mac:下 .dmg → hdiutil 挂载 → 拷 Chromium.app → 卸载
 * 下载的内核不在 app 包里 → 不参与公证;运行时 spawn 直接拉起(不过 Gatekeeper)。
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getUserDataPath } from '../platformAdapter';
import { coworkLog } from '../coworkLogger';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }

const PLAT = process.platform === 'win32' ? 'fingerprint-chromium-win'
  : process.platform === 'darwin' ? 'fingerprint-chromium-mac' : 'fingerprint-chromium-linux';

function runtimesDir(): string { return path.join(getUserDataPath(), 'runtimes'); }
function kernelDir(): string { return path.join(runtimesDir(), PLAT); }

export function installedKernelPath(): string | null {
  const d = kernelDir();
  const exe = process.platform === 'win32' ? path.join(d, 'chrome.exe')
    : process.platform === 'darwin' ? path.join(d, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    : path.join(d, 'chrome');
  try { return fs.existsSync(exe) ? exe : null; } catch { return null; }
}

async function kernelUrl(): Promise<{ url: string; version: string } | null> {
  try {
    const r = await fetch(`${baseUrl()}/api/matrix/kernel`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j: any = await r.json();
    const url = process.platform === 'win32' ? j.win : process.platform === 'darwin' ? j.mac : '';
    return url ? { url: String(url), version: String(j.version || '') } : null;
  } catch { return null; }
}

function findFile(dir: string, name: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(full, name); if (hit) return hit; }
    else if (e.name.toLowerCase() === name.toLowerCase()) return full;
  }
  return null;
}
function findDirEndingWith(dir: string, suffix: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.toLowerCase().endsWith(suffix)) return path.join(dir, e.name);
      const hit = findDirEndingWith(path.join(dir, e.name), suffix);
      if (hit) return hit;
    }
  }
  return null;
}

type ProgressFn = (pct: number, msg: string) => void;

async function download(url: string, dest: string, onProgress?: ProgressFn): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok || !res.body) { onProgress?.(0, `下载失败 HTTP ${res.status}`); return false; }
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  let got = 0, lastPct = -1;
  const reader = (res.body as any).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    if (total) {
      const pct = Math.round((got / total) * 100);
      if (pct !== lastPct) { lastPct = pct; onProgress?.(pct, `下载内核 ${Math.round(got / 1048576)}/${Math.round(total / 1048576)}MB`); }
    }
  }
  await new Promise<void>((r) => out.end(() => r()));
  return true;
}

/** 确保内核就绪(已装则直接返回路径;否则下载+解压)。返回内核可执行路径或 null。 */
export async function ensureKernel(onProgress?: ProgressFn): Promise<string | null> {
  const have = installedKernelPath();
  if (have) { onProgress?.(100, '内核已就绪'); return have; }

  const info = await kernelUrl();
  if (!info) { onProgress?.(0, '后端未配置内核下载地址(matrix_kernel_url_*)'); return null; }

  fs.mkdirSync(runtimesDir(), { recursive: true });
  const tmp = path.join(runtimesDir(), process.platform === 'win32' ? '_k.zip' : '_k.dmg');
  onProgress?.(0, '开始下载指纹内核…');
  try {
    const ok = await download(info.url, tmp, onProgress);
    if (!ok) return null;
    onProgress?.(100, '下载完成,正在解压…');

    const d = kernelDir();
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });

    if (process.platform === 'win32') {
      spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${tmp}' -DestinationPath '${d}' -Force`], { stdio: 'ignore' });
      const chromeExe = findFile(d, 'chrome.exe');
      if (chromeExe && path.dirname(chromeExe) !== d) {
        // zip 里多套了一层目录 → 把内核目录内容上移到 d 根
        const inner = path.dirname(chromeExe);
        for (const e of fs.readdirSync(inner)) fs.renameSync(path.join(inner, e), path.join(d, e));
      }
    } else if (process.platform === 'darwin') {
      const mnt = path.join(runtimesDir(), '_mnt');
      fs.mkdirSync(mnt, { recursive: true });
      spawnSync('hdiutil', ['attach', tmp, '-nobrowse', '-readonly', '-mountpoint', mnt], { stdio: 'ignore' });
      try {
        const app = findDirEndingWith(mnt, '.app');
        if (app) {
          spawnSync('cp', ['-R', app, path.join(d, 'Chromium.app')], { stdio: 'ignore' });
          const macos = path.join(d, 'Chromium.app', 'Contents', 'MacOS');
          if (fs.existsSync(macos) && !fs.existsSync(path.join(macos, 'Chromium'))) {
            const first = fs.readdirSync(macos)[0];
            if (first) spawnSync('ln', ['-sf', first, path.join(macos, 'Chromium')], { stdio: 'ignore' });
          }
        }
      } finally {
        spawnSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' });
      }
      spawnSync('xattr', ['-cr', path.join(d, 'Chromium.app')], { stdio: 'ignore' });
      const exe = path.join(d, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
      try { fs.chmodSync(exe, 0o755); } catch { /* ignore */ }
    }

    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    const exe = installedKernelPath();
    onProgress?.(100, exe ? `内核就绪 (${info.version || 'kernel'})` : '解压后未找到内核(格式异常)');
    if (!exe) coworkLog('ERROR', 'kernelInstaller', 'kernel exe not found after extract');
    return exe;
  } catch (e: any) {
    onProgress?.(0, '内核安装失败:' + String(e?.message || e).slice(0, 100));
    coworkLog('ERROR', 'kernelInstaller', 'ensureKernel failed', { err: String(e) });
    return null;
  }
}
