/**
 * Task Registry — in-memory registry for sub-agent tasks.
 * Tracks task lifecycle: queued → running → succeeded/failed/cancelled.
 *
 * Ported from OpenClaw src/tasks/task-registry.ts
 * Simplified for single-user Electron: no distributed ACP, no RPC.
 */

import { v4 as uuidv4 } from 'uuid';
import { coworkLog } from './coworkLogger';

// ── Task Types (from OpenClaw task-registry.types.ts) ──

export type TaskRuntime = 'subagent' | 'cron' | 'cli';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type TaskNotifyPolicy = 'done_only' | 'state_changes' | 'silent';

export interface TaskRecord {
  id: string;
  parentTaskId: string | null;
  parentSessionId: string | null;
  agentId: string;
  runtime: TaskRuntime;
  status: TaskStatus;
  goal: string;
  label: string;
  systemPrompt: string | null;
  toolWhitelist: string[] | null; // null = all tools
  model: string | null; // null = default model
  result: string | null;
  error: string | null;
  progress: string | null;
  notifyPolicy: TaskNotifyPolicy;
  timeoutMs: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface CreateTaskParams {
  parentTaskId?: string;
  parentSessionId?: string;
  agentId?: string;
  runtime?: TaskRuntime;
  goal: string;
  label?: string;
  systemPrompt?: string;
  toolWhitelist?: string[];
  model?: string;
  notifyPolicy?: TaskNotifyPolicy;
  timeoutMs?: number;
}

// ── Constants ──

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_LABEL_LENGTH = 80;

// ── In-memory registry ──

const tasks = new Map<string, TaskRecord>();
const tasksByParent = new Map<string, Set<string>>(); // parentTaskId → child task IDs

// ── Lifecycle functions ──

export function createTask(params: CreateTaskParams): TaskRecord {
  const id = uuidv4();
  const now = Date.now();

  const task: TaskRecord = {
    id,
    parentTaskId: params.parentTaskId ?? null,
    parentSessionId: params.parentSessionId ?? null,
    agentId: params.agentId ?? 'main',
    runtime: params.runtime ?? 'subagent',
    status: 'queued',
    goal: params.goal,
    label: (params.label ?? params.goal).slice(0, MAX_LABEL_LENGTH),
    systemPrompt: params.systemPrompt ?? null,
    toolWhitelist: params.toolWhitelist ?? null,
    model: params.model ?? null,
    result: null,
    error: null,
    progress: null,
    notifyPolicy: params.notifyPolicy ?? 'done_only',
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
  };

  tasks.set(id, task);

  // Track parent→child relationship
  if (task.parentTaskId) {
    let children = tasksByParent.get(task.parentTaskId);
    if (!children) {
      children = new Set();
      tasksByParent.set(task.parentTaskId, children);
    }
    children.add(id);
  }

  coworkLog('INFO', 'taskRegistry', `Task created: ${id} (${task.label})`, {
    agentId: task.agentId,
    runtime: task.runtime,
    parentTaskId: task.parentTaskId,
  });

  return task;
}

export function startTask(taskId: string): TaskRecord | null {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'queued') return null;

  task.status = 'running';
  task.startedAt = Date.now();
  task.updatedAt = Date.now();

  coworkLog('INFO', 'taskRegistry', `Task started: ${taskId}`);
  return task;
}

export function updateTaskProgress(taskId: string, progress: string): TaskRecord | null {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'running') return null;

  task.progress = progress;
  task.updatedAt = Date.now();
  return task;
}

export function completeTask(taskId: string, result: string): TaskRecord | null {
  const task = tasks.get(taskId);
  if (!task || (task.status !== 'running' && task.status !== 'queued')) return null;

  task.status = 'succeeded';
  task.result = result;
  task.completedAt = Date.now();
  task.updatedAt = Date.now();

  coworkLog('INFO', 'taskRegistry', `Task completed: ${taskId}`);
  return task;
}

