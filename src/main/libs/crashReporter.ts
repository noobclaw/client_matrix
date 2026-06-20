/**
 * Lightweight crash reporter for the sidecar Node process.
 *
 * NoobClaw's two processes each produce errors the user may want to
 * surface. In the sidecar (where the query engine, tool execution,
 * and SQLite live) we want to:
 *
 *   1. Catch every `uncaughtException` and `unhandledRejection`
 *      without crashing the process — these are almost always due to
 *      a bug in a long-running async task, and taking down the whole
 *      sidecar would drop in-flight cowork sessions.
 *
 *   2. Write a structured crash record to {UserDataPath}/crashes/
 *      as NDJSON so the user can ship it with a bug report without
 *      needing us to parse half a megabyte of cowork.log.
 *
 *   3. Rotate the crash log so an app that's been running for years
 *      doesn't slowly eat disk — keep the last 30 crashes max.
 *
 *   4. Broadcast a `system:crash` SSE event so the renderer can
 *      pop a small "⚠ sidecar crashed — view details" toast with a
 *      link that opens the crash record in the OS file browser.
 *
 * This is intentionally NOT a Sentry integration. Sentry requires a
 * DSN / account / PII review we don't currently have, and the value
 * of sending crashes off-device is much lower than the value of
 * giving the user a ready-to-attach log file. If we decide to add
 * Sentry later, the same install() hook is the natural place to wire
 * `@sentry/node`'s captureException next to `writeCrash`.
 */

import fs from 'fs';
import path from 'path';
import { getUserDataPath } from './platformAdapter';
import { coworkLog } from './coworkLogger';

// ── Config ──

const MAX_CRASH_FILES = 30;

// ── File helpers ──

function crashDir(): string {
  return path.join(getUserDataPath(), 'crashes');
}

function ensureDir(): void {
  try { fs.mkdirSync(crashDir(), { recursive: true }); } catch { /* ignore */ }
}

function rotateIfNeeded(): void {
  try {
    const dir = crashDir();
    const files = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.ndjson'))
      .map((n) => ({ name: n, path: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const excess of files.slice(MAX_CRASH_FILES)) {
      try { fs.unlinkSync(excess.path); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ── Write a crash record ──

interface CrashRecord {
  ts: string;
  kind: 'uncaughtException' | 'unhandledRejection' | 'manual';
  name?: string;
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
  processUptimeSec: number;
  nodeVersion: string;
  platform: string;
  arch: string;
}

function writeCrash(record: CrashRecord): string | null {
  ensureDir();
  const dir = crashDir();
  const filename = `crash-${Date.now()}.ndjson`;
  const filePath = path.join(dir, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    rotateIfNeeded();
    return filePath;
  } catch (e) {
    coworkLog('ERROR', 'crashReporter', `Failed to write crash record: ${e}`);
    return null;
  }
}

// ── Public API ──

type Broadcast = (event: string, data: unknown) => void;

let installed = false;

/**
 * Install global handlers. Idempotent — safe to call more than once
 * (e.g. from both main and sidecar bootstrap paths; only the first
 * call actually attaches the listeners).
 *
 * The broadcast callback lets us notify the renderer without
 * hard-depending on sidecar-server.ts — the caller wires in
 * broadcastSSE and the reporter stays transport-agnostic.
 */
export function installCrashReporter(broadcast?: Broadcast): void {
  if (installed) return;
  installed = true;

  const handle = (err: unknown, kind: CrashRecord['kind']) => {
    const e = err as Error | undefined;
    const record: CrashRecord = {
      ts: new Date().toISOString(),
      kind,
      name: e?.name,
      message: e?.message ?? String(err),
      stack: e?.stack,
      processUptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };
    const file = writeCrash(record);
    coworkLog('ERROR', 'crashReporter', `${kind}: ${record.message}`, { file, stack: record.stack?.slice(0, 500) });
    if (broadcast) {
      try {
        broadcast('system:crash', {
          kind,
          message: record.message,
          file,
          ts: record.ts,
        });
      } catch { /* ignore */ }
    }
  };

  process.on('uncaughtException', (err) => handle(err, 'uncaughtException'));
  process.on('unhandledRejection', (reason) => handle(reason, 'unhandledRejection'));

  coworkLog('INFO', 'crashReporter', 'Crash reporter installed');
}

/**
 * Called from an IPC handler when the user clicks "Report issue" —
 * returns the list of recent crash records so the renderer can
 * attach them to a bug report. Limited to the last 10 for sanity.
 */
export function recentCrashes(limit: number = 10): Array<CrashRecord & { file: string }> {
  ensureDir();
  const dir = crashDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith('.ndjson'));
  } catch {
    return [];
  }
  const sorted = files
    .map((n) => ({ name: n, path: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  const out: Array<CrashRecord & { file: string }> = [];
  for (const entry of sorted) {
    try {
      const raw = fs.readFileSync(entry.path, 'utf8').trim().split('\n')[0];
      const rec = JSON.parse(raw) as CrashRecord;
      out.push({ ...rec, file: entry.path });
    } catch { /* skip corrupt */ }
  }
  return out;
}

/**
 * Let the renderer open the crashes directory in the OS file browser.
 */
export function getCrashDir(): string {
  return crashDir();
}

/**
 * Manually log a crash — called from main-process error boundaries
 * or from the renderer via an IPC handler when React's
 * ErrorBoundary catches something.
 */
export function reportManualCrash(message: string, stack?: string, extra?: Record<string, unknown>): string | null {
  return writeCrash({
    ts: new Date().toISOString(),
    kind: 'manual',
    message,
    stack,
    extra,
    processUptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });
}
