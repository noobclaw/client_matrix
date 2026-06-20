/**
 * Native Desktop Windows — bridge to the pre-compiled C++ addon at
 * `native/win-desktop/src/noobclaw_desktop_win.cc`.
 *
 * Gives the Windows sidecar real Win32 SendInput / BitBlt /
 * clipboard APIs instead of the slow PowerShell subprocess fallbacks
 * in desktopControlMcp.ts. Screenshots go from ~500ms (Add-Type +
 * System.Drawing) to ~30-80ms. Mouse/keyboard input goes from
 * ~100-200ms (subprocess spawn) to sub-millisecond.
 *
 * Build pipeline (symmetrical with the macOS `.mm` addon):
 *   1. CI Windows job runs `cd native/win-desktop && node-gyp rebuild`.
 *   2. prepare-tauri-resources.js copies the resulting .node file to
 *      src-tauri/resources/native/noobclaw_desktop_win.node.
 *   3. Tauri bundles it via the `resources` glob into the install dir.
 *   4. At runtime this loader walks a candidate list and require()s
 *      the first file that exists. Silent fallback to null on any
 *      error so desktopControlMcp reverts to PowerShell.
 *
 * Runtime permissions: none. Windows UIPI may prevent injecting input
 * into elevated windows if NoobClaw itself isn't elevated — that's
 * the same constraint any automation tool has.
 */

import path from 'path';
import fs from 'fs';
import { coworkLog } from './coworkLogger';
import { getResourcesPath } from './platformAdapter';

// ── Types — mirror the macOS addon where applicable ──

export interface NativeScreenshotResult {
  data: Buffer;
  width: number;
  height: number;
  format: 'jpeg' | 'png';
}

export interface NativeWinWindowInfo {
  title: string;
  className: string;
  pid: number;
}

export type NativeWinPowerEvent = 'willSleep' | 'didWake';

export interface NativeDesktopWinModule {
  screenshot(options?: { quality?: number; format?: 'jpeg' | 'png' }): NativeScreenshotResult;
  mouseMove(x: number, y: number, options?: { durationMs?: number }): void;
  mouseClick(x: number, y: number, button?: 'left' | 'right' | 'middle', clickCount?: number): void;
  keyType(text: string): void;
  keyPress(key: string, modifiers?: string[]): void;
  clipboardGet(): string;
  clipboardSet(text: string): boolean;
  clipboardVerify(expected: string): boolean;
  getActiveWindow(): NativeWinWindowInfo | null;
  listWindows(): NativeWinWindowInfo[];
  /**
   * Register a callback for Windows power-state transitions via
   * PowerRegisterSuspendResumeNotification. The callback receives
   * `willSleep` before the system suspends and `didWake` after it
   * resumes. Only one subscription is active at a time — calling
   * again replaces the previous callback. Returns true if the OS
   * subscription was created successfully, false otherwise.
   */
  onPowerEvent(callback: (kind: NativeWinPowerEvent) => void): boolean;
}

// ── Loader ──

let nativeModule: NativeDesktopWinModule | null = null;
let loadAttempted = false;

function candidateAddonPaths(): string[] {
  const exeDir = path.dirname(process.execPath);
  const resourcesDir = getResourcesPath();
  return [
    // Tauri prod: bundled into resources glob
    path.join(resourcesDir, 'native', 'noobclaw_desktop_win.node'),
    path.join(resourcesDir, 'resources', 'native', 'noobclaw_desktop_win.node'),
    // Next to the sidecar .exe
    path.join(exeDir, 'native', 'noobclaw_desktop_win.node'),
    path.join(exeDir, 'noobclaw_desktop_win.node'),
    path.join(exeDir, 'resources', 'native', 'noobclaw_desktop_win.node'),
    // Dev / repo-checkout build output
    path.join(__dirname, '..', '..', '..', 'native', 'win-desktop', 'build', 'Release', 'noobclaw_desktop_win.node'),
    path.join(__dirname, '..', '..', '..', '..', 'native', 'win-desktop', 'build', 'Release', 'noobclaw_desktop_win.node'),
  ];
}

