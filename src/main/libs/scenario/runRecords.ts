/**
 * runRecords.ts — persistent log of every task run, with full snapshots.
 *
 * Pre-v2.4.22 the only persisted "run" data was scenarioRiskGuard.runs,
 * which only stored counts (collected_count, draft_count) + status. No
 * step logs, no task snapshot, no output dir. Users couldn't review
 * "what exactly did task X do at 14:32 yesterday?" — the data wasn't
 * there.
 *
 * This module records a richer per-run snapshot:
 *   - id            random uuid
 *   - task_id       which task ran
 *   - task_snapshot copy of the task config AT RUN TIME (not "now") —
 *                   even if the user later edits or deletes the task,
 *                   the historical record is preserved correctly.
 *   - scenario_snap minimal scenario info (id, platform, name, icon)
 *   - started_at    ms epoch
 *   - finished_at   ms epoch (undefined while running)
 *   - status        running | done | partial | error | stopped
 *                   ('partial' = ran to completion but only some of the
 *                    intended items succeeded — e.g. 2/5 tweets posted,
 *                    3/5 解构失败. Distinct from 'done' so users can
 *                    spot half-broken runs in the history list at a
 *                    glance instead of trusting the green checkmark.)
 *   - error         error message if status === 'error' | 'stopped' | 'partial'
 *   - step_logs     [{step, status, message, time}] — deep-cloned from
 *                   the live progress at finish time
 *   - result        { collected_count, draft_count, ... }
 *   - output_dir    absolute path on disk for the user to inspect
 *
 * Storage: <userDataPath>/scenario_run_records.json (single JSON file,
 * deserialized on first access, persisted on every mutation).
 *
 * Records are READ-ONLY from the user's perspective — the UI
 * (RunRecordDetailPage) only renders them; no edit / re-run / delete
 * buttons. Tasks themselves still live in taskStore and remain
 * editable / deletable independently.
 *
 * To keep the file from growing unboundedly we cap to MAX_RECORDS most-
 * recent entries (default 500). Older records get evicted FIFO.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { ScenarioTask } from './types';

const MAX_RECORDS = 500;

export interface StepLogEntry {
  time: string;        // "HH:MM:SS"
  step: number;        // 1-based
  status: 'done' | 'running' | 'error';
  message: string;
}

export interface RunRecord {
  id: string;
  task_id: string;
  task_snapshot: Partial<ScenarioTask>;
  scenario_snapshot: {
    id: string;
    platform: string;
    name_zh?: string;
    name_en?: string;
    icon?: string;
    workflow_type?: string;
  };
  started_at: number;
  finished_at?: number;
  status: 'running' | 'done' | 'partial' | 'error' | 'stopped';
  error?: string;
  /** v5.x+: 成功摘要 — orchestrator `ctx.finish('done', msg)` 传的 msg
   *  会落到这里(而不是 error),让 UI 在 status=done 时显示绿色成功摘要、
   *  status=error 时才显示红色错误。之前所有都进 error,导致"成功"卡片
   *  顶着"错误: 1/1 条搬运发布成功"这种自相矛盾的文案。 */
  summary?: string;
  step_logs: StepLogEntry[];
  result?: {
    collected_count?: number;
    draft_count?: number;
    posted?: number;
    /** Per-action counts for this run (e.g. {like:5, follow:3, comment:4}).
     *  Set by orchestrators via ctx.addActionCount(). Used by the task
     *  detail page to compute 累计完成 / 上次完成. */
    action_counts?: Record<string, number>;
    /** Per-action planned targets for this run (e.g. {like:32, follow:5,
     *  comment:2}). Declared by orchestrators via ctx.setActionTargets() at
     *  run start; pulled from RunProgress.action_progress[k].target at
     *  finish time so the run history row can render "X/Y" (actually-done
     *  over planned) without re-fetching live progress. */
    action_targets?: Record<string, number>;
    tokens_used?: number;
    cost_usd?: number;
    [k: string]: any;
  };
  output_dir?: string;
}

let _filePath: string | null = null;
let _records: RunRecord[] = [];
let _loaded = false;

function getFilePath(userDataPath: string): string {
  if (!_filePath) {
    _filePath = path.join(userDataPath, 'scenario_run_records.json');
  }
  return _filePath;
}

function load(userDataPath: string): void {
  if (_loaded) return;
  const fp = getFilePath(userDataPath);
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) _records = parsed;
    }
  } catch {
    _records = [];
  }
  _loaded = true;
}

function persist(): void {
  if (!_filePath) return;
  try {
    // FIFO cap — keep the MAX_RECORDS most recent (sorted by started_at desc).
    if (_records.length > MAX_RECORDS) {
      _records.sort((a, b) => b.started_at - a.started_at);
      _records = _records.slice(0, MAX_RECORDS);
    }
    fs.writeFileSync(_filePath, JSON.stringify(_records, null, 2), 'utf-8');
    _dirty = false;
  } catch (e) {
    // Non-fatal: failing to persist a record shouldn't break the run.
    console.error('[runRecords] persist failed:', e);
  }
}

