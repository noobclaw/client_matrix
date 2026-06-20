/**
 * Dreaming Engine — 3-phase background memory processing.
 * Runs on cron schedules to consolidate, analyze, and find patterns in memories.
 *
 * Phase 1 (Light): Every 6h — dedup similar memories
 * Phase 2 (Deep): Daily 3AM — analyze high-frequency memories
 * Phase 3 (REM): Weekly Sunday 5AM — detect behavioral patterns
 *
 * Ported from OpenClaw src/memory-host-sdk/dreaming.ts
 */

import { coworkLog } from './coworkLogger';
import {
  getRecentMemories,
  getHighFrequencyMemories,
  getMemoriesByType,
  mergeMemories,
  storeMemory,
  storeBehavioralPattern,
  type MemoryRecord,
} from './memoryStore';
import { createMessage, getAnthropicClient, type ApiConfig } from './anthropicClient';
import { getCurrentApiConfig } from './claudeSettings';

// ── Configuration ──
// Reference: OpenClaw dreaming.ts resolveMemoryDreamingConfig()

export interface DreamingConfig {
  enabled: boolean;
  lightIntervalMs: number;      // default: 6 hours
  deepCronHour: number;         // default: 3 (3AM)
  remCronDay: number;           // default: 0 (Sunday)
  remCronHour: number;          // default: 5 (5AM)
  lightDedupThreshold: number;  // default: 0.9 (similarity)
  deepMinScore: number;         // default: 0.8
  deepMinRecalls: number;       // default: 3
  deepMinUniqueQueries: number; // default: 3
  remMinPatternStrength: number;// default: 0.75
  verboseLogging: boolean;
}

const DEFAULT_CONFIG: DreamingConfig = {
  enabled: true,
  lightIntervalMs: 6 * 60 * 60 * 1000,  // 6 hours
  deepCronHour: 3,
  remCronDay: 0,
  remCronHour: 5,
  lightDedupThreshold: 0.9,
  deepMinScore: 0.8,
  deepMinRecalls: 3,
  deepMinUniqueQueries: 3,
  remMinPatternStrength: 0.75,
  verboseLogging: false,
};

// ── Phase results ──

export interface DreamingPhaseResult {
  phase: 'light' | 'deep' | 'rem';
  startedAt: number;
  completedAt: number;
  memoriesProcessed: number;
  memoriesMerged: number;
  memoriesCreated: number;
  memoriesDecayed: number;
  error?: string;
}

// ── Engine state ──

let config = { ...DEFAULT_CONFIG };
let lightTimer: ReturnType<typeof setInterval> | null = null;
let deepTimer: ReturnType<typeof setTimeout> | null = null;
let remTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;

// ── Start / Stop ──

export function startDreamingEngine(customConfig?: Partial<DreamingConfig>): void {
  if (isRunning) return;

  if (customConfig) {
    config = { ...DEFAULT_CONFIG, ...customConfig };
  }

  if (!config.enabled) {
    coworkLog('INFO', 'dreamingEngine', 'Dreaming engine disabled');
    return;
  }

  isRunning = true;
  coworkLog('INFO', 'dreamingEngine', 'Starting Dreaming engine', {
    lightInterval: `${config.lightIntervalMs / 3600000}h`,
    deepHour: config.deepCronHour,
    remDay: config.remCronDay,
    remHour: config.remCronHour,
  });

  // Light Dreaming: repeating interval
  lightTimer = setInterval(() => {
    runLightDreaming().catch(e =>
      coworkLog('ERROR', 'dreamingEngine', `Light dreaming error: ${e}`)
    );
  }, config.lightIntervalMs);

  // Deep Dreaming: schedule next occurrence
  scheduleDeep();

  // REM Dreaming: schedule next occurrence
  scheduleREM();

  // Run initial light dreaming after 5 minutes
  setTimeout(() => {
    runLightDreaming().catch(e =>
      coworkLog('ERROR', 'dreamingEngine', `Initial light dreaming error: ${e}`)
    );
  }, 5 * 60 * 1000);
}

export function stopDreamingEngine(): void {
  if (lightTimer) clearInterval(lightTimer);
  if (deepTimer) clearTimeout(deepTimer);
  if (remTimer) clearTimeout(remTimer);
  lightTimer = null;
  deepTimer = null;
  remTimer = null;
  isRunning = false;
  coworkLog('INFO', 'dreamingEngine', 'Dreaming engine stopped');
}

export function getDreamingStatus(): { running: boolean; config: DreamingConfig } {
  return { running: isRunning, config };
}

// ── Phase 1: Light Dreaming ──
// Reference: OpenClaw — every 6h, dedup similar memories (0.9 threshold)

