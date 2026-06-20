/**
 * Prompt cache break detection.
 *
 * LLM APIs (Anthropic, OpenAI, compatible) give 90% discount on input
 * tokens that match a previous request's prompt prefix — but only if
 * that prefix is byte-identical across requests. Tool schemas that
 * rearrange on every turn, system prompts that interpolate timestamps
 * or random session IDs, memory blocks that shift position — any of
 * these silently invalidate the cache and 10x the token cost.
 *
 * This module tracks a per-session hash of the system prompt and the
 * tool-schema block and logs a WARNING whenever it changes. Over a
 * long session, if you see the hash change every turn, the cache is
 * never hitting and you're paying full price — time to find the
 * unstable field.
 *
 * It also surfaces the actual `usage.cache_read_input_tokens` /
 * `usage.cache_creation_input_tokens` returned by the API so the
 * operator can monitor the hit rate in cowork.log without parsing
 * the full JSON response.
 *
 * Reference: Claude Code src/services/api/promptCacheBreakDetection.ts
 */

import { createHash } from 'crypto';
import { coworkLog } from './coworkLogger';

interface CacheMonitorState {
  /** Hash of the system-prompt + tool-schema blob from the last request. */
  lastHash: string;
  /** Turn number on which lastHash was computed. */
  lastTurnIndex: number;
  /** Monotonic counter of how many times the hash has CHANGED mid-session. */
  breakCount: number;
  /** When the session first started tracking. */
  startedAt: number;
  /** Rolling sum of cache_read_input_tokens across all turns. */
  totalCacheReadTokens: number;
  /** Rolling sum of input_tokens across all turns. */
  totalInputTokens: number;
  /** Rolling sum of cache_creation_input_tokens (tokens written to fill the cache). */
  totalCacheCreationTokens: number;
}

const sessionState = new Map<string, CacheMonitorState>();

/**
 * Compute a stable hash of the prompt prefix + tool schemas. Caller
 * should pass the exact bytes that go into the API request — we only
 * see the string form, so if your caller stringifies with different
 * key ordering that already counts as a break.
 */
export function hashPromptCacheKey(systemPrompt: string, toolSchemas: unknown[]): string {
  const h = createHash('sha256');
  h.update(systemPrompt || '');
  h.update('\u0001');
  try {
    h.update(JSON.stringify(toolSchemas || []));
  } catch {
    h.update('[[unserializable tool schemas]]');
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Report a cache-key hash for the current turn. Called from
 * queryEngine right before the API call is issued. Logs a WARN line
 * whenever the hash differs from the previous turn in the same session.
 */
export function reportCacheKey(sessionId: string, hash: string, turnIndex: number): void {
  const existing = sessionState.get(sessionId);
  if (!existing) {
    sessionState.set(sessionId, {
      lastHash: hash,
      lastTurnIndex: turnIndex,
      breakCount: 0,
      startedAt: Date.now(),
      totalCacheReadTokens: 0,
      totalInputTokens: 0,
      totalCacheCreationTokens: 0,
    });
    coworkLog('INFO', 'promptCacheMonitor', 'Cache-key baseline established', {
      sessionId,
      turnIndex,
      hash,
    });
    return;
  }

  if (existing.lastHash !== hash) {
    existing.breakCount += 1;
    coworkLog('WARN', 'promptCacheMonitor', 'Prompt cache BROKE — new prefix hash this turn', {
      sessionId,
      previousHash: existing.lastHash,
      newHash: hash,
      previousTurn: existing.lastTurnIndex,
      currentTurn: turnIndex,
      totalBreaks: existing.breakCount,
      hint:
        'Check if system prompt embeds a timestamp/random id, or if tool '
        + 'schemas are being rebuilt in a non-deterministic order.',
    });
    existing.lastHash = hash;
    existing.lastTurnIndex = turnIndex;
  }
}

/**
 * Feed the usage field from an API response so the hit-rate tracker
 * stays current. Called in the existing handleQueryEvent 'usage' case.
 */
export function reportUsage(
  sessionId: string,
  usage: {
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
): void {
  const existing = sessionState.get(sessionId);
  if (!existing) return;
  const input = Number(usage.inputTokens || 0);
  const cacheRead = Number(usage.cacheReadTokens || 0);
  const cacheCreate = Number(usage.cacheCreationTokens || 0);

  existing.totalInputTokens += input;
  existing.totalCacheReadTokens += cacheRead;
  existing.totalCacheCreationTokens += cacheCreate;

  // Log the per-turn hit rate when we actually have signal. Don't spam
  // for small tool-only turns where input is zero.
  if (input > 0) {
    const hitRatio = cacheRead / input;
    if (hitRatio < 0.3 && input > 5000) {
      coworkLog('WARN', 'promptCacheMonitor', 'Low cache hit rate this turn', {
        sessionId,
        inputTokens: input,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        hitRatio: Number(hitRatio.toFixed(2)),
      });
    }
  }
}

/**
 * Session-level hit rate snapshot, for end-of-session reporting.
 */
export function getCacheStats(sessionId: string): {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  hitRatio: number;
  breakCount: number;
} | null {
  const s = sessionState.get(sessionId);
  if (!s) return null;
  return {
    inputTokens: s.totalInputTokens,
    cacheReadTokens: s.totalCacheReadTokens,
    cacheCreationTokens: s.totalCacheCreationTokens,
    hitRatio:
      s.totalInputTokens === 0 ? 0 : s.totalCacheReadTokens / s.totalInputTokens,
    breakCount: s.breakCount,
  };
}

/**
 * Drop session state when the session ends so the Map doesn't grow
 * unbounded. Called from coworkRunner's session-complete path.
 */
export function clearCacheMonitor(sessionId: string): void {
  sessionState.delete(sessionId);
}
