/**
 * Risk Guard — enforces per-task frequency caps and anomaly cooldowns
 * for scenario automation runs. All decisions are local; no backend calls.
 *
 * State is persisted via a simple JSON file (no dependency on electron-store
 * so this compiles under the same tsconfig as the rest of src/main/libs).
 */

import fs from 'fs';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import type { RiskCaps, TaskRun, ScenarioTask } from './types';

export type AnomalyKind =
  | 'captcha'
  | 'login_wall'
  | 'rate_limited'
  | 'account_flag'
  | 'dom_missing'
  | 'upload_flagged';

interface GuardState {
  runs: Record<string, TaskRun[]>;       // task_id → recent runs (trimmed to 50)
  cooldowns: Record<string, number>;     // task_id → epoch ms when cooldown ends
}

let stateFilePath: string | null = null;
let state: GuardState = { runs: {}, cooldowns: {} };
let loaded = false;

/** Exposed so sidecar-server can check if init has been called. */
export let _loaded = false;

export function initRiskGuard(userDataPath: string): void {
  _loaded = true;
  stateFilePath = path.join(userDataPath, 'scenario-risk-guard.json');
  try {
    if (fs.existsSync(stateFilePath)) {
      const raw = fs.readFileSync(stateFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      state = {
        runs: parsed.runs || {},
        cooldowns: parsed.cooldowns || {},
      };
    }
  } catch (err) {
    coworkLog('WARN', 'riskGuard', 'failed to load state, starting fresh', { err: String(err) });
    state = { runs: {}, cooldowns: {} };
  }
  loaded = true;
}

function persist(): void {
  if (!stateFilePath) return;
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(state), 'utf8');
  } catch (err) {
    coworkLog('WARN', 'riskGuard', 'failed to persist state', { err: String(err) });
  }
}

function ensureLoaded(): void {
  if (!loaded) {
    throw new Error('riskGuard not initialized; call initRiskGuard() first');
  }
}

// ── Public API ──

export interface GateDecision {
  allowed: boolean;
  reason?: 'disabled';
  cooldown_ends_at?: number;
}

/**
 * Decide whether a task is allowed to run right now.
 *
 * v4.31.31: 全部预设 + 触发性风控砍掉 — 之前 manifest 写死 max_daily_runs=1
 *   / min_interval_hours=24 / weekly_rest_days=1 + cooldown_*_hours,导致
 *   wizard 给的 30min/1h/3h/6h 间隔形同虚设(scheduler 到点 → riskGuard
 *   silent skip → 用户感知"到点不动")。现在只保留 task.enabled gate,
 *   其余完全交给用户在 wizard 选的间隔。cooldown_active / daily_cap_reached
 *   / interval_not_met / weekly_rest_enforced 已废弃(reason 类型保留以免
 *   旧 UI 代码引用报错,但 canRunNow 永不返回它们)。
 */
export function canRunNow(task: ScenarioTask, _caps: RiskCaps): GateDecision {
  ensureLoaded();
  if (!task.enabled) return { allowed: false, reason: 'disabled' };
  return { allowed: true };
}

export function markRunStart(task_id: string): TaskRun {
  ensureLoaded();
  const run: TaskRun = { task_id, started_at: Date.now(), status: 'running' };
  state.runs[task_id] = (state.runs[task_id] || []).concat(run).slice(-50);
  persist();
  return run;
}

export function markRunSuccess(
  task_id: string,
  collected_count: number,
  draft_count: number,
  extras?: {
    action_counts?: Record<string, number>;
    tokens_used?: number;
    cost_usd?: number;
  },
): void {
  ensureLoaded();
  const runs = state.runs[task_id] || [];
  const latest = runs[runs.length - 1];
  if (latest && latest.status === 'running') {
    latest.status = 'ok';
    latest.ended_at = Date.now();
    latest.collected_count = collected_count;
    latest.draft_count = draft_count;
    // Optional richer telemetry — only set when present so pre-rollout
    // run rows stay free of empty objects.
    if (extras?.action_counts && Object.keys(extras.action_counts).length > 0) {
      latest.action_counts = extras.action_counts;
    }
    if (typeof extras?.tokens_used === 'number' && extras.tokens_used > 0) {
      latest.tokens_used = extras.tokens_used;
    }
    if (typeof extras?.cost_usd === 'number' && extras.cost_usd > 0) {
      latest.cost_usd = extras.cost_usd;
    }
    persist();
  }
}

export function markRunFailure(
  task_id: string,
  reason: string,
  extras?: {
    action_counts?: Record<string, number>;
    tokens_used?: number;
    cost_usd?: number;
  },
): void {
  ensureLoaded();
  const runs = state.runs[task_id] || [];
  const latest = runs[runs.length - 1];
  if (latest && latest.status === 'running') {
    latest.status = 'failed';
    latest.ended_at = Date.now();
    latest.reason = reason;
    // v5.x+: persist whatever counts the orchestrator already accumulated
    // before the failure / user-stop. Without this, manual stops at "已发
    // 20/30" silently drop +20 from the all-time aggregate (the bug user
    // saw: "累计 4" when one stopped run actually finished 20). Mirrors
    // markRunSuccess's extras handling — only set when present, so old
    // failure rows stay clean.
    if (extras?.action_counts && Object.keys(extras.action_counts).length > 0) {
      latest.action_counts = extras.action_counts;
    }
    if (typeof extras?.tokens_used === 'number' && extras.tokens_used > 0) {
      latest.tokens_used = extras.tokens_used;
    }
    if (typeof extras?.cost_usd === 'number' && extras.cost_usd > 0) {
      latest.cost_usd = extras.cost_usd;
    }
    persist();
  }
}

export function markRunSkipped(task_id: string, reason: string): void {
  ensureLoaded();
  const run: TaskRun = {
    task_id,
    started_at: Date.now(),
    ended_at: Date.now(),
    status: 'skipped',
    reason,
  };
  state.runs[task_id] = (state.runs[task_id] || []).concat(run).slice(-50);
  persist();
}

export function recordAnomaly(task_id: string, kind: AnomalyKind, _caps: RiskCaps): void {
  ensureLoaded();
  // v4.31.31: 风控砍光后,anomaly 不再写入 cooldown(canRunNow 也不再读它),
  //   只保留 WARN log 让用户在日志里能看到"撞了 captcha / 被限流",由用户自己
  //   决定是不是要手动停一下任务。state.cooldowns 不再增长。
  coworkLog('WARN', 'riskGuard', `anomaly recorded (cooldown disabled, task continues)`, { task_id, kind });
}

export function getRuns(task_id: string): TaskRun[] {
  ensureLoaded();
  return state.runs[task_id] || [];
}

/** Snapshot of EVERY recorded run across all tasks, with the originating
 *  taskId stamped on each entry. Used by the new "运行记录" page to show
 *  a unified history. Sorted newest-first for convenient rendering. */
export function getAllRuns(): Array<TaskRun & { task_id: string }> {
  ensureLoaded();
  const out: Array<TaskRun & { task_id: string }> = [];
  for (const [task_id, runs] of Object.entries(state.runs || {})) {
    if (!Array.isArray(runs)) continue;
    for (const r of runs) {
      out.push({ ...r, task_id });
    }
  }
  out.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
  return out;
}

export function getCooldown(task_id: string): number {
  ensureLoaded();
  return state.cooldowns[task_id] || 0;
}

export function clearCooldown(task_id: string): void {
  ensureLoaded();
  delete state.cooldowns[task_id];
  persist();
}