// ── Debounced persist for step logs ──
//
// v2.4.34 perf fix: appendStepLog used to call persist() on EVERY single
// step log entry. With a multi-MB JSON file (500 records × hundreds of
// logs each = several MB) and synchronous fs.writeFileSync, that's
// 50ms+ per call × dozens of step logs per minute = the sidecar event
// loop got blocked enough that listRunRecords IPC responses lagged 30s+,
// making the History page look "stuck not refreshing" even though the
// data WAS in memory.
//
// New strategy:
//   - startRecord / finishRecord  → persist immediately (terminal events
//                                    we don't want to lose to a crash)
//   - appendStepLog               → mark dirty, schedule a debounced
//                                    flush 2s later (cheap; if many
//                                    logs land back-to-back we coalesce
//                                    into one disk write)
//   - finishRecord                → also force-flushes any pending
//                                    debounce so the terminal status is
//                                    on disk before we return
let _dirty = false;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 2000;

function scheduleDebouncedPersist(): void {
  _dirty = true;
  if (_flushTimer) return; // already scheduled
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    if (_dirty) persist();
  }, FLUSH_DEBOUNCE_MS);
}

function flushPending(): void {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  if (_dirty) persist();
}

/** Merge `partial` into `target`, treating `undefined` values as "no update".
 *
 *  Use this instead of `{ ...target, ...partial }` when callers may legitimately
 *  pass undefined for fields they want to leave alone. Plain spread writes
 *  the undefined key VERBATIM (it does NOT skip it), silently erasing any
 *  prior value at that key. Real bug we hit in this codebase: live mirror
 *  writes `rec.result.action_counts = {post: 3}` mid-run; finishRecord
 *  later patches with `action_counts: undefined` on failure paths → spread
 *  wipes the mirror → UI shows "上次完成 0" even though 3 posts went out.
 *
 *  Edge cases handled:
 *   - target undefined → start from {} so the merged object always exists
 *   - partial undefined / null → no-op, return existing target shallow copy
 *   - explicit `null` in partial → written through (distinct from undefined;
 *     callers wanting to clear a field should pass null, not undefined)
 */
function mergeDefined<T extends Record<string, any>>(
  target: T | undefined,
  partial: T | undefined,
): T {
  const out = { ...(target || {}) } as T;
  if (!partial) return out;
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) (out as Record<string, any>)[k] = v;
  }
  return out;
}

let _initOnce = false;
/** Initialize on app boot. Safe to call multiple times — only the first
 *  call performs the stale-running sweep.
 *
 *  STALE-RUNNING SWEEP (one-time on first init):
 *  At app startup, nothing is actually running yet (tasks live in process
 *  memory, not on disk). So ANY record still flagged "running" must be
 *  from a previous app session that didn't get a chance to finalize —
 *  app crash, app force-quit, OS kill, power loss. Mark them all as
 *  "stopped" with reason "app_restart_or_crash" so they don't show as
 *  ghost "running" rows in the History page forever.
 *
 *  Only sweep on the FIRST init call (not on subsequent re-inits during
 *  the same app session) — otherwise actively-running records would get
 *  wiped mid-run. */
export function initRunRecords(userDataPath: string): void {
  load(userDataPath);
  if (_initOnce) return;
  _initOnce = true;
  const now = Date.now();
  let touched = false;
  for (const rec of _records) {
    if (rec.status === 'running') {
      rec.status = 'stopped';
      rec.error = 'app_restart_or_crash';
      rec.finished_at = now;
      touched = true;
    }
  }
  if (touched) persist();
}

/**
 * Start a new record. Returns the record id; the caller should hold on
 * to it for subsequent updateRecordStep / finishRecord calls.
 */
export function startRecord(args: {
  task: ScenarioTask;
  scenario: { id: string; platform: string; name_zh?: string; name_en?: string; icon?: string; workflow_type?: string } | null;
  output_dir?: string;
}): string {
  if (!_loaded) return ''; // safety: don't write if not initialized
  const id = randomUUID();
  const rec: RunRecord = {
    id,
    task_id: args.task.id,
    task_snapshot: { ...args.task },
    scenario_snapshot: args.scenario || {
      id: args.task.scenario_id,
      platform: '',
    },
    started_at: Date.now(),
    status: 'running',
    step_logs: [],
    output_dir: args.output_dir,
  };
  _records.push(rec);
  persist();
  return id;
}

/** Append a step log entry to a running record. v2.4.34: persist is
 *  debounced (2s coalesced flush) to avoid blocking the sidecar event
 *  loop with synchronous multi-MB JSON writes on every log entry. */
export function appendStepLog(recordId: string, entry: StepLogEntry): void {
  if (!_loaded || !recordId) return;
  const rec = _records.find(r => r.id === recordId);
  if (!rec) return;
  rec.step_logs.push(entry);
  // Cap step_logs per record so a chatty run doesn't blow up the file
  if (rec.step_logs.length > 500) rec.step_logs.splice(0, rec.step_logs.length - 500);
  scheduleDebouncedPersist();
}

