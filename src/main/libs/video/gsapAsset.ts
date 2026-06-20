/**
 * gsapAsset — 读出随包 vendor 的 GSAP 源码字符串,供「AI 自由排版」(ai_freeform)
 * 把 GSAP 内联进无头渲染的场景 HTML。
 *
 * 为什么内联而不是 CDN:htmlVideoRenderer 把所有网络封死(Network.setBlockedURLs
 * http/https/ws/wss),离线渲染拿不到外网资源 —— 必须把 ~72KB 的 gsap.min.js 当字符串
 * 注入 <script>。
 *
 * 路径探测套用 bgm.ts.bundledBgmDirs 的同款多根逻辑(packaged + dev fallback + sidecar),
 * 命中后缓存到内存(进程内只读一次)。文件随 prepare-tauri-resources.js 第 9 步打包到
 * <resources>/gsap/gsap.min.js。
 */

import path from 'path';
import fs from 'fs';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';

let _cached: string | null = null;
let _missingLogged = false;

/** GSAP 源码可能落地的目录集合(同 bgm.bundledBgmDirs 的多根探测,子目录 gsap)。 */
function bundledGsapDirs(): string[] {
  const dirs: string[] = [];
  const pushRoot = (root: string): number => dirs.push(path.join(root, 'gsap'));
  if (isPackaged()) {
    const res = getResourcesPath();
    const exeDir = path.dirname(process.execPath);
    pushRoot(res);
    pushRoot(path.join(res, 'resources'));
    pushRoot(path.join(exeDir, 'resources'));
    pushRoot(path.join(exeDir, '..', 'Resources'));
    pushRoot(path.join(exeDir, '..', 'Resources', 'resources'));
  }
  // Dev / sidecar fallback(isPackaged 在 sidecar 里恒 true,但 prepare 脚本是 CI-only):
  // 也探测 committed 源 client/resources/gsap,从本文件和 cwd 往上走。真实安装里这些目录
  // 不存在,existsSync 直接跳过。
  for (const base of [
    path.resolve(__dirname, '..', '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
    process.cwd(),
    path.join(process.cwd(), 'client'),
  ]) {
    pushRoot(path.join(base, 'resources'));
  }
  pushRoot(path.join(getUserDataPath(), 'runtimes'));
  return dirs;
}

/**
 * 取 GSAP 源码字符串(进程内缓存)。找不到返回 null —— 调用方据此降级为「不用 GSAP」
 * (ai_freeform 仍可只用 data-* 协议出片)。绝不抛。
 */
export function loadGsapSource(): string | null {
  if (_cached !== null) return _cached;
  const probed = bundledGsapDirs();
  for (const dir of probed) {
    const p = path.join(dir, 'gsap.min.js');
    try {
      if (fs.existsSync(p)) {
        const src = fs.readFileSync(p, 'utf8');
        if (src && src.length > 1000) { _cached = src; return _cached; }
      }
    } catch { /* keep probing */ }
  }
  if (!_missingLogged) {
    _missingLogged = true;
    try {
      console.warn('[gsapAsset] gsap.min.js not found. packaged=' + isPackaged()
        + ' resources=' + getResourcesPath()
        + ' probed=' + JSON.stringify(probed.map((d) => d + (fs.existsSync(d) ? ' [dir✓]' : ''))));
    } catch { /* ignore */ }
  }
  return null;
}

/** GSAP 是否可用(随包文件存在)。 */
export function isGsapAvailable(): boolean {
  return loadGsapSource() !== null;
}