export async function runLightDreaming(): Promise<DreamingPhaseResult> {
  const startedAt = Date.now();
  coworkLog('INFO', 'dreamingEngine', 'Starting Light Dreaming phase');

  const twoDay = 2 * 24 * 60 * 60 * 1000;
  const recent = getRecentMemories(twoDay, 100);

  let merged = 0;
  const processed = recent.length;

  // Dedup: find pairs with high similarity
  const toMerge: Array<[MemoryRecord, MemoryRecord]> = [];
  const alreadyMerged = new Set<string>();

  for (let i = 0; i < recent.length; i++) {
    if (alreadyMerged.has(recent[i].id)) continue;
    for (let j = i + 1; j < recent.length; j++) {
      if (alreadyMerged.has(recent[j].id)) continue;
      const sim = cosineSimilarity(recent[i].content, recent[j].content);
      if (sim >= config.lightDedupThreshold) {
        toMerge.push([recent[i], recent[j]]);
        alreadyMerged.add(recent[j].id);
      }
    }
  }

  // Merge similar pairs
  for (const [keep, dup] of toMerge) {
    const mergedContent = keep.content.length >= dup.content.length ? keep.content : dup.content;
    mergeMemories(keep.id, [keep.id, dup.id], mergedContent);
    merged++;
  }

  const result: DreamingPhaseResult = {
    phase: 'light',
    startedAt,
    completedAt: Date.now(),
    memoriesProcessed: processed,
    memoriesMerged: merged,
    memoriesCreated: 0,
    memoriesDecayed: 0,
  };

  coworkLog('INFO', 'dreamingEngine', `Light Dreaming complete: ${processed} processed, ${merged} merged`);
  return result;
}

// ── Phase 2: Deep Dreaming ──
// Reference: OpenClaw — daily 3AM, high-frequency analysis

export async function runDeepDreaming(): Promise<DreamingPhaseResult> {
  const startedAt = Date.now();
  coworkLog('INFO', 'dreamingEngine', 'Starting Deep Dreaming phase');

  const highFreq = getHighFrequencyMemories(
    config.deepMinRecalls,
    config.deepMinUniqueQueries,
    10
  );

  let created = 0;

  if (highFreq.length >= 2) {
    // Use LLM to synthesize insights from high-frequency memories
    try {
      const apiConfig = getCurrentApiConfig();
      if (apiConfig?.apiKey) {
        const client = getAnthropicClient({
          apiKey: apiConfig.apiKey,
          baseUrl: apiConfig.baseURL,
          model: apiConfig.model || 'claude-sonnet-4-20250514',
        });

        const memoryTexts = highFreq.map((m, i) => `${i + 1}. [${m.type}] ${m.content} (recalled ${m.recallCount}x)`).join('\n');

        const response = await createMessage({
          client,
          model: apiConfig.model || 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a memory consolidation system. Analyze frequently accessed memories and generate concise insights. Output only the insights, one per line.',
          messages: [{ role: 'user', content: `Analyze these frequently accessed memories and generate 1-3 key insights:\n\n${memoryTexts}` }],
          tools: [],
          maxTokens: 1024,
        });

        const insights = response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
          .split('\n')
          .filter((l: string) => l.trim().length > 10);

        for (const insight of insights.slice(0, 3)) {
          storeMemory({
            type: 'semantic',
            content: insight.trim(),
            score: 0.85,
            tags: ['deep-dreaming', 'synthesized'],
          });
          created++;
        }
      }
    } catch (e) {
      coworkLog('WARN', 'dreamingEngine', `Deep Dreaming LLM call failed: ${e}`);
    }
  }

  const result: DreamingPhaseResult = {
    phase: 'deep',
    startedAt,
    completedAt: Date.now(),
    memoriesProcessed: highFreq.length,
    memoriesMerged: 0,
    memoriesCreated: created,
    memoriesDecayed: 0,
  };

  coworkLog('INFO', 'dreamingEngine', `Deep Dreaming complete: ${highFreq.length} analyzed, ${created} insights created`);
  return result;
}

// ── Phase 3: REM Dreaming ──
// Reference: OpenClaw — weekly Sunday 5AM, behavioral pattern detection

