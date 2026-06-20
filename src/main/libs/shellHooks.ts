/**
 * Shell hooks — user-configured commands that fire on agent lifecycle
 * events. Inspired by Claude Code's hooks mechanism (PreToolUse,
 * PostToolUse, Stop, SessionStart) but adapted to NoobClaw's sidecar
 * architecture and cross-platform shell semantics.
 *
 * Configuration lives in {UserDataPath}/settings.json under the `hooks`
 * key so existing NoobClaw users already have the right directory and
 * we don't need a second config location. Example:
 *
 *     {
 *       "hooks": {
 *         "PreToolUse": [
 *           { "matcher": "Bash", "command": "echo pre-bash >> /tmp/nc.log" }
 *         ],
 *         "PostToolUse": [
 *           { "matcher": "Write|Edit", "command": "ruff format" }
 *         ],
 *         "Stop": [
 *           { "command": "osascript -e 'display notification \"done\"'" }
 *         ],
 *         "SessionStart": [
 *           { "command": "echo starting $NC_SESSION_ID" }
 *         ]
 *       }
 *     }
 *
 * Execution model:
 *   - Each hook runs as a child process via child_process.spawn
 *   - shell:true so users can write pipelines ("cmd1 | cmd2") natively
 *   - cwd = session's working directory
 *   - Environment variables exposed to the hook:
 *       NC_EVENT      = PreToolUse | PostToolUse | Stop | SessionStart
 *       NC_SESSION_ID = active session id
 *       NC_TOOL_NAME  = tool name (PreToolUse / PostToolUse only)
 *       NC_TOOL_INPUT_JSON = JSON string of the tool input (PreToolUse only)
 *       NC_TOOL_OUTPUT = truncated tool result text (PostToolUse only)
 *       NC_TOOL_IS_ERROR = "1" if tool failed, "0" otherwise
 *   - Default timeout 60 s per hook
 *   - Hooks run in parallel within a single phase (PreToolUse hooks all
 *     fire concurrently), but the phase as a whole awaits completion
 *     before the agent proceeds — pre-hook can block a tool, post-hook
 *     blocks the next turn
 *   - matcher is a JS regex (or plain string auto-promoted to RegExp)
 *     tested against the tool name; missing matcher matches everything
 *
 * Security note: we deliberately do NOT sandbox the child process. The
 * user wrote the commands on their own machine and we trust them the
 * same way Claude Code does. If we ever accept hooks from shared
 * documents this assumption must change.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getUserDataPath } from './platformAdapter';
import { coworkLog } from './coworkLogger';

// ── Types ──

export type ShellHookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop' | 'SessionStart';

export interface ShellHookConfig {
  /** Optional regex matched against the tool name. Omit to match all. */
  matcher?: string;
  /** Shell command to execute. Passed to spawn with shell:true. */
  command: string;
  /** Timeout override, milliseconds. Default 60_000. */
  timeoutMs?: number;
}

export interface ShellHookContext {
  sessionId: string;
  cwd?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  toolIsError?: boolean;
}

interface HooksFile {
  hooks?: Partial<Record<ShellHookEvent, ShellHookConfig[]>>;
}

// ── Config loading (cached with mtime check) ──

let cached: HooksFile | null = null;
let cachedMtime = 0;

function configPath(): string {
  return path.join(getUserDataPath(), 'settings.json');
}

function loadConfig(): HooksFile {
  const file = configPath();
  try {
    const stat = fs.statSync(file);
    if (cached && stat.mtimeMs === cachedMtime) return cached;
    const raw = fs.readFileSync(file, 'utf8');
    cached = JSON.parse(raw) as HooksFile;
    cachedMtime = stat.mtimeMs;
    return cached;
  } catch {
    // Missing / malformed — treat as "no hooks configured"
    cached = {};
    cachedMtime = 0;
    return cached;
  }
}

