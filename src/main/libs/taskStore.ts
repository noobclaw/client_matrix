/**
 * Task Store — SQLite persistence for sub-agent tasks and flows.
 * Ensures tasks survive process restarts and provides audit trail.
 *
 * Ported from OpenClaw src/tasks/task-registry.store.sqlite.ts
 */

import { coworkLog } from './coworkLogger';
import type { TaskRecord, TaskStatus, TaskRuntime, TaskNotifyPolicy } from './taskRegistry';
import type { TaskFlowRecord, FlowSyncMode, FlowStatus, TaskFlowStep } from './taskFlowRegistry';

// ── Database handle ──

let db: any = null;

export function initTaskStore(database: any): void {
  db = database;

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    parent_task_id TEXT,
    parent_session_id TEXT,
    agent_id TEXT NOT NULL DEFAULT 'main',
    runtime TEXT NOT NULL DEFAULT 'subagent',
    status TEXT NOT NULL DEFAULT 'queued',
    goal TEXT NOT NULL,
    label TEXT NOT NULL,
    system_prompt TEXT,
    tool_whitelist TEXT,
    model TEXT,
    result TEXT,
    error TEXT,
    progress TEXT,
    notify_policy TEXT NOT NULL DEFAULT 'done_only',
    timeout_ms INTEGER NOT NULL DEFAULT 300000,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS task_flows (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    sync_mode TEXT NOT NULL DEFAULT 'managed',
    status TEXT NOT NULL DEFAULT 'running',
    current_step INTEGER NOT NULL DEFAULT 0,
    steps TEXT NOT NULL DEFAULT '[]',
    task_ids TEXT NOT NULL DEFAULT '[]',
    blocked_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS task_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(parent_session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_task_flows_session ON task_flows(parent_session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_task_audit_task ON task_audit_log(task_id)`);

  coworkLog('INFO', 'taskStore', 'Task store initialized');
}

// ── Task CRUD ──

export function saveTask(task: TaskRecord): void {
  if (!db) return;
  db.run(`INSERT OR REPLACE INTO tasks
    (id, parent_task_id, parent_session_id, agent_id, runtime, status, goal, label,
     system_prompt, tool_whitelist, model, result, error, progress, notify_policy,
     timeout_ms, created_at, started_at, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [task.id, task.parentTaskId, task.parentSessionId, task.agentId, task.runtime,
     task.status, task.goal, task.label, task.systemPrompt,
     task.toolWhitelist ? JSON.stringify(task.toolWhitelist) : null,
     task.model, task.result, task.error, task.progress, task.notifyPolicy,
     task.timeoutMs, task.createdAt, task.startedAt, task.completedAt, task.updatedAt]
  );
}

export function loadTask(id: string): TaskRecord | null {
  if (!db) return null;
  const rows = db.exec(`SELECT * FROM tasks WHERE id = ?`, [id]);
  if (!rows[0]?.values?.[0]) return null;
  return rowToTask(rows[0].columns, rows[0].values[0]);
}

export function loadTasksBySession(sessionId: string): TaskRecord[] {
  if (!db) return [];
  const rows = db.exec(`SELECT * FROM tasks WHERE parent_session_id = ? ORDER BY created_at DESC`, [sessionId]);
  if (!rows[0]?.values) return [];
  return rows[0].values.map((v: any[]) => rowToTask(rows[0].columns, v));
}

export function loadRecentTasks(limit: number = 50): TaskRecord[] {
  if (!db) return [];
  const rows = db.exec(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`, [limit]);
  if (!rows[0]?.values) return [];
  return rows[0].values.map((v: any[]) => rowToTask(rows[0].columns, v));
}

export function updateTaskStatus(id: string, status: TaskStatus, updates: {
  result?: string; error?: string; progress?: string;
  startedAt?: number; completedAt?: number;
} = {}): void {
  if (!db) return;
  const now = Date.now();
  db.run(`UPDATE tasks SET status = ?, result = COALESCE(?, result), error = COALESCE(?, error),
    progress = COALESCE(?, progress), started_at = COALESCE(?, started_at),
    completed_at = COALESCE(?, completed_at), updated_at = ? WHERE id = ?`,
    [status, updates.result ?? null, updates.error ?? null, updates.progress ?? null,
     updates.startedAt ?? null, updates.completedAt ?? null, now, id]
  );
}

export function deleteOldTasks(olderThanMs: number = 24 * 60 * 60 * 1000): number {
  if (!db) return 0;
  const cutoff = Date.now() - olderThanMs;
  db.run(`DELETE FROM tasks WHERE status IN ('succeeded','failed','timed_out','cancelled') AND completed_at < ?`, [cutoff]);
  // sql.js doesn't easily return affected rows, estimate from before/after
  return 0;
}

// ── Flow CRUD ──

export function saveFlow(flow: TaskFlowRecord): void {
  if (!db) return;
  db.run(`INSERT OR REPLACE INTO task_flows
    (id, parent_session_id, goal, sync_mode, status, current_step, steps, task_ids,
     blocked_reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [flow.id, flow.parentSessionId, flow.goal, flow.syncMode, flow.status,
     flow.currentStep, JSON.stringify(flow.steps), JSON.stringify(flow.taskIds),
     flow.blockedReason, flow.createdAt, flow.updatedAt]
  );
}

export function loadFlow(id: string): TaskFlowRecord | null {
  if (!db) return null;
  const rows = db.exec(`SELECT * FROM task_flows WHERE id = ?`, [id]);
  if (!rows[0]?.values?.[0]) return null;
  return rowToFlow(rows[0].columns, rows[0].values[0]);
}

export function loadFlowsBySession(sessionId: string): TaskFlowRecord[] {
  if (!db) return [];
  const rows = db.exec(`SELECT * FROM task_flows WHERE parent_session_id = ? ORDER BY created_at DESC`, [sessionId]);
  if (!rows[0]?.values) return [];
  return rows[0].values.map((v: any[]) => rowToFlow(rows[0].columns, v));
}

// ── Audit Log ──

export function logTaskEvent(taskId: string, eventType: string, details?: string): void {
  if (!db) return;
  db.run(`INSERT INTO task_audit_log (task_id, event_type, details, created_at) VALUES (?, ?, ?, ?)`,
    [taskId, eventType, details ?? null, Date.now()]
  );
}

export function getTaskAuditLog(taskId: string, limit: number = 50): Array<{
  eventType: string; details: string | null; createdAt: number;
}> {
  if (!db) return [];
  const rows = db.exec(`SELECT event_type, details, created_at FROM task_audit_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`, [taskId, limit]);
  if (!rows[0]?.values) return [];
  return rows[0].values.map((v: any[]) => ({
    eventType: v[0] as string,
    details: v[1] as string | null,
    createdAt: v[2] as number,
  }));
}

// ── Maintenance ──

export function findOrphanedTasks(): TaskRecord[] {
  if (!db) return [];
  // Tasks that are 'running' but older than their timeout + 5 minutes
  const rows = db.exec(`SELECT * FROM tasks WHERE status = 'running' AND (started_at + timeout_ms + 300000) < ?`, [Date.now()]);
  if (!rows[0]?.values) return [];
  return rows[0].values.map((v: any[]) => rowToTask(rows[0].columns, v));
}

export function reconcileOrphanedTasks(): number {
  if (!db) return 0;
  const orphans = findOrphanedTasks();
  for (const task of orphans) {
    updateTaskStatus(task.id, 'failed', {
      error: 'Task orphaned — exceeded timeout without completion',
      completedAt: Date.now(),
    });
    logTaskEvent(task.id, 'reconcile', 'Marked as failed: orphaned task');
  }
  coworkLog('INFO', 'taskStore', `Reconciled ${orphans.length} orphaned tasks`);
  return orphans.length;
}

// ── Row converters ──

function rowToTask(columns: string[], values: any[]): TaskRecord {
  const obj: Record<string, any> = {};
  columns.forEach((col, i) => obj[col] = values[i]);
  return {
    id: obj.id,
    parentTaskId: obj.parent_task_id,
    parentSessionId: obj.parent_session_id,
    agentId: obj.agent_id,
    runtime: obj.runtime as TaskRuntime,
    status: obj.status as TaskStatus,
    goal: obj.goal,
    label: obj.label,
    systemPrompt: obj.system_prompt,
    toolWhitelist: obj.tool_whitelist ? JSON.parse(obj.tool_whitelist) : null,
    model: obj.model,
    result: obj.result,
    error: obj.error,
    progress: obj.progress,
    notifyPolicy: obj.notify_policy as TaskNotifyPolicy,
    timeoutMs: obj.timeout_ms,
    createdAt: obj.created_at,
    startedAt: obj.started_at,
    completedAt: obj.completed_at,
    updatedAt: obj.updated_at,
  };
}

function rowToFlow(columns: string[], values: any[]): TaskFlowRecord {
  const obj: Record<string, any> = {};
  columns.forEach((col, i) => obj[col] = values[i]);
  return {
    id: obj.id,
    parentSessionId: obj.parent_session_id,
    goal: obj.goal,
    syncMode: obj.sync_mode as FlowSyncMode,
    status: obj.status as FlowStatus,
    currentStep: obj.current_step,
    steps: JSON.parse(obj.steps || '[]'),
    taskIds: JSON.parse(obj.task_ids || '[]'),
    blockedReason: obj.blocked_reason,
    createdAt: obj.created_at,
    updatedAt: obj.updated_at,
  };
}
