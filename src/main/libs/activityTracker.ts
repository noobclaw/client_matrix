/**
 * Activity Tracker — tracks and reports tool execution progress.
 * Shows users what's happening instead of a blank wait.
 *
 * Reference: Claude Code src/utils/activityManager.ts
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export interface ToolActivity {
  toolName: string;
  toolUseId: string;
  description: string;     // Human-readable: "Reading package.json", "Searching for imports"
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
}

// ── State ──

const activeTools = new Map<string, ToolActivity>();
const recentCompleted: ToolActivity[] = [];
const MAX_RECENT = 20;

let onActivityChange: ((activities: ToolActivity[]) => void) | null = null;

// ── Activity descriptions per tool ──

const TOOL_DESCRIPTIONS: Record<string, (input: Record<string, unknown>) => string> = {
  Read: (input) => `Reading ${shortenPath(String(input.file_path || ''))}`,
  Write: (input) => `Writing ${shortenPath(String(input.file_path || ''))}`,
  Edit: (input) => `Editing ${shortenPath(String(input.file_path || ''))}`,
  Bash: (input) => `Running: ${String(input.command || '').slice(0, 60)}`,
  Glob: (input) => `Searching files: ${String(input.pattern || '')}`,
  Grep: (input) => `Searching content: ${String(input.pattern || '').slice(0, 40)}`,
  browser_navigate: (input) => `Navigating to ${String(input.url || '').slice(0, 50)}`,
  browser_screenshot: () => 'Taking screenshot',
  browser_click: () => 'Clicking element',
  desktop_screenshot: () => 'Capturing screen',
  desktop_click: (input) => `Clicking at (${input.x}, ${input.y})`,
  desktop_type: (input) => `Typing: ${String(input.text || '').slice(0, 30)}`,
  process_spawn: (input) => `Starting: ${String(input.command || '')} ${(input.args as string[] || []).join(' ').slice(0, 40)}`,
  memory_recall: (input) => `Recalling: ${String(input.query || '').slice(0, 40)}`,
  web_search: (input) => `Searching: ${String(input.query || '').slice(0, 40)}`,
  web_fetch: (input) => `Fetching: ${String(input.url || '').slice(0, 50)}`,
  spawn_subagent: (input) => `Spawning agent: ${String(input.goal || '').slice(0, 50)}`,
  lsp_definition: () => 'Finding definition',
  lsp_references: () => 'Finding references',
};

function shortenPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 3 ? `.../${parts.slice(-2).join('/')}` : p;
}

function getDescription(toolName: string, input: Record<string, unknown>): string {
  const fn = TOOL_DESCRIPTIONS[toolName];
  if (fn) return fn(input);
  return `Using ${toolName}`;
}

// ── Track ──

export function trackToolStart(toolName: string, toolUseId: string, input: Record<string, unknown>): void {
  const activity: ToolActivity = {
    toolName,
    toolUseId,
    description: getDescription(toolName, input),
    startedAt: Date.now(),
    completedAt: null,
    durationMs: null,
  };
  activeTools.set(toolUseId, activity);
  notifyChange();
}

export function trackToolEnd(toolUseId: string): void {
  const activity = activeTools.get(toolUseId);
  if (activity) {
    activity.completedAt = Date.now();
    activity.durationMs = activity.completedAt - activity.startedAt;
    activeTools.delete(toolUseId);
    recentCompleted.unshift(activity);
    if (recentCompleted.length > MAX_RECENT) recentCompleted.pop();
    notifyChange();

    if (activity.durationMs > 3000) {
      coworkLog('INFO', 'activityTracker', `Slow tool: ${activity.description} (${activity.durationMs}ms)`);
    }
  }
}

// ── Query ──

export function getActiveTools(): ToolActivity[] {
  return Array.from(activeTools.values());
}

export function getRecentCompleted(): ToolActivity[] {
  return [...recentCompleted];
}

export function isAnyToolRunning(): boolean {
  return activeTools.size > 0;
}

/**
 * Get a status line suitable for UI display.
 * Example: "Running Bash(npm test)... (3s)"
 */
export function getStatusLine(): string | null {
  if (activeTools.size === 0) return null;
  const activities = Array.from(activeTools.values());
  const first = activities[0];
  const elapsed = Math.round((Date.now() - first.startedAt) / 1000);
  if (activities.length === 1) {
    return `${first.description}... (${elapsed}s)`;
  }
  return `${first.description} + ${activities.length - 1} more... (${elapsed}s)`;
}

// ── Callback for UI updates ──

export function onActivityUpdate(callback: (activities: ToolActivity[]) => void): () => void {
  onActivityChange = callback;
  return () => { onActivityChange = null; };
}

function notifyChange(): void {
  if (onActivityChange) {
    onActivityChange(getActiveTools());
  }
}

// ── Clear ──

export function clearActivityTracker(): void {
  activeTools.clear();
  recentCompleted.length = 0;
}
