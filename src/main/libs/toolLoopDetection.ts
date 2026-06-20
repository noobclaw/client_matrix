/**
 * Tool Loop Detection — prevents the AI from wasting tokens on repetitive tool calls.
 *
 * Detects patterns:
 * 1. Generic repeat: same tool+args called N times
 * 2. Ping-pong: alternating between 2 tools (e.g., Read→Edit→Read→Edit)
 * 3. Poll-no-progress: same tool called repeatedly with no meaningful change in results
 *
 * Reference: OpenClaw src/agents/tools/tool-loop-detection.ts
 */

import { coworkLog } from './coworkLogger';

export interface ToolCallRecord {
  toolName: string;
  inputHash: string;  // Hash of tool input for dedup
  resultHash: string; // Hash of tool result for progress detection
  timestamp: number;
}

export interface LoopDetector {
  recordCall(toolName: string, input: Record<string, unknown>, resultText: string): void;
  checkLoop(): LoopCheckResult;
  reset(): void;
}

export interface LoopCheckResult {
  detected: boolean;
  level: 'none' | 'warning' | 'critical' | 'circuit_breaker';
  pattern?: string;
  message?: string;
}

// ── Thresholds ──

const HISTORY_SIZE = 30;               // Track last 30 tool calls
const WARNING_THRESHOLD = 8;           // Warn at 8 repeated calls
const CRITICAL_THRESHOLD = 15;         // Stop at 15 repeated calls
const CIRCUIT_BREAKER_THRESHOLD = 25;  // Hard stop at 25
const PING_PONG_THRESHOLD = 6;         // 6 alternations = 12 calls
const POLL_NO_PROGRESS_THRESHOLD = 5;  // 5 identical results in a row

// ── Simple hash ──

function quickHash(str: string): string {
  let hash = 0;
  const s = str.slice(0, 2000); // Only hash first 2K chars for performance
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ── Detector ──

export function createLoopDetector(): LoopDetector {
  const history: ToolCallRecord[] = [];

  return {
    recordCall(toolName: string, input: Record<string, unknown>, resultText: string): void {
      const inputHash = quickHash(JSON.stringify(input));
      const resultHash = quickHash(resultText);

      history.push({ toolName, inputHash, resultHash, timestamp: Date.now() });

      // Keep only recent history
      if (history.length > HISTORY_SIZE) {
        history.shift();
      }
    },

    checkLoop(): LoopCheckResult {
      if (history.length < 4) return { detected: false, level: 'none' };

      // 1. Generic repeat: same tool+input called many times
      const lastCall = history[history.length - 1];
      let sameCount = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].toolName === lastCall.toolName && history[i].inputHash === lastCall.inputHash) {
          sameCount++;
        } else {
          break;
        }
      }

      if (sameCount >= CIRCUIT_BREAKER_THRESHOLD) {
        const msg = `Circuit breaker: ${lastCall.toolName} called ${sameCount} times with identical input`;
        coworkLog('ERROR', 'toolLoop', msg);
        return { detected: true, level: 'circuit_breaker', pattern: 'repeat', message: msg };
      }
      if (sameCount >= CRITICAL_THRESHOLD) {
        const msg = `Critical loop: ${lastCall.toolName} repeated ${sameCount} times`;
        coworkLog('WARN', 'toolLoop', msg);
        return { detected: true, level: 'critical', pattern: 'repeat', message: msg };
      }
      if (sameCount >= WARNING_THRESHOLD) {
        const msg = `Warning: ${lastCall.toolName} repeated ${sameCount} times`;
        coworkLog('INFO', 'toolLoop', msg);
        return { detected: true, level: 'warning', pattern: 'repeat', message: msg };
      }

      // 2. Ping-pong: alternating A→B→A→B
      if (history.length >= PING_PONG_THRESHOLD * 2) {
        const recent = history.slice(-PING_PONG_THRESHOLD * 2);
        const toolA = recent[recent.length - 2]?.toolName;
        const toolB = recent[recent.length - 1]?.toolName;
        if (toolA && toolB && toolA !== toolB) {
          let pingPongCount = 0;
          for (let i = recent.length - 1; i >= 1; i -= 2) {
            if (recent[i]?.toolName === toolB && recent[i - 1]?.toolName === toolA) {
              pingPongCount++;
            } else {
              break;
            }
          }
          if (pingPongCount >= PING_PONG_THRESHOLD) {
            const msg = `Ping-pong loop: ${toolA} ↔ ${toolB} (${pingPongCount} cycles)`;
            coworkLog('WARN', 'toolLoop', msg);
            return { detected: true, level: 'critical', pattern: 'ping-pong', message: msg };
          }
        }
      }

      // 3. Poll-no-progress: same tool, same results
      if (history.length >= POLL_NO_PROGRESS_THRESHOLD) {
        const recent = history.slice(-POLL_NO_PROGRESS_THRESHOLD);
        const allSameTool = recent.every(h => h.toolName === recent[0].toolName);
        const allSameResult = recent.every(h => h.resultHash === recent[0].resultHash);
        if (allSameTool && allSameResult) {
          const msg = `No progress: ${recent[0].toolName} returned identical results ${POLL_NO_PROGRESS_THRESHOLD} times`;
          coworkLog('WARN', 'toolLoop', msg);
          return { detected: true, level: 'critical', pattern: 'poll-no-progress', message: msg };
        }
      }

      return { detected: false, level: 'none' };
    },

    reset(): void {
      history.length = 0;
    },
  };
}
