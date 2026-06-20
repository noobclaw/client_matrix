/**
 * Token Budget — tracks consumption and detects diminishing returns.
 * Prevents agent loops from wasting tokens when output is drying up.
 *
 * Reference: Claude Code src/query/tokenBudget.ts
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export interface BudgetTracker {
  continuationCount: number;
  lastDeltaTokens: number;
  lastGlobalTurnTokens: number;
  startedAt: number;
  totalBudget: number;
}

export type BudgetDecision =
  | { action: 'continue'; nudgeMessage: string; pct: number; turnTokens: number }
  | { action: 'stop'; reason: 'budget_exhausted' | 'diminishing_returns' | 'normal_completion'; pct: number; turnTokens: number; durationMs: number };

// ── Constants ──

const BUDGET_THRESHOLD_PCT = 0.9;          // Stop at 90% consumption
const MIN_CONTINUATIONS_FOR_DIMINISH = 3;  // Need 3+ continuations to detect diminishing
const MIN_DELTA_TOKENS = 500;              // Less than this = diminishing
const DEFAULT_BUDGET = 100_000;            // Default 100K token budget

// ── Create ──

export function createBudgetTracker(totalBudget?: number): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
    totalBudget: totalBudget ?? DEFAULT_BUDGET,
  };
}

// ── Check ──

/**
 * Check if the agent loop should continue or stop based on token consumption.
 * Call after each assistant turn in the query loop.
 */
export function checkTokenBudget(
  tracker: BudgetTracker,
  currentTurnTokens: number,
): BudgetDecision {
  const pct = Math.round((currentTurnTokens / tracker.totalBudget) * 100);
  const durationMs = Date.now() - tracker.startedAt;
  const deltaSinceLastCheck = currentTurnTokens - tracker.lastGlobalTurnTokens;

  // Update tracker
  tracker.lastGlobalTurnTokens = currentTurnTokens;

  // Check: budget exhausted (>90%)
  if (currentTurnTokens >= tracker.totalBudget * BUDGET_THRESHOLD_PCT) {
    coworkLog('INFO', 'tokenBudget', `Budget exhausted: ${pct}% used (${currentTurnTokens}/${tracker.totalBudget})`);
    return {
      action: 'stop',
      reason: 'budget_exhausted',
      pct, turnTokens: currentTurnTokens, durationMs,
    };
  }

  // Check: diminishing returns
  if (
    tracker.continuationCount >= MIN_CONTINUATIONS_FOR_DIMINISH &&
    deltaSinceLastCheck < MIN_DELTA_TOKENS &&
    tracker.lastDeltaTokens < MIN_DELTA_TOKENS
  ) {
    coworkLog('INFO', 'tokenBudget', `Diminishing returns: ${tracker.continuationCount} continuations, last delta=${deltaSinceLastCheck}`);
    return {
      action: 'stop',
      reason: 'diminishing_returns',
      pct, turnTokens: currentTurnTokens, durationMs,
    };
  }

  // Continue
  tracker.continuationCount++;
  tracker.lastDeltaTokens = deltaSinceLastCheck;

  const nudgeMessage = `Continue working. Progress: ${pct}% of token budget used (${tracker.continuationCount} continuations). Focus on completing the current task efficiently.`;

  return {
    action: 'continue',
    nudgeMessage,
    pct, turnTokens: currentTurnTokens,
  };
}

/**
 * Estimate tokens from usage object returned by API.
 */
export function extractTurnTokens(usage: any): number {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + (usage.output_tokens || 0);
}
