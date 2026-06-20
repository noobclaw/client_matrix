/**
 * macOS Native Browser Bridge — controls Chrome/Safari via AppleScript.
 * Serves as a fallback when the browser extension is not installed.
 * Only works on macOS.
 *
 * Capabilities:
 * - Navigate to URL
 * - Get page URL and title
 * - Execute JavaScript in browser tab
 * - Get page text content
 * - Screenshot (via screencapture)
 */

import { spawnSync } from 'child_process';
import { coworkLog } from './coworkLogger';
import path from 'path';
import os from 'os';

const IS_MAC = process.platform === 'darwin';

function runOsa(script: string): { ok: boolean; output: string } {
  if (!IS_MAC) return { ok: false, output: 'Not macOS' };
  try {
    const result = spawnSync('osascript', ['-e', script], {
      timeout: 15000, encoding: 'utf8',
    });
    if (result.status === 0) {
      return { ok: true, output: result.stdout?.trim() || '' };
    }
    return { ok: false, output: result.stderr?.trim() || 'osascript failed' };
  } catch (e) {
    return { ok: false, output: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function runOsaMultiline(script: string): { ok: boolean; output: string } {
  if (!IS_MAC) return { ok: false, output: 'Not macOS' };
  try {
    const result = spawnSync('osascript', ['-'], {
      input: script,
      timeout: 15000,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      return { ok: true, output: result.stdout?.trim() || '' };
    }
    return { ok: false, output: result.stderr?.trim() || 'osascript failed' };
  } catch (e) {
    return { ok: false, output: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Detect which browser is running */
function detectActiveBrowser(): 'chrome' | 'safari' | null {
  // Prefer Chrome if running
  const chrome = runOsa('tell application "System Events" to (name of processes) contains "Google Chrome"');
  if (chrome.ok && chrome.output === 'true') return 'chrome';

  const safari = runOsa('tell application "System Events" to (name of processes) contains "Safari"');
  if (safari.ok && safari.output === 'true') return 'safari';

  return null;
}

/** Get the frontmost browser or launch Chrome */
function getBrowser(): 'chrome' | 'safari' {
  const active = detectActiveBrowser();
  if (active) return active;
  // Launch Chrome
  runOsa('tell application "Google Chrome" to activate');
  return 'chrome';
}

function chromeAppName(): string { return 'Google Chrome'; }
function safariAppName(): string { return 'Safari'; }

// ── Public API ──

export function isAvailable(): boolean {
  return IS_MAC;
}

export function navigate(url: string): { ok: boolean; message: string } {
  const browser = getBrowser();
  let result;
  if (browser === 'chrome') {
    result = runOsa(`tell application "${chromeAppName()}" to set URL of active tab of front window to "${url.replace(/"/g, '\\"')}"`);
  } else {
    result = runOsa(`tell application "${safariAppName()}" to set URL of current tab of front window to "${url.replace(/"/g, '\\"')}"`);
  }
  if (result.ok) return { ok: true, message: `Navigated to ${url} in ${browser}` };
  // Try opening URL as new tab
  if (browser === 'chrome') {
    result = runOsaMultiline(`
tell application "${chromeAppName()}"
  activate
  open location "${url.replace(/"/g, '\\"')}"
end tell`);
  } else {
    result = runOsaMultiline(`
tell application "${safariAppName()}"
  activate
  open location "${url.replace(/"/g, '\\"')}"
end tell`);
  }
  return result.ok
    ? { ok: true, message: `Opened ${url} in ${browser}` }
    : { ok: false, message: result.output };
}

export function getPageInfo(): { url: string; title: string } | null {
  const browser = getBrowser();
  let url: string, title: string;
  if (browser === 'chrome') {
    const urlRes = runOsa(`tell application "${chromeAppName()}" to get URL of active tab of front window`);
    const titleRes = runOsa(`tell application "${chromeAppName()}" to get title of active tab of front window`);
    url = urlRes.output;
    title = titleRes.output;
  } else {
    const urlRes = runOsa(`tell application "${safariAppName()}" to get URL of current tab of front window`);
    const titleRes = runOsa(`tell application "${safariAppName()}" to get name of current tab of front window`);
    url = urlRes.output;
    title = titleRes.output;
  }
  return url ? { url, title } : null;
}

export function executeJavaScript(code: string): { ok: boolean; result: string } {
  const browser = getBrowser();
  // Escape for AppleScript
  const escaped = code.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  let result;
  if (browser === 'chrome') {
    result = runOsa(`tell application "${chromeAppName()}" to execute active tab of front window javascript "${escaped}"`);
  } else {
    result = runOsa(`tell application "${safariAppName()}" to do JavaScript "${escaped}" in current tab of front window`);
  }
  return { ok: result.ok, result: result.output };
}

export function getPageText(): string {
  const js = 'document.body.innerText.substring(0, 10000)';
  const result = executeJavaScript(js);
  return result.ok ? result.result : '';
}

export function screenshotBrowser(): string | null {
  // Use macOS screencapture to capture the frontmost window
  const tmpPath = path.join(os.tmpdir(), `noobclaw-mac-screenshot-${Date.now()}.png`);
  try {
    const result = spawnSync('screencapture', ['-l', getWindowId() || '', tmpPath], {
      timeout: 10000, encoding: 'utf8',
    });
    if (result.status === 0) return tmpPath;
  } catch {}

  // Fallback: capture entire screen
  try {
    spawnSync('screencapture', ['-x', tmpPath], { timeout: 10000 });
    return tmpPath;
  } catch {}
  return null;
}

function getWindowId(): string {
  // Get the window ID of the frontmost browser window for targeted capture
  const browser = getBrowser();
  const appName = browser === 'chrome' ? chromeAppName() : safariAppName();
  const result = runOsa(`tell application "System Events" to get id of front window of process "${appName}"`);
  return result.ok ? result.output : '';
}

export function listTabs(): Array<{ index: number; url: string; title: string }> {
  const browser = getBrowser();
  const tabs: Array<{ index: number; url: string; title: string }> = [];

  if (browser === 'chrome') {
    const result = runOsaMultiline(`
tell application "${chromeAppName()}"
  set tabList to ""
  repeat with t in tabs of front window
    set tabList to tabList & (URL of t) & "|||" & (title of t) & "\\n"
  end repeat
  return tabList
end tell`);
    if (result.ok) {
      result.output.split('\n').forEach((line, i) => {
        const [url, title] = line.split('|||');
        if (url) tabs.push({ index: i + 1, url, title: title || '' });
      });
    }
  }
  return tabs;
}

export function switchTab(index: number): boolean {
  const browser = getBrowser();
  if (browser === 'chrome') {
    const result = runOsa(`tell application "${chromeAppName()}" to set active tab index of front window to ${index}`);
    return result.ok;
  }
  return false;
}

coworkLog('INFO', 'macBrowserBridge', `macOS native browser bridge: available=${IS_MAC}`);