export async function runREMDreaming(): Promise<DreamingPhaseResult> {
  const startedAt = Date.now();
  coworkLog('INFO', 'dreamingEngine', 'Starting REM Dreaming phase');

  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const weekMemories = getRecentMemories(sevenDays, 200);

  let created = 0;

  if (weekMemories.length >= 5) {
    try {
      const apiConfig = getCurrentApiConfig();
      if (apiConfig?.apiKey) {
        const client = getAnthropicClient({
          apiKey: apiConfig.apiKey,
          baseUrl: apiConfig.baseURL,
          model: apiConfig.model || 'claude-sonnet-4-20250514',
        });

        const memoryTexts = weekMemories.slice(0, 50).map((m, i) =>
          `${i + 1}. [${m.type}] ${m.content}`
        ).join('\n');

        const response = await createMessage({
          client,
          model: apiConfig.model || 'claude-sonnet-4-20250514',
          systemPrompt: 'You are a behavioral pattern analyzer. Identify recurring behavioral patterns from memory records. Output JSON array: [{"description": "...", "strength": 0.0-1.0}]',
          messages: [{ role: 'user', content: `Identify behavioral patterns in these memories from the past week:\n\n${memoryTexts}\n\nOutput JSON array only.` }],
          tools: [],
          maxTokens: 1024,
        });

        const text = response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');

        try {
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const patterns = JSON.parse(jsonMatch[0]);
            for (const p of patterns) {
              if (p.strength >= config.remMinPatternStrength) {
                storeBehavioralPattern({
                  description: p.description,
                  strength: p.strength,
                  supportingMemoryIds: [],
                  detectedAt: Date.now(),
                });
                created++;
              }
            }
          }
        } catch { /* JSON parse error */ }
      }
    } catch (e) {
      coworkLog('WARN', 'dreamingEngine', `REM Dreaming LLM call failed: ${e}`);
    }
  }

  const result: DreamingPhaseResult = {
    phase: 'rem',
    startedAt,
    completedAt: Date.now(),
    memoriesProcessed: weekMemories.length,
    memoriesMerged: 0,
    memoriesCreated: created,
    memoriesDecayed: 0,
  };

  coworkLog('INFO', 'dreamingEngine', `REM Dreaming complete: ${weekMemories.length} analyzed, ${created} patterns found`);
  return result;
}

// ── Manual trigger ──

export async function triggerPhase(phase: 'light' | 'deep' | 'rem'): Promise<DreamingPhaseResult> {
  switch (phase) {
    case 'light': return runLightDreaming();
    case 'deep': return runDeepDreaming();
    case 'rem': return runREMDreaming();
  }
}

// ── Scheduling helpers ──

function scheduleDeep(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(config.deepCronHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  const delay = next.getTime() - now.getTime();

  deepTimer = setTimeout(() => {
    runDeepDreaming().catch(e =>
      coworkLog('ERROR', 'dreamingEngine', `Deep dreaming error: ${e}`)
    );
    scheduleDeep(); // Reschedule
  }, delay);
}

function scheduleREM(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(config.remCronHour, 0, 0, 0);
  // Find next target day (0=Sunday)
  let daysUntil = (config.remCronDay - now.getDay() + 7) % 7;
  next.setDate(now.getDate() + daysUntil);
  // If same day but time already passed, push to next week
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 7);
  }
  const delay = next.getTime() - now.getTime();

  remTimer = setTimeout(() => {
    runREMDreaming().catch(e =>
      coworkLog('ERROR', 'dreamingEngine', `REM dreaming error: ${e}`)
    );
    scheduleREM(); // Reschedule
  }, delay);
}

// ── Similarity (simple word overlap cosine) ──

function cosineSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const denominator = Math.sqrt(wordsA.size) * Math.sqrt(wordsB.size);
  return denominator > 0 ? intersection / denominator : 0;
}

// ── Auto Dream: background memory consolidation ──
// Reference: Claude Code src/services/autoDream/autoDream.ts
// Triggers: >24h since last consolidation AND >5 new sessions

let lastConsolidatedAt = 0;
let sessionCountSinceConsolidate = 0;
const AUTO_DREAM_MIN_HOURS = 24;
const AUTO_DREAM_MIN_SESSIONS = 5;

/**
 * Call after each session completes to check if auto-consolidation should run.
 */
export function checkAutoDreamTrigger(): boolean {
  sessionCountSinceConsolidate++;

  // Time gate
  const hoursSince = (Date.now() - lastConsolidatedAt) / 3_600_000;
  if (hoursSince < AUTO_DREAM_MIN_HOURS) return false;

  // Session gate
  if (sessionCountSinceConsolidate < AUTO_DREAM_MIN_SESSIONS) return false;

  // Trigger!
  coworkLog('INFO', 'dreamingEngine', `Auto Dream triggered: ${hoursSince.toFixed(1)}h since last, ${sessionCountSinceConsolidate} sessions`);

  // Run Light Dreaming in background
  runLightDreaming().then(result => {
    lastConsolidatedAt = Date.now();
    sessionCountSinceConsolidate = 0;
    coworkLog('INFO', 'dreamingEngine', `Auto Dream complete: ${result.memoriesProcessed} processed, ${result.memoriesMerged} merged`);
  }).catch(e => {
    coworkLog('ERROR', 'dreamingEngine', `Auto Dream failed: ${e}`);
  });

  return true;
}

/**
 * Set the last consolidation timestamp (e.g., loaded from persistence).
 */
export function setLastConsolidatedAt(timestamp: number): void {
  lastConsolidatedAt = timestamp;
}
