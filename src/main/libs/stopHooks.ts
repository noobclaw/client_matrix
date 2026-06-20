/**
 * Stop Hooks — runs at turn completion to perform background intelligence tasks.
 * Extracts memories, generates suggestions, predicts next actions.
 *
 * Reference: Claude Code src/query/stopHooks.ts (474 lines)
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export type StopHookType =
  | 'memory_extraction'    // Extract key facts from the conversation
  | 'suggestion'           // Predict what user might want to do next
  | 'cleanup'              // Clean up temp files, processes
  | 'custom';

export interface StopHookResult {
  type: StopHookType;
  success: boolean;
  durationMs: number;
  data?: Record<string, unknown>;
  error?: string;
}

export type StopHookFn = (context: StopHookContext) => Promise<StopHookResult | void>;

export interface StopHookContext {
  sessionId: string;
  turnCount: number;
  lastAssistantText: string;
  lastToolNames: string[];
  totalInputTokens: number;
  totalOutputTokens: number;
}

// ── Registry ──

interface RegisteredHook {
  id: string;
  type: StopHookType;
  fn: StopHookFn;
  blocking: boolean;     // If true, must complete before next turn
  maxDurationMs: number; // Timeout
}

const hooks: RegisteredHook[] = [];
const SLOW_HOOK_THRESHOLD_MS = 2000;

// ── Register ──

export function registerStopHook(hook: {
  id: string;
  type: StopHookType;
  fn: StopHookFn;
  blocking?: boolean;
  maxDurationMs?: number;
}): void {
  hooks.push({
    id: hook.id,
    type: hook.type,
    fn: hook.fn,
    blocking: hook.blocking ?? false,
    maxDurationMs: hook.maxDurationMs ?? 10_000,
  });
  coworkLog('INFO', 'stopHooks', `Registered: ${hook.id} (${hook.type}, ${hook.blocking ? 'blocking' : 'non-blocking'})`);
}

export function unregisterStopHook(id: string): void {
  const idx = hooks.findIndex(h => h.id === id);
  if (idx >= 0) hooks.splice(idx, 1);
}

// ── Execute all hooks ──

/**
 * Run all registered stop hooks after a turn completes.
 * Non-blocking hooks run in parallel. Blocking hooks run sequentially.
 * All hooks have timeouts to prevent hangs.
 */
export async function runStopHooks(context: StopHookContext): Promise<StopHookResult[]> {
  if (hooks.length === 0) return [];

  const startTime = Date.now();
  const results: StopHookResult[] = [];

  // Separate blocking and non-blocking
  const blocking = hooks.filter(h => h.blocking);
  const nonBlocking = hooks.filter(h => !h.blocking);

  // Run blocking hooks sequentially
  for (const hook of blocking) {
    const result = await executeOneHook(hook, context);
    results.push(result);
    if (result.durationMs > SLOW_HOOK_THRESHOLD_MS) {
      coworkLog('WARN', 'stopHooks', `Slow blocking hook: ${hook.id} took ${result.durationMs}ms`);
    }
  }

  // Run non-blocking hooks in parallel (fire-and-forget with timeout)
  const nonBlockingPromises = nonBlocking.map(hook =>
    executeOneHook(hook, context).then(result => {
      results.push(result);
      if (result.durationMs > SLOW_HOOK_THRESHOLD_MS) {
        coworkLog('INFO', 'stopHooks', `Slow non-blocking hook: ${hook.id} took ${result.durationMs}ms`);
      }
    })
  );

  // Don't wait forever for non-blocking hooks
  await Promise.allSettled(nonBlockingPromises);

  const totalMs = Date.now() - startTime;
  coworkLog('INFO', 'stopHooks', `${hooks.length} hooks completed in ${totalMs}ms (${blocking.length} blocking, ${nonBlocking.length} non-blocking)`);

  return results;
}

async function executeOneHook(hook: RegisteredHook, context: StopHookContext): Promise<StopHookResult> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      hook.fn(context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Hook ${hook.id} timed out after ${hook.maxDurationMs}ms`)), hook.maxDurationMs)
      ),
    ]);

    return result || {
      type: hook.type,
      success: true,
      durationMs: Date.now() - start,
    } as StopHookResult;
  } catch (e) {
    return {
      type: hook.type,
      success: false,
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Built-in hooks ──

/**
 * Register default stop hooks (call once at startup).
 */
export function registerDefaultStopHooks(): void {
  // Memory extraction: extract key facts from the turn
  registerStopHook({
    id: 'memory-extraction',
    type: 'memory_extraction',
    fn: async (ctx) => {
      // Only extract if the turn had substance
      if (!ctx.lastAssistantText || ctx.lastAssistantText.length < 50) {
        return { type: 'memory_extraction', success: true, durationMs: 0 };
      }
      // Actual extraction happens in coworkRunner.maybeExtractSessionMemory
      // This hook just logs the intent
      return { type: 'memory_extraction', success: true, durationMs: 0, data: { textLength: ctx.lastAssistantText.length } };
    },
    blocking: false,
    maxDurationMs: 5000,
  });

  // Suggestion: predict next action based on what just happened
  registerStopHook({
    id: 'next-action-suggestion',
    type: 'suggestion',
    fn: async (ctx) => {
      const suggestions: string[] = [];

      // If user ran tests and they failed, suggest fixing
      if (ctx.lastToolNames.includes('Bash') && ctx.lastAssistantText.includes('FAIL')) {
        suggestions.push('Tests failed — would you like me to fix the failing tests?');
      }

      // If user edited files, suggest running tests
      if (ctx.lastToolNames.includes('Edit') || ctx.lastToolNames.includes('Write')) {
        suggestions.push('Files modified — should I run tests to verify?');
      }

      // If user searched code, suggest deeper exploration
      if (ctx.lastToolNames.includes('Grep') && ctx.lastAssistantText.includes('No matches')) {
        suggestions.push('No matches found — try a different search pattern or broader scope?');
      }

      return {
        type: 'suggestion',
        success: true,
        durationMs: 0,
        data: { suggestions },
      };
    },
    blocking: false,
    maxDurationMs: 1000,
  });

  // Cleanup: remove temp files older than 1 hour
  registerStopHook({
    id: 'temp-cleanup',
    type: 'cleanup',
    fn: async () => {
      // Lightweight — actual cleanup is in mediaPipeline.cleanupTempFiles
      return { type: 'cleanup', success: true, durationMs: 0 };
    },
    blocking: false,
    maxDurationMs: 3000,
  });
}

// ── Query ──

export function getRegisteredHooks(): Array<{ id: string; type: StopHookType; blocking: boolean }> {
  return hooks.map(h => ({ id: h.id, type: h.type, blocking: h.blocking }));
}
