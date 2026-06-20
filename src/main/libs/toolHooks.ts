/**
 * Tool Hooks — pre/post execution hooks for tool lifecycle management.
 * Reference: Claude Code src/services/tools/toolExecution.ts
 *
 * Pre: validate, modify input, block execution
 * Post: record duration, classify errors, suggest recovery
 */

import { coworkLog } from './coworkLogger';
import type { ToolDefinition, ToolResult } from './toolSystem';

// ── Types ──

export interface PreToolHookResult {
  action: 'allow' | 'deny' | 'modify';
  message?: string;
  updatedInput?: Record<string, unknown>;
}

export interface PostToolHookResult {
  shouldLog: boolean;
  summary?: string;
  suggestRetry?: boolean;
}

export type PreToolHook = (toolName: string, input: Record<string, unknown>) => PreToolHookResult | Promise<PreToolHookResult>;
export type PostToolHook = (toolName: string, result: ToolResult, durationMs: number) => PostToolHookResult | void;
export type PostFailureHook = (toolName: string, error: string, input: Record<string, unknown>) => { suggestion?: string } | void;

// ── Registry ──

const preHooks: PreToolHook[] = [];
const postHooks: PostToolHook[] = [];
const failureHooks: PostFailureHook[] = [];

export function registerPreToolHook(hook: PreToolHook): void { preHooks.push(hook); }
export function registerPostToolHook(hook: PostToolHook): void { postHooks.push(hook); }
export function registerPostFailureHook(hook: PostFailureHook): void { failureHooks.push(hook); }

// ── Execute hooks ──

export async function runPreToolHooks(toolName: string, input: Record<string, unknown>): Promise<PreToolHookResult> {
  for (const hook of preHooks) {
    try {
      const result = await hook(toolName, input);
      if (result.action === 'deny') return result;
      if (result.action === 'modify' && result.updatedInput) {
        return result;
      }
    } catch (e) {
      coworkLog('WARN', 'toolHooks', `Pre-hook error for ${toolName}: ${e}`);
    }
  }
  return { action: 'allow' };
}

export async function runPostToolHooks(toolName: string, result: ToolResult, durationMs: number): Promise<void> {
  // Log slow tools
  if (durationMs > 2000) {
    coworkLog('INFO', 'toolHooks', `Slow tool: ${toolName} took ${durationMs}ms`);
  }

  for (const hook of postHooks) {
    try {
      hook(toolName, result, durationMs);
    } catch (e) {
      coworkLog('WARN', 'toolHooks', `Post-hook error for ${toolName}: ${e}`);
    }
  }
}

export async function runPostFailureHooks(toolName: string, error: string, input: Record<string, unknown>): Promise<string | undefined> {
  for (const hook of failureHooks) {
    try {
      const result = hook(toolName, error, input);
      if (result && 'suggestion' in result && result.suggestion) return result.suggestion;
    } catch {}
  }
  return undefined;
}

// ── Error Classification ──
// Reference: Claude Code classifyToolError()

export function classifyToolError(error: unknown): { message: string; code: string; recoverable: boolean } {
  if (!error) return { message: 'Unknown error', code: 'unknown', recoverable: false };

  const msg = error instanceof Error ? error.message : String(error);

  // File system errors
  if (msg.includes('ENOENT')) return { message: `File not found: ${extractPath(msg)}`, code: 'ENOENT', recoverable: true };
  if (msg.includes('EACCES')) return { message: `Permission denied: ${extractPath(msg)}`, code: 'EACCES', recoverable: false };
  if (msg.includes('ENOSPC')) return { message: 'Disk full', code: 'ENOSPC', recoverable: false };
  if (msg.includes('EISDIR')) return { message: 'Expected file but found directory', code: 'EISDIR', recoverable: true };

  // Network errors
  if (msg.includes('ECONNREFUSED')) return { message: 'Connection refused', code: 'ECONNREFUSED', recoverable: true };
  if (msg.includes('ETIMEDOUT')) return { message: 'Connection timed out', code: 'ETIMEDOUT', recoverable: true };

  // Process errors
  if (msg.includes('SIGTERM') || msg.includes('SIGKILL')) return { message: 'Process terminated', code: 'SIGKILL', recoverable: false };
  if (msg.includes('timed out')) return { message: 'Tool execution timed out', code: 'TIMEOUT', recoverable: true };

  // Validation errors
  if (msg.includes('validation') || msg.includes('parse')) return { message: `Input error: ${msg.slice(0, 200)}`, code: 'VALIDATION', recoverable: true };

  return { message: msg.slice(0, 500), code: 'ERROR', recoverable: false };
}

function extractPath(msg: string): string {
  const match = msg.match(/'([^']+)'|"([^"]+)"/);
  return match ? (match[1] || match[2]) : '';
}

// ── Per-tool result size limits ──
// Reference: Claude Code maxResultSizeChars per tool

const TOOL_RESULT_LIMITS: Record<string, number> = {
  Read: 10_000,
  Bash: 20_000,
  Grep: 15_000,
  Glob: 10_000,
  web_fetch: 30_000,
  web_search: 10_000,
  browser_get_text: 20_000,
  browser_read_page: 15_000,
  process_poll: 10_000,
};

export function getToolResultLimit(toolName: string): number {
  return TOOL_RESULT_LIMITS[toolName] ?? 30_000;
}

/**
 * Truncate tool result based on per-tool limits.
 */
export function truncateToolResult(toolName: string, content: string): string {
  const limit = getToolResultLimit(toolName);
  if (content.length <= limit) return content;
  return content.slice(0, limit) + `\n\n[Output truncated at ${Math.round(limit / 1000)}KB. Use Read with offset/limit for more.]`;
}