export function loadNativeDesktopWinModule(): NativeDesktopWinModule | null {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;
  if (process.platform !== 'win32') return null;

  const tried: string[] = [];
  for (const candidate of candidateAddonPaths()) {
    tried.push(candidate);
    try {
      if (fs.existsSync(candidate)) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(candidate) as NativeDesktopWinModule;
        if (typeof (mod as any).screenshot === 'function' && typeof (mod as any).mouseMove === 'function') {
          nativeModule = mod;
          coworkLog('INFO', 'nativeDesktopWin', `Native module loaded from ${candidate}`);
          return nativeModule;
        }
        coworkLog('WARN', 'nativeDesktopWin', `Addon at ${candidate} missing required exports`);
      }
    } catch (e: any) {
      coworkLog('WARN', 'nativeDesktopWin', `require(${candidate}) failed: ${e?.message || e}`);
    }
  }

  coworkLog('INFO', 'nativeDesktopWin', 'Native Win module not found, falling back to PowerShell. Tried: ' + tried.join(' | '));
  return null;
}

export function hasNativeDesktopWin(): boolean {
  return loadNativeDesktopWinModule() !== null;
}

export function nativeWinScreenshot(quality: number = 0.75): Buffer | null {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return null;
  try {
    const r = mod.screenshot({ quality, format: 'jpeg' });
    return r.data;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopWin', `Native Win screenshot failed: ${e}`);
    return null;
  }
}

export function nativeWinMouseMove(x: number, y: number, durationMs: number = 0): boolean {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return false;
  try {
    mod.mouseMove(x, y, { durationMs });
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopWin', `Native Win mouseMove failed: ${e}`);
    return false;
  }
}

export function nativeWinMouseClick(
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle' = 'left',
  clicks: number = 1,
): boolean {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return false;
  try {
    mod.mouseClick(x, y, button, clicks);
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopWin', `Native Win mouseClick failed: ${e}`);
    return false;
  }
}

export function nativeWinKeyType(text: string): boolean {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return false;
  try {
    mod.keyType(text);
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopWin', `Native Win keyType failed: ${e}`);
    return false;
  }
}

export function nativeWinKeyPress(key: string, modifiers: string[] = []): boolean {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return false;
  try {
    mod.keyPress(key, modifiers);
    return true;
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopWin', `Native Win keyPress failed: ${e}`);
    return false;
  }
}

export function nativeWinClipboardGet(): string | null {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return null;
  try { return mod.clipboardGet(); } catch { return null; }
}

export function nativeWinClipboardSet(text: string): boolean {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return false;
  try { return mod.clipboardSet(text); } catch { return false; }
}

export function nativeWinGetActiveWindow(): NativeWinWindowInfo | null {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return null;
  try { return mod.getActiveWindow(); } catch { return null; }
}

export function nativeWinListWindows(): NativeWinWindowInfo[] | null {
  const mod = loadNativeDesktopWinModule();
  if (!mod) return null;
  try { return mod.listWindows(); } catch { return null; }
}

/**
 * Register a callback fired when the system is about to suspend
 * ("willSleep") or has just resumed ("didWake"). Mirrors the macOS
 * `nativeOnPowerEvent` API so sidecar-server.ts can share the same
 * pause/resume plumbing on both platforms. Returns false if the
 * native addon isn't loaded or the Windows subscription failed —
 * sidecar-server should treat this as "platform has no power events"
 * and skip the pause/resume dance.
 */
export function nativeWinOnPowerEvent(
  callback: (kind: NativeWinPowerEvent) => void,
): boolean {
  const mod = loadNativeDesktopWinModule();
  if (!mod || typeof (mod as any).onPowerEvent !== 'function') return false;
  try {
    return mod.onPowerEvent(callback);
  } catch (e) {
    coworkLog('WARN', 'nativeDesktopWin', `Native Win onPowerEvent failed: ${e}`);
    return false;
  }
}
