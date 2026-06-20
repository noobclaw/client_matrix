/**
 * Effort System — multi-level reasoning depth control.
 * Low = fast answers, Medium = balanced, High = thorough, Max = exhaustive.
 *
 * Reference: Claude Code src/utils/effort.ts
 * Automatically detects question complexity to choose appropriate level.
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface EffortConfig {
  defaultLevel: EffortLevel;
  autoDetect: boolean;        // Auto-choose based on message complexity
  maxLevel: EffortLevel;      // Cap (e.g., don't allow 'max' for cost control)
}

const DEFAULT_CONFIG: EffortConfig = {
  defaultLevel: 'medium',
  autoDetect: true,
  maxLevel: 'high',
};

let config = { ...DEFAULT_CONFIG };

// ── Configure ──

export function configureEffort(custom?: Partial<EffortConfig>): void {
  if (custom) config = { ...config, ...custom };
}

// ── Level ordering ──

const LEVEL_ORDER: Record<EffortLevel, number> = { low: 0, medium: 1, high: 2, max: 3 };

function capLevel(level: EffortLevel): EffortLevel {
  return LEVEL_ORDER[level] > LEVEL_ORDER[config.maxLevel] ? config.maxLevel : level;
}

// ── Auto-detect complexity ──

/**
 * Analyze user message to determine appropriate effort level.
 * Reference: Claude Code uses subscription tier + model; we use message content analysis.
 */
export function detectEffortLevel(message: string, hasTools: boolean = true): EffortLevel {
  if (!config.autoDetect) return capLevel(config.defaultLevel);

  const lower = message.toLowerCase();
  const wordCount = message.split(/\s+/).length;

  // Ultrathink keyword → max effort
  if (/\bultrathink\b/i.test(message)) {
    coworkLog('INFO', 'effortSystem', 'Ultrathink keyword detected → max effort');
    return capLevel('max');
  }

  // Simple greetings / short questions → low
  if (wordCount <= 5 && !hasTools) return capLevel('low');
  if (/^(hi|hello|hey|你好|谢谢|thanks|ok|好的)\s*[!?。！？]*$/i.test(lower.trim())) return capLevel('low');

  // Complex indicators → high
  const complexPatterns = [
    /\b(implement|refactor|architect|design|optimize|debug|analyze|review|compare|migrate)\b/i,
    /\b(实现|重构|设计|优化|调试|分析|对比|迁移)\b/,
    /\b(step.by.step|详细|thoroughly|comprehensive|in.depth)\b/i,
    /\bmulti[- ]?(step|file|module)\b/i,
  ];
  const isComplex = complexPatterns.some(p => p.test(message));

  // Long messages → higher effort
  if (wordCount > 100 || isComplex) return capLevel('high');
  if (wordCount > 30) return capLevel('medium');

  // Code-related → medium
  if (/```|`[^`]+`|\bfunction\b|\bclass\b|\bimport\b|\bconst\b/i.test(message)) {
    return capLevel('medium');
  }

  // Default
  return capLevel(config.defaultLevel);
}

// ── API parameter building ──

/**
 * Build effort-related API parameters.
 * Only sent for Anthropic direct mode (not OpenAI compat).
 */
export function buildEffortParams(level: EffortLevel, isOpenAICompat: boolean): {
  outputConfig?: Record<string, unknown>;
} {
  if (isOpenAICompat) return {}; // OpenAI models don't support effort parameter

  return {
    outputConfig: { effort: level },
  };
}

/**
 * Get human-readable description for effort level.
 */
export function describeEffort(level: EffortLevel): string {
  switch (level) {
    case 'low': return 'Quick response (minimal reasoning)';
    case 'medium': return 'Balanced (standard reasoning)';
    case 'high': return 'Thorough (deep reasoning)';
    case 'max': return 'Exhaustive (maximum reasoning depth)';
  }
}
