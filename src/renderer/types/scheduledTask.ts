// Schedule types
export interface ScheduleAt {
  type: 'at';
  datetime: string; // ISO 8601
}

export interface ScheduleInterval {
  type: 'interval';
  intervalMs: number;
  unit: 'minutes' | 'hours' | 'days';
  value: number;
}

export interface ScheduleCron {
  type: 'cron';
  expression: string; // 5-field CRON expression
}

export type Schedule = ScheduleAt | ScheduleInterval | ScheduleCron;

// Task status
export type TaskLastStatus = 'success' | 'error' | 'running' | null;

export interface TaskState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: TaskLastStatus;
  lastError: string | null;
  lastDurationMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

// IM notification platform types
export type NotifyPlatform = 'dingtalk' | 'feishu' | 'lark' | 'qq' | 'telegram' | 'discord' | 'wecom';

// Scheduled task
export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  expiresAt: string | null; // ISO 8601 date (day precision), null means no expiration
  notifyPlatforms: NotifyPlatform[]; // IM platforms to notify after task completion
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

// Run history
export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  sessionId: string | null;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  trigger: 'scheduled' | 'manual';
}

// Run history with task name (for global history list)
export interface ScheduledTaskRunWithName extends ScheduledTaskRun {
  taskName: string;
}

// Form input
export interface ScheduledTaskInput {
  name: string;
  description: string;
  schedule: Schedule;
  prompt: string;
  workingDirectory: string;
  systemPrompt: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  expiresAt: string | null; // ISO 8601 date (day precision), null means no expiration
  notifyPlatforms: NotifyPlatform[]; // IM platforms to notify after task completion
  enabled: boolean;
}

// IPC events
export interface ScheduledTaskStatusEvent {
  taskId: string;
  state: TaskState;
}

export interface ScheduledTaskRunEvent {
  run: ScheduledTaskRun;
}

// UI view mode
export type ScheduledTaskViewMode = 'list' | 'create' | 'edit' | 'detail';