/**
 * Patch live result counts (action_counts / action_targets / tokens_used /
 * cost_usd) WITHOUT marking the record finished. Used while a task is in
 * flight so the run history list shows real-time "X/Y" and "💎 N" for
 * the still-running row. Lightweight: only merges into rec.result and
 * schedules a debounced persist — does NOT force-flush like finishRecord,
 * so calling it on every per-action bump is cheap.
 */
export function updateRecordResult(
  recordId: string,
  partial: NonNullable<RunRecord['result']>
): void {
  if (!_loaded || !recordId) return;
  const rec = _records.find(r => r.id === recordId);
  if (!rec) return;
  // ⚠️ JS spread footgun: `{ ...{a: undefined} }` writes the key as undefined
  // (it doesn't skip it), which silently ERASES previously-written values.
  // Real repro from this codebase: the live mirror sets
  //   rec.result.action_counts = {post: 3}
  // mid-run, then finishRecord (or another partial update) is called with
  // action_counts: undefined — plain spread would wipe the {post:3} we
  // mirrored. mergeDefined preserves existing fields when the patch is
  // undefined, treating undefined as "no update for this key".
  rec.result = mergeDefined(rec.result, partial);
  scheduleDebouncedPersist();
}

/**
 * Finish a record with terminal status + optional result counts. Idempotent
 * — calling twice is safe; second call wins (e.g. if the orchestrator path
 * sets 'done' but a later catch sets 'error', we want the catch).
 */
export function finishRecord(recordId: string, args: {
  /** Pass undefined to leave existing status untouched (used when only
   *  patching result counts after the status was already finalized). */
  status?: 'done' | 'partial' | 'error' | 'stopped';
  error?: string;
  /** v5.x+: 成功摘要(对应 orchestrator 的 ctx.finish('done', msg))。 */
  summary?: string;
  result?: RunRecord['result'];
  output_dir?: string;
}): void {
  if (!_loaded || !recordId) return;
  const rec = _records.find(r => r.id === recordId);
  if (!rec) return;
  if (args.status) {
    rec.status = args.status;
    rec.finished_at = Date.now();
  }
  if (args.error) rec.error = args.error;
  if (args.summary) rec.summary = args.summary;
  // Same footgun guard as updateRecordResult — terminal patches must not
  // erase counts the live mirror already wrote.
  if (args.result) rec.result = mergeDefined(rec.result, args.result);
  if (args.output_dir) rec.output_dir = args.output_dir;
  // Force-flush any pending debounced step-log writes too, so the
  // terminal status hits disk in a single atomic write together with
  // any in-flight log entries.
  flushPending();
  persist();

  // 异步 fire-and-forget 上报到后端 user_task_runs(admin 巡检用)。只在记录
  // 已进入终态时调度;debounce 会确保同一 run 的多次 finishRecord(先 status
  // 后 result)只发最后一次最全快照。这一步绝不 await、绝不 throw —— 上报失败
  // 不能反噬用户任务执行(用户硬约束)。仅 scenario 任务走 runRecords,天然隔离。
  if (rec.status !== 'running') {
    try {
      const { scheduleRunReport } = require('./taskRunReporter');
      scheduleRunReport(rec);
    } catch { /* non-fatal */ }
  }
}

/** All records, newest-first. Used by the Run History page.
 *
 *  v2.4.35 — `light: true` strips the heavy fields (step_logs, full
 *  task_snapshot) so the list-view payload stays tiny. Without this,
 *  a user with 50+ rich records was transferring multiple MB every
 *  2-second poll → UI felt sluggish, "刚跑完的记录很久才出现". The
 *  detail page still fetches the full record via getRecord(id). */
export function listRecords(filter?: {
  task_id?: string;
  platform?: string;
  light?: boolean;
}): RunRecord[] {
  if (!_loaded) return [];
  let out = [..._records];
  if (filter?.task_id) out = out.filter(r => r.task_id === filter.task_id);
  if (filter?.platform) out = out.filter(r => r.scenario_snapshot.platform === filter.platform);
  out.sort((a, b) => b.started_at - a.started_at);
  if (filter?.light) {
    // Return only what the list page renders. RunHistoryPage.tsx
    // consumes: id, task_id, scenario_snapshot, started_at, finished_at,
    // status, error, result, output_dir, task_snapshot.{track, urls},
    // step_logs.length (just the count, not the entries).
    return out.map(r => ({
      id: r.id,
      task_id: r.task_id,
      task_snapshot: {
        track: (r.task_snapshot as any)?.track,
        urls: (r.task_snapshot as any)?.urls,
      } as any,
      scenario_snapshot: r.scenario_snapshot,
      started_at: r.started_at,
      finished_at: r.finished_at,
      status: r.status,
      error: r.error,
      step_logs: { length: r.step_logs.length } as any, // fake array for .length access
      result: r.result,
      output_dir: r.output_dir,
    } as RunRecord));
  }
  return out;
}

/** Single record lookup. */
export function getRecord(id: string): RunRecord | null {
  if (!_loaded) return null;
  return _records.find(r => r.id === id) || null;
}

/** For tests / hot-reload only — not exposed via IPC. */
export function _resetForTests(): void {
  _records = [];
  _loaded = false;
  _filePath = null;
}
