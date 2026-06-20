/**
 * Process Registry — manages background child processes.
 * Enables agent to run long-lived processes (dev servers, watchers)
 * and continue working while they run.
 *
 * Reference: OpenClaw src/process/ (command-queue.ts, exec.ts, supervisor/)
 *
 * Key operations: spawn, list, poll (get output), write (stdin), kill
 * Key features: lane-based concurrency, scope grouping, dual timeout
 */

import { spawn, type ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { killProcessTree, isProcessAlive } from './killTree';
import { coworkLog } from './coworkLogger';

// ── Types ──

export type ProcessState = 'starting' | 'running' | 'stalled' | 'exiting' | 'exited';
export type ProcessLane = 'main' | 'subagent' | 'cron' | 'background';

export interface ProcessRun {
  runId: string;
  pid: number | null;
  command: string;
  args: string[];
  cwd: string;
  state: ProcessState;
  lane: ProcessLane;
  scopeKey: string;           // Usually sessionId — for batch cleanup
  exitCode: number | null;
  stdout: string;             // Rolling buffer
  stderr: string;             // Rolling buffer
  startedAt: number;
  lastOutputAt: number;
  endedAt: number | null;
  totalTimeoutMs: number;
  noOutputTimeoutMs: number;
  process: ChildProcess | null;
}

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  lane?: ProcessLane;
  scopeKey?: string;
  totalTimeoutMs?: number;      // Default: 30 min
  noOutputTimeoutMs?: number;   // Default: 5 min
  maxOutputChars?: number;      // Rolling buffer size, default: 100KB
}

// ── Constants ──

const DEFAULT_TOTAL_TIMEOUT = 30 * 60 * 1000;    // 30 minutes
const DEFAULT_NO_OUTPUT_TIMEOUT = 5 * 60 * 1000;  // 5 minutes
const DEFAULT_MAX_OUTPUT = 100_000;                // 100KB rolling buffer
const TIMEOUT_CHECK_INTERVAL = 10_000;             // Check every 10s

// ── Lane concurrency limits (from OpenClaw lanes.ts) ──

const LANE_MAX_CONCURRENT: Record<ProcessLane, number> = {
  main: 3,
  subagent: 5,
  cron: 2,
  background: 10,
};

// ── Registry ──

const runs = new Map<string, ProcessRun>();
const laneActive = new Map<ProcessLane, Set<string>>();
let timeoutChecker: ReturnType<typeof setInterval> | null = null;

// ── Initialize ──

export function startProcessRegistry(): void {
  if (!timeoutChecker) {
    timeoutChecker = setInterval(checkTimeouts, TIMEOUT_CHECK_INTERVAL);
  }
  for (const lane of Object.keys(LANE_MAX_CONCURRENT) as ProcessLane[]) {
    if (!laneActive.has(lane)) laneActive.set(lane, new Set());
  }
}

export function stopProcessRegistry(): void {
  if (timeoutChecker) { clearInterval(timeoutChecker); timeoutChecker = null; }
  // Kill all running processes
  for (const run of runs.values()) {
    if (run.pid && run.state === 'running') {
      killProcessTree(run.pid).catch(() => {});
    }
  }
}

// ── Spawn ──

export function spawnProcess(options: SpawnOptions): ProcessRun | null {
  const lane = options.lane ?? 'background';
  const active = laneActive.get(lane) ?? new Set();
  const maxConcurrent = LANE_MAX_CONCURRENT[lane] ?? 5;

  // Check lane concurrency
  if (active.size >= maxConcurrent) {
    coworkLog('WARN', 'processRegistry', `Lane "${lane}" at capacity (${active.size}/${maxConcurrent})`);
    return null;
  }

  const runId = uuidv4().slice(0, 12);
  const maxOutput = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const now = Date.now();

  const run: ProcessRun = {
    runId,
    pid: null,
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd ?? process.cwd(),
    state: 'starting',
    lane,
    scopeKey: options.scopeKey ?? '',
    exitCode: null,
    stdout: '',
    stderr: '',
    startedAt: now,
    lastOutputAt: now,
    endedAt: null,
    totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT,
    noOutputTimeoutMs: options.noOutputTimeoutMs ?? DEFAULT_NO_OUTPUT_TIMEOUT,
    process: null,
  };

  try {
    const env = options.env ? { ...process.env, ...options.env } : undefined;
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: env as NodeJS.ProcessEnv | undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', // Process group on Unix
      windowsHide: process.platform === 'win32',
    });

    run.pid = child.pid ?? null;
    run.state = 'running';
    run.process = child;

    // Capture stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      run.stdout += text;
      if (run.stdout.length > maxOutput) {
        run.stdout = run.stdout.slice(-maxOutput);
      }
      run.lastOutputAt = Date.now();
      if (run.state === 'stalled') run.state = 'running';
    });

    // Capture stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      run.stderr += text;
      if (run.stderr.length > maxOutput) {
        run.stderr = run.stderr.slice(-maxOutput);
      }
      run.lastOutputAt = Date.now();
      if (run.state === 'stalled') run.state = 'running';
    });

    // Handle exit
    child.on('exit', (code) => {
      run.exitCode = code;
      run.state = 'exited';
      run.endedAt = Date.now();
      run.process = null;
      active.delete(runId);
      coworkLog('INFO', 'processRegistry', `Process ${runId} exited (code=${code})`);
    });

    child.on('error', (err) => {
      run.stderr += `\nProcess error: ${err.message}`;
      run.state = 'exited';
      run.exitCode = -1;
      run.endedAt = Date.now();
      run.process = null;
      active.delete(runId);
    });

    runs.set(runId, run);
    active.add(runId);

    coworkLog('INFO', 'processRegistry', `Spawned ${runId}: ${options.command} ${(options.args ?? []).join(' ')}`, {
      pid: run.pid, lane, cwd: options.cwd,
    });

    return run;
  } catch (e) {
    run.state = 'exited';
    run.exitCode = -1;
    run.stderr = `Spawn failed: ${e instanceof Error ? e.message : String(e)}`;
    run.endedAt = Date.now();
    runs.set(runId, run);
    return run;
  }
}