function hooksFor(event: ShellHookEvent): ShellHookConfig[] {
  const cfg = loadConfig();
  return cfg.hooks?.[event] ?? [];
}

// ── Matching ──

function matches(hook: ShellHookConfig, toolName: string | undefined): boolean {
  if (!hook.matcher) return true;
  try {
    return new RegExp(hook.matcher).test(toolName ?? '');
  } catch {
    // Malformed regex — fall back to plain substring check so the user
    // isn't silently dropped for a typo.
    return !!toolName && toolName.includes(hook.matcher);
  }
}

// ── Run one hook ──

function runOne(hook: ShellHookConfig, env: Record<string, string>, cwd: string | undefined, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; }> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      shell: true,
      cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => { stdout += b.toString(); if (stdout.length > 16_384) stdout = stdout.slice(0, 16_384); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); if (stderr.length > 16_384) stderr = stderr.slice(0, 16_384); });

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: stderr + `\n[hook timed out after ${timeoutMs}ms]` });
    }, timeoutMs);

    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[spawn error: ${e.message}]` });
    });
  });
}

// ── Public API ──

/**
 * Run all hooks registered for `event` whose matcher matches the
 * current tool (if any). Returns summary info for each hook so
 * callers can decide whether to block on non-zero exit.
 *
 * Hooks run in parallel; the whole phase completes when all have
 * returned or timed out. Errors and non-zero exit codes are logged
 * but do NOT throw — the caller decides policy.
 */
export async function runShellHooks(
  event: ShellHookEvent,
  ctx: ShellHookContext,
): Promise<Array<{ hook: ShellHookConfig; code: number; stdout: string; stderr: string }>> {
  const all = hooksFor(event).filter((h) => matches(h, ctx.toolName));
  if (all.length === 0) return [];

  const env: Record<string, string> = {
    NC_EVENT: event,
    NC_SESSION_ID: ctx.sessionId,
  };
  if (ctx.toolName) env.NC_TOOL_NAME = ctx.toolName;
  if (ctx.toolInput !== undefined) {
    try { env.NC_TOOL_INPUT_JSON = JSON.stringify(ctx.toolInput); } catch { /* ignore */ }
  }
  if (ctx.toolOutput !== undefined) {
    env.NC_TOOL_OUTPUT = ctx.toolOutput.length > 4_096
      ? ctx.toolOutput.slice(0, 4_096) + '…[truncated]'
      : ctx.toolOutput;
  }
  if (ctx.toolIsError !== undefined) env.NC_TOOL_IS_ERROR = ctx.toolIsError ? '1' : '0';

  coworkLog('INFO', 'shellHooks', `Running ${all.length} ${event} hook(s)`, { sessionId: ctx.sessionId, toolName: ctx.toolName });

  const results = await Promise.all(
    all.map(async (hook) => {
      const timeoutMs = hook.timeoutMs ?? 60_000;
      const r = await runOne(hook, env, ctx.cwd, timeoutMs);
      if (r.code !== 0) {
        coworkLog('WARN', 'shellHooks', `Hook exited ${r.code}: ${hook.command}`, {
          stderr: r.stderr.slice(0, 500),
        });
      }
      return { hook, ...r };
    }),
  );
  return results;
}

/**
 * Force a reload of the hooks config on the next runShellHooks call.
 * Useful when the settings UI has just saved a new version.
 */
export function invalidateHooksCache(): void {
  cached = null;
  cachedMtime = 0;
}

/**
 * List the currently-configured hooks for display in a settings UI.
 * Returns an empty map if the file is absent or malformed.
 */
export function listConfiguredHooks(): Record<ShellHookEvent, ShellHookConfig[]> {
  const cfg = loadConfig();
  return {
    PreToolUse: cfg.hooks?.PreToolUse ?? [],
    PostToolUse: cfg.hooks?.PostToolUse ?? [],
    Stop: cfg.hooks?.Stop ?? [],
    SessionStart: cfg.hooks?.SessionStart ?? [],
  };
}
