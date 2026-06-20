/**
 * Task Store — local persistence for scenario tasks + generated drafts.
 *
 * Stored as two JSON files in the app userData dir to keep the change
 * surface small. If we later want to move this into sql.js (like cowork
 * sessions) the API can stay the same.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { coworkLog } from '../coworkLogger';
import type { ScenarioTask, Draft } from './types';

interface StoreShape {
  tasks: ScenarioTask[];
  drafts: Draft[];
  seen_post_ids: Record<string, string[]>; // task_id → list of seen post ids (capped at 500)
}

let storePath: string | null = null;
let store: StoreShape = { tasks: [], drafts: [], seen_post_ids: {} };
let loaded = false;

/** Exposed so sidecar-server can check if init has been called. */
export let _loaded = false;

const MAX_SEEN_PER_TASK = 500;
const MAX_DRAFTS_PER_TASK = 200;

export function initTaskStore(userDataPath: string): void {
  _loaded = true;
  storePath = path.join(userDataPath, 'scenario-task-store.json');
  try {
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = JSON.parse(raw);
      store = {
        tasks: parsed.tasks || [],
        drafts: parsed.drafts || [],
        seen_post_ids: parsed.seen_post_ids || {},
      };
    }
  } catch (err) {
    coworkLog('WARN', 'taskStore', 'failed to load store, starting fresh', { err: String(err) });
    store = { tasks: [], drafts: [], seen_post_ids: {} };
  }
  loaded = true;
}

function persist(): void {
  if (!storePath) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(store), 'utf8');
  } catch (err) {
    coworkLog('WARN', 'taskStore', 'failed to persist store', { err: String(err) });
  }
}

function ensureLoaded(): void {
  if (!loaded) throw new Error('taskStore not initialized');
}

// ── Tasks ──

export function listTasks(): ScenarioTask[] {
  ensureLoaded();
  return [...store.tasks];
}

export function getTask(id: string): ScenarioTask | null {
  ensureLoaded();
  return store.tasks.find(t => t.id === id) || null;
}

export function createTask(input: Omit<ScenarioTask, 'id' | 'created_at' | 'updated_at'>): ScenarioTask {
  ensureLoaded();
  const now = Date.now();
  // If this is the only task, auto-mark it as active.
  // If other tasks exist, new task starts as inactive (standby).
  const isOnlyTask = store.tasks.length === 0;
  const task: ScenarioTask = {
    ...input,
    active: isOnlyTask ? true : (input.active ?? false),
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
  };
  // If this task is active, deactivate all others
  if (task.active) {
    for (const t of store.tasks) t.active = false;
  }
  store.tasks.push(task);
  persist();
  return task;
}

/**
 * Set exactly one task as "active" (eligible for auto-run).
 * All other tasks are deactivated. Returns the newly-active task.
 */
export function setActiveTask(id: string): ScenarioTask | null {
  ensureLoaded();
  let target: ScenarioTask | null = null;
  for (const t of store.tasks) {
    if (t.id === id) {
      t.active = true;
      t.updated_at = Date.now();
      target = t;
    } else {
      t.active = false;
    }
  }
  persist();
  return target;
}

export function getActiveTask(): ScenarioTask | null {
  ensureLoaded();
  return store.tasks.find(t => t.active) || null;
}

export function updateTask(id: string, patch: Partial<ScenarioTask>): ScenarioTask | null {
  ensureLoaded();
  const idx = store.tasks.findIndex(t => t.id === id);
  if (idx < 0) return null;
  const existing = store.tasks[idx];
  const updated: ScenarioTask = { ...existing, ...patch, id: existing.id, updated_at: Date.now() };
  store.tasks[idx] = updated;
  persist();
  return updated;
}

export function deleteTask(id: string): boolean {
  ensureLoaded();
  const idx = store.tasks.findIndex(t => t.id === id);
  if (idx < 0) return false;
  store.tasks.splice(idx, 1);
  delete store.seen_post_ids[id];
  store.drafts = store.drafts.filter(d => d.task_id !== id);
  persist();
  return true;
}

// ── Seen tracking ──

export function getSeenPostIds(task_id: string): Set<string> {
  ensureLoaded();
  return new Set(store.seen_post_ids[task_id] || []);
}

export function recordSeen(task_id: string, post_ids: string[]): void {
  ensureLoaded();
  const list = store.seen_post_ids[task_id] || [];
  for (const id of post_ids) if (!list.includes(id)) list.push(id);
  // Trim oldest
  if (list.length > MAX_SEEN_PER_TASK) list.splice(0, list.length - MAX_SEEN_PER_TASK);
  store.seen_post_ids[task_id] = list;
  persist();
}

// ── Drafts ──

export function listDrafts(task_id?: string): Draft[] {
  ensureLoaded();
  if (!task_id) return [...store.drafts];
  return store.drafts.filter(d => d.task_id === task_id);
}

export function getDraft(id: string): Draft | null {
  ensureLoaded();
  return store.drafts.find(d => d.id === id) || null;
}

export function addDrafts(newDrafts: Draft[]): void {
  ensureLoaded();
  store.drafts.push(...newDrafts);
  // Trim per-task
  const byTask = new Map<string, Draft[]>();
  for (const d of store.drafts) {
    const arr = byTask.get(d.task_id) || [];
    arr.push(d);
    byTask.set(d.task_id, arr);
  }
  const trimmed: Draft[] = [];
  for (const [, arr] of byTask) {
    arr.sort((a, b) => a.created_at - b.created_at);
    const slice = arr.length > MAX_DRAFTS_PER_TASK ? arr.slice(-MAX_DRAFTS_PER_TASK) : arr;
    trimmed.push(...slice);
  }
  store.drafts = trimmed;
  persist();
}

export function updateDraft(id: string, patch: Partial<Draft>): Draft | null {
  ensureLoaded();
  const idx = store.drafts.findIndex(d => d.id === id);
  if (idx < 0) return null;
  const existing = store.drafts[idx];
  const updated = { ...existing, ...patch, id: existing.id };
  store.drafts[idx] = updated;
  persist();
  return updated;
}

export function deleteDraft(id: string): boolean {
  ensureLoaded();
  const idx = store.drafts.findIndex(d => d.id === id);
  if (idx < 0) return false;
  store.drafts.splice(idx, 1);
  persist();
  return true;
}
