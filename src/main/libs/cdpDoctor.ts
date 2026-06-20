/**
 * CDP Browser Doctor + Maintenance — diagnostics and cleanup for CDP mode.
 *
 * Doctor: checks Chrome installation, version, CDP port, profile health.
 * Maintenance: cleans zombie processes, expired profiles, temp screenshots.
 *
 * Reference: OpenClaw extensions/browser/ (browser-doctor.ts + browser-maintenance.ts)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { coworkLog } from './coworkLogger';
import { isProcessAlive, killProcessTree } from './killTree';

// ── Types ──

export interface BrowserDiagnostic {
  check: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

export interface BrowserHealthReport {
  overall: 'healthy' | 'degraded' | 'broken';
  diagnostics: BrowserDiagnostic[];
  checkedAt: number;
}

// ── Doctor: Health Check ──

export async function runBrowserDoctor(): Promise<BrowserHealthReport> {
  const diagnostics: BrowserDiagnostic[] = [];

  // 1. Check Chrome installation
  const chromePath = detectChrome();
  if (chromePath) {
    diagnostics.push({ check: 'chrome-installed', status: 'ok', message: `Found: ${chromePath}` });

    // 2. Check Chrome version
    const version = getChromeVersion(chromePath);
    if (version) {
      const major = parseInt(version.split('.')[0], 10);
      if (major >= 90) {
        diagnostics.push({ check: 'chrome-version', status: 'ok', message: `v${version}` });
      } else {
        diagnostics.push({ check: 'chrome-version', status: 'warn', message: `v${version} — Chrome 90+ recommended` });
      }
    } else {
      diagnostics.push({ check: 'chrome-version', status: 'warn', message: 'Could not detect version' });
    }
  } else {
    diagnostics.push({ check: 'chrome-installed', status: 'error', message: 'Chrome/Chromium not found' });
  }

  // 3. Check CDP port availability
  const cdpPortFree = await isPortFree(9222);
  if (cdpPortFree) {
    diagnostics.push({ check: 'cdp-port', status: 'ok', message: 'Port 9222 available' });
  } else {
    diagnostics.push({ check: 'cdp-port', status: 'warn', message: 'Port 9222 in use — may conflict with existing Chrome debug session' });
  }

  // 4. Check profile directory
  const profileDir = path.join(os.tmpdir(), 'noobclaw-cdp-profile');
  if (fs.existsSync(profileDir)) {
    const size = getDirSize(profileDir);
    if (size > 500 * 1024 * 1024) { // > 500MB
      diagnostics.push({ check: 'profile-size', status: 'warn', message: `Profile ${Math.round(size / 1024 / 1024)}MB — consider cleanup` });
    } else {
      diagnostics.push({ check: 'profile-size', status: 'ok', message: `Profile ${Math.round(size / 1024 / 1024)}MB` });
    }
  } else {
    diagnostics.push({ check: 'profile-size', status: 'ok', message: 'No profile yet (will create on first use)' });
  }

  // 5. Check for zombie Chrome processes
  const zombies = findZombieChromeProcesses();
  if (zombies.length > 0) {
    diagnostics.push({ check: 'zombie-processes', status: 'warn', message: `${zombies.length} zombie Chrome process(es) found` });
  } else {
    diagnostics.push({ check: 'zombie-processes', status: 'ok', message: 'No zombie processes' });
  }

  // 6. Check temp screenshot directory
  const tempDir = path.join(os.tmpdir());
  const staleScreenshots = countStaleFiles(tempDir, 'noobclaw-cdp-screenshot', 3600_000);
  if (staleScreenshots > 10) {
    diagnostics.push({ check: 'temp-files', status: 'warn', message: `${staleScreenshots} stale screenshot files in temp` });
  } else {
    diagnostics.push({ check: 'temp-files', status: 'ok', message: 'Temp files OK' });
  }

  const hasError = diagnostics.some(d => d.status === 'error');
  const hasWarn = diagnostics.some(d => d.status === 'warn');

  const report: BrowserHealthReport = {
    overall: hasError ? 'broken' : hasWarn ? 'degraded' : 'healthy',
    diagnostics,
    checkedAt: Date.now(),
  };

  coworkLog('INFO', 'cdpDoctor', `Health check: ${report.overall} (${diagnostics.length} checks)`);
  return report;
}

export function formatHealthReport(report: BrowserHealthReport): string {
  const icons = { ok: '✓', warn: '⚠', error: '✗' };
  const lines = [`Browser Health: ${report.overall.toUpperCase()}`];
  for (const d of report.diagnostics) {
    lines.push(`  ${icons[d.status]} ${d.check}: ${d.message}`);
  }
  return lines.join('\n');
}

// ── Maintenance: Cleanup ──

export interface MaintenanceResult {
  zombiesKilled: number;
  tempFilesCleaned: number;
  profileBytesFreed: number;
}

export async function runBrowserMaintenance(): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { zombiesKilled: 0, tempFilesCleaned: 0, profileBytesFreed: 0 };

  // 1. Kill zombie Chrome processes
  const zombies = findZombieChromeProcesses();
  for (const pid of zombies) {
    try {
      await killProcessTree(pid, 3000);
      result.zombiesKilled++;
    } catch {}
  }

  // 2. Clean stale temp screenshots
  const tempDir = os.tmpdir();
  try {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      if (file.startsWith('noobclaw-cdp-screenshot') || file.startsWith('noobclaw-img-')) {
        const filePath = path.join(tempDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (Date.now() - stat.mtimeMs > 3600_000) { // > 1 hour old
            fs.unlinkSync(filePath);
            result.tempFilesCleaned++;
          }
        } catch {}
      }
    }
  } catch {}

  // 3. Clean profile cache (only if > 500MB)
  const profileDir = path.join(os.tmpdir(), 'noobclaw-cdp-profile');
  if (fs.existsSync(profileDir)) {
    const cacheDir = path.join(profileDir, 'Default', 'Cache');
    if (fs.existsSync(cacheDir)) {
      const cacheSize = getDirSize(cacheDir);
      if (cacheSize > 200 * 1024 * 1024) { // > 200MB cache
        try {
          fs.rmSync(cacheDir, { recursive: true, force: true });
          result.profileBytesFreed = cacheSize;
          coworkLog('INFO', 'cdpDoctor', `Cleaned ${Math.round(cacheSize / 1024 / 1024)}MB profile cache`);
        } catch {}
      }
    }
  }

  coworkLog('INFO', 'cdpDoctor', `Maintenance: ${result.zombiesKilled} zombies killed, ${result.tempFilesCleaned} temp files, ${Math.round(result.profileBytesFreed / 1024 / 1024)}MB cache freed`);
  return result;
}

// ── Helpers ──

function detectChrome(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium');
  }
  return candidates.find(p => fs.existsSync(p)) || null;
}

function getChromeVersion(chromePath: string): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`powershell -NoProfile -Command "(Get-Item '${chromePath}').VersionInfo.FileVersion"`, { encoding: 'utf8', timeout: 5000 });
      return out.trim();
    } else {
      const out = execSync(`"${chromePath}" --version`, { encoding: 'utf8', timeout: 5000 });
      const match = out.match(/(\d+\.\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    }
  } catch { return null; }
}

async function isPortFree(port: number): Promise<boolean> {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, '127.0.0.1');
    server.on('listening', () => { server.close(); resolve(true); });
    server.on('error', () => { resolve(false); });
  });
}

function findZombieChromeProcesses(): number[] {
  const pids: number[] = [];
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
      for (const line of out.split('\n')) {
        const match = line.match(/"chrome\.exe","(\d+)"/);
        if (match) {
          const pid = parseInt(match[1], 10);
          // Only flag Chrome processes with our debug profile
          // (can't reliably detect, so skip this for safety)
        }
      }
    } else {
      const out = execSync('pgrep -f "noobclaw-cdp-profile" 2>/dev/null || true', { encoding: 'utf8', timeout: 5000 });
      for (const line of out.trim().split('\n')) {
        const pid = parseInt(line, 10);
        if (pid > 0) pids.push(pid);
      }
    }
  } catch {}
  return pids;
}

function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        try { size += fs.statSync(fullPath).size; } catch {}
      } else if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      }
    }
  } catch {}
  return size;
}

function countStaleFiles(dir: string, prefix: string, maxAgeMs: number): number {
  let count = 0;
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith(prefix)) {
        try {
          const stat = fs.statSync(path.join(dir, file));
          if (now - stat.mtimeMs > maxAgeMs) count++;
        } catch {}
      }
    }
  } catch {}
  return count;
}