// ── Poll (get latest output) ──

export function pollProcess(runId: string): { stdout: string; stderr: string; state: ProcessState; exitCode: number | null } | null {
  const run = runs.get(runId);
  if (!run) return null;
  return {
    stdout: run.stdout,
    stderr: run.stderr,
    state: run.state,
    exitCode: run.exitCode,
  };
}

/**
 * Poll only new output since last poll.
 * Returns delta and clears the buffer.
 */
export function pollProcessDelta(runId: string): { stdout: string; stderr: string; state: ProcessState } | null {
  const run = runs.get(runId);
  if (!run) return null;
  const result = { stdout: run.stdout, stderr: run.stderr, state: run.state };
  run.stdout = '';
  run.stderr = '';
  return result;
}

// ── Write to stdin ──

export function writeToProcess(runId: string, data: string): boolean {
  const run = runs.get(runId);
  if (!run?.process?.stdin || run.state !== 'running') return false;
  try {
    run.process.stdin.write(data);
    return true;
  } catch {
    return false;
  }
}

// ── Kill ──

export async function killProcess(runId: string): Promise<boolean> {
  const run = runs.get(runId);
  if (!run || !run.pid || run.state === 'exited') return false;

  run.state = 'exiting';
  const killed = await killProcessTree(run.pid);
  if (killed || !isProcessAlive(run.pid)) {
    run.state = 'exited';
    run.endedAt = Date.now();
    laneActive.get(run.lane)?.delete(runId);
  }
  return killed;
}

/**
 * Kill all processes in a scope (e.g., all processes for a session).
 */
export async function killScope(scopeKey: string): Promise<number> {
  let killed = 0;
  for (const run of runs.values()) {
    if (run.scopeKey === scopeKey && run.state === 'running') {
      if (await killProcess(run.runId)) killed++;
    }
  }
  if (killed > 0) coworkLog('INFO', 'processRegistry', `Killed ${killed} processes in scope "${scopeKey}"`);
  return killed;
}

// ── List ──

export function listProcesses(filter?: { lane?: ProcessLane; scopeKey?: string; state?: ProcessState }): ProcessRun[] {
  let result = Array.from(runs.values());
  if (filter?.lane) result = result.filter(r => r.lane === filter.lane);
  if (filter?.scopeKey) result = result.filter(r => r.scopeKey === filter.scopeKey);
  if (filter?.state) result = result.filter(r => r.state === filter.state);
  return result.sort((a, b) => b.startedAt - a.startedAt);
}

export function getRunningCount(): number {
  return Array.from(runs.values()).filter(r => r.state === 'running' || r.state === 'stalled').length;
}

// ── Timeout check ──

function checkTimeouts(): void {
  const now = Date.now();
  for (const run of runs.values()) {
    if (run.state !== 'running' && run.state !== 'stalled') continue;

    // Total timeout
    if (now - run.startedAt > run.totalTimeoutMs) {
      coworkLog('WARN', 'processRegistry', `Process ${run.runId} total timeout (${run.totalTimeoutMs}ms)`);
      killProcess(run.runId).catch(() => {});
      continue;
    }

    // No-output timeout → mark as stalled
    if (run.state === 'running' && now - run.lastOutputAt > run.noOutputTimeoutMs) {
      run.state = 'stalled';
      coworkLog('WARN', 'processRegistry', `Process ${run.runId} stalled (no output for ${run.noOutputTimeoutMs}ms)`);
    }
  }
}

// ── Cleanup old exited processes ──

export function cleanupExited(olderThanMs: number = 60 * 60 * 1000): number {
  const cutoff = Date.now() - olderThanMs;
  let cleaned = 0;
  for (const [id, run] of runs) {
    if (run.state === 'exited' && (run.endedAt ?? 0) < cutoff) {
      runs.delete(id);
      cleaned++;
    }
  }
  return cleaned;
}
