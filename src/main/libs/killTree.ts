/**
 * Kill Tree — cross-platform process tree termination.
 * Graceful shutdown: SIGTERM → grace period → SIGKILL.
 *
 * Reference: OpenClaw src/process/kill-tree.ts
 */

import { execSync } from 'child_process';
import { coworkLog } from './coworkLogger';

const IS_WIN = process.platform === 'win32';
const DEFAULT_GRACE_MS = 5000;

/**
 * Kill a process and all its children.
 * @param pid Process ID to kill
 * @param gracePeriodMs Time to wait after SIGTERM before SIGKILL (default: 5s)
 */
export async function killProcessTree(pid: number, gracePeriodMs: number = DEFAULT_GRACE_MS): Promise<boolean> {
  if (!pid || pid <= 0) return false;

  try {
    if (IS_WIN) {
      return killTreeWindows(pid);
    } else {
      return await killTreeUnix(pid, gracePeriodMs);
    }
  } catch (e) {
    coworkLog('WARN', 'killTree', `Failed to kill tree for PID ${pid}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ── Windows: taskkill /T /F ──

function killTreeWindows(pid: number): boolean {
  try {
    // /T = kill child processes, /F = force
    execSync(`taskkill /T /F /PID ${pid}`, { timeout: 10000, windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    // Process may have already exited
    return !isProcessAlive(pid);
  }
}

// ── Unix: kill process group, then SIGKILL ──

async function killTreeUnix(pid: number, gracePeriodMs: number): Promise<boolean> {
  // Try to kill the process group (negative PID)
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Process group may not exist, try individual
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return !isProcessAlive(pid);
    }
  }

  // Wait for graceful shutdown
  const start = Date.now();
  while (Date.now() - start < gracePeriodMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(200);
  }

  // Force kill
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead
    }
  }

  // Verify
  await sleep(100);
  return !isProcessAlive(pid);
}

// ── Helpers ──

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Kill multiple PIDs in parallel.
 */
export async function killMultiple(pids: number[], gracePeriodMs?: number): Promise<void> {
  await Promise.allSettled(pids.map(pid => killProcessTree(pid, gracePeriodMs)));
}