export function failTask(taskId: string, error: string): TaskRecord | null {
  const task = tasks.get(taskId);
  if (!task || task.status === 'succeeded' || task.status === 'cancelled') return null;

  task.status = 'failed';
  task.error = error;
  task.completedAt = Date.now();
  task.updatedAt = Date.now();

  coworkLog('ERROR', 'taskRegistry', `Task failed: ${taskId}: ${error}`);
  return task;
}

export function timeoutTask(taskId: string): TaskRecord | null {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'running') return null;

  task.status = 'timed_out';
  task.error = `Task timed out after ${task.timeoutMs}ms`;
  task.completedAt = Date.now();
  task.updatedAt = Date.now();

  coworkLog('WARN', 'taskRegistry', `Task timed out: ${taskId}`);
  return task;
}

export function cancelTask(taskId: string): TaskRecord | null {
  const task = tasks.get(taskId);
  if (!task || task.status === 'succeeded' || task.status === 'failed') return null;

  task.status = 'cancelled';
  task.completedAt = Date.now();
  task.updatedAt = Date.now();

  coworkLog('INFO', 'taskRegistry', `Task cancelled: ${taskId}`);

  // Cascade cancel to children
  const children = tasksByParent.get(taskId);
  if (children) {
    for (const childId of children) {
      cancelTask(childId);
    }
  }

  return task;
}

// ── Query functions ──

export function getTask(taskId: string): TaskRecord | null {
  return tasks.get(taskId) ?? null;
}

export function getChildTasks(parentTaskId: string): TaskRecord[] {
  const childIds = tasksByParent.get(parentTaskId);
  if (!childIds) return [];
  return Array.from(childIds)
    .map(id => tasks.get(id))
    .filter((t): t is TaskRecord => t !== undefined);
}

export function getTasksBySession(sessionId: string): TaskRecord[] {
  return Array.from(tasks.values()).filter(t => t.parentSessionId === sessionId);
}

export function getActiveTasks(): TaskRecord[] {
  return Array.from(tasks.values()).filter(
    t => t.status === 'queued' || t.status === 'running'
  );
}

export function getAllTasks(limit: number = 50): TaskRecord[] {
  return Array.from(tasks.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function isActiveTask(status: TaskStatus): boolean {
  return status === 'queued' || status === 'running';
}

export function isTerminalTask(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
}

// ── Status formatting (from OpenClaw task-status.ts) ──

export function formatTaskStatusTitle(task: TaskRecord): string {
  return task.label.slice(0, MAX_LABEL_LENGTH);
}

export function formatTaskStatusDetail(task: TaskRecord): string {
  switch (task.status) {
    case 'queued': return 'Waiting to start...';
    case 'running': return task.progress || 'Running...';
    case 'succeeded': return task.result?.slice(0, 200) || 'Completed';
    case 'failed': return `Error: ${task.error || 'Unknown'}`;
    case 'timed_out': return `Timed out after ${Math.round(task.timeoutMs / 1000)}s`;
    case 'cancelled': return 'Cancelled';
  }
}

// ── Cleanup ──

export function clearCompletedTasks(olderThanMs: number = 3600_000): number {
  const cutoff = Date.now() - olderThanMs;
  let cleared = 0;

  for (const [id, task] of tasks) {
    if (isTerminalTask(task.status) && (task.completedAt ?? 0) < cutoff) {
      tasks.delete(id);
      if (task.parentTaskId) {
        tasksByParent.get(task.parentTaskId)?.delete(id);
      }
      cleared++;
    }
  }

  if (cleared > 0) {
    coworkLog('INFO', 'taskRegistry', `Cleared ${cleared} completed tasks`);
  }
  return cleared;
}

export function clearAllTasks(): void {
  tasks.clear();
  tasksByParent.clear();
}

// ── Auto-cleanup: clear completed tasks every 30 minutes ──

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    clearCompletedTasks(30 * 60 * 1000); // older than 30 min
  }, 30 * 60 * 1000);
}

export function stopAutoCleanup(): void {
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}
