/**
 * Task Executor — runs sub-agent tasks via queryLoopStreaming.
 * Each sub-agent runs as an async context in the main process
 * with its own AbortController, tool set, and system prompt.
 *
 * Ported from OpenClaw src/tasks/task-executor.ts
 * Simplified: no ACP/RPC, no distributed coordination.
 */

import { queryLoopStreaming, type QueryParams, type QueryEvent, type Terminal } from './queryEngine';
import { getAnthropicClient, type ApiConfig } from './anthropicClient';
import { getCurrentApiConfig } from './claudeSettings';
import type { ToolDefinition } from './toolSystem';
import type { CanUseToolFn } from './toolOrchestration';
import {
  createTask,
  startTask,
  completeTask,
  failTask,
  timeoutTask,
  cancelTask,
  getTask,
  updateTaskProgress,
  type TaskRecord,
  type CreateTaskParams,
} from './taskRegistry';
import { coworkLog } from './coworkLogger';

// ── Active execution tracking ──

interface ActiveExecution {
  taskId: string;
  abortController: AbortController;
  promise: Promise<void>;
}

const activeExecutions = new Map<string, ActiveExecution>();

// ── Event callback ──

export type TaskEventCallback = (taskId: string, event: QueryEvent) => void;
export type TaskCompletionCallback = (task: TaskRecord) => void;

// ── Execute a sub-agent task ──

/**
 * Create and execute a sub-agent task.
 * The sub-agent runs its own queryLoopStreaming with isolated context.
 *
 * Returns the TaskRecord immediately (status: 'queued' or 'running').
 * The actual execution runs in the background.
 */
export function executeTask(
  params: CreateTaskParams & {
    tools: ToolDefinition[];
    cwd: string;
    canUseTool: CanUseToolFn;
    onEvent?: TaskEventCallback;
    onComplete?: TaskCompletionCallback;
  }
): TaskRecord {
  const task = createTask(params);

  // Build API config
  const apiConfig = getCurrentApiConfig();
  const queryApiConfig: ApiConfig = {
    apiKey: apiConfig?.apiKey || '',
    baseUrl: apiConfig?.baseURL || undefined,
    model: params.model || apiConfig?.model || 'claude-sonnet-4-20250514',
    maxTokens: 16384,
    thinkingBudget: 10000,
  };

  // Filter tools if whitelist specified
  let tools = params.tools;
  if (params.toolWhitelist && params.toolWhitelist.length > 0) {
    const whitelist = new Set(params.toolWhitelist);
    tools = tools.filter(t => whitelist.has(t.name));
  }

  // Build system prompt for sub-agent
  const systemPrompt = params.systemPrompt || buildSubAgentSystemPrompt(task);

  // Create abort controller for this task
  const abortController = new AbortController();

  // Set timeout
  const timeoutTimer = setTimeout(() => {
    if (!abortController.signal.aborted) {
      abortController.abort();
      timeoutTask(task.id);
      if (params.onComplete) {
        const updated = getTask(task.id);
        if (updated) params.onComplete(updated);
      }
    }
  }, task.timeoutMs);

  // Start execution
  startTask(task.id);

  const promise = runSubAgent(
    task,
    queryApiConfig,
    systemPrompt,
    tools,
    params.cwd,
    abortController,
    params.canUseTool,
    params.onEvent,
  ).then(() => {
    clearTimeout(timeoutTimer);
    // Complete task with accumulated result
    const current = getTask(task.id);
    if (current && current.status === 'running') {
      completeTask(task.id, current.progress || 'Task completed successfully');
    }
    if (params.onComplete) {
      const updated = getTask(task.id);
      if (updated) params.onComplete(updated);
    }
  }).catch((err) => {
    clearTimeout(timeoutTimer);
    const msg = err instanceof Error ? err.message : String(err);
    const current = getTask(task.id);
    if (current && current.status === 'running') {
      failTask(task.id, msg);
    }
    if (params.onComplete) {
      const updated = getTask(task.id);
      if (updated) params.onComplete(updated);
    }
  }).finally(() => {
    activeExecutions.delete(task.id);
  });

  activeExecutions.set(task.id, { taskId: task.id, abortController, promise });

  return task;
}

// ── Internal: run the sub-agent query loop ──

async function runSubAgent(
  task: TaskRecord,
  apiConfig: ApiConfig,
  systemPrompt: string,
  tools: ToolDefinition[],
  cwd: string,
  abortController: AbortController,
  canUseTool: CanUseToolFn,
  onEvent?: TaskEventCallback,
): Promise<void> {
  coworkLog('INFO', 'taskExecutor', `Starting sub-agent for task ${task.id}`, {
    agentId: task.agentId,
    goal: task.goal.slice(0, 200),
    toolCount: tools.length,
  });

  const queryGen = queryLoopStreaming({
    prompt: task.goal,
    systemPrompt,
    tools,
    apiConfig,
    cwd,
    sessionId: `task-${task.id}`,
    abortSignal: abortController.signal,
    canUseTool,
    maxTurns: 50, // Sub-agents get fewer turns
  });

  let lastAssistantText = '';

  for await (const event of queryGen) {
    // Forward events to callback
    if (onEvent) {
      onEvent(task.id, event);
    }

    // Track progress
    if (event.type === 'assistant') {
      const msg = event.message;
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
          : '';
      if (content) {
        lastAssistantText = content;
        updateTaskProgress(task.id, lastAssistantText.slice(0, 500));
      }
    }

    // Check abort
    if (abortController.signal.aborted) {
      break;
    }
  }

  // Store final result
  if (lastAssistantText && getTask(task.id)?.status === 'running') {
    updateTaskProgress(task.id, lastAssistantText);
  }
}

// ── Build system prompt for sub-agents ──

function buildSubAgentSystemPrompt(task: TaskRecord): string {
  return [
    `You are a sub-agent executing a specific task. Focus only on the given goal.`,
    '',
    '## Your Task',
    task.goal,
    '',
    '## Guidelines',
    '- Complete the task as efficiently as possible.',
    '- Do not ask the user questions — work autonomously.',
    '- If you encounter an error, try to recover. Only give up after 3 attempts.',
    '- Report your findings clearly and concisely.',
    '- Do not start new tasks or go beyond the scope of your assignment.',
    '',
    '## Error Handling',
    '- If an approach fails, diagnose why before switching tactics.',
    '- Do not retry the identical action blindly.',
    '- Report outcomes faithfully — never claim success when output shows failure.',
  ].join('\n');
}

// ── Cancel a running task ──

export function cancelRunningTask(taskId: string): boolean {
  const execution = activeExecutions.get(taskId);
  if (!execution) {
    // Task might not be actively executing
    const task = getTask(taskId);
    if (task && (task.status === 'queued' || task.status === 'running')) {
      cancelTask(taskId);
      return true;
    }
    return false;
  }

  execution.abortController.abort();
  cancelTask(taskId);
  return true;
}

// ── Cancel all tasks for a session ──

export function cancelAllSessionTasks(sessionId: string): number {
  let count = 0;
  for (const [taskId, execution] of activeExecutions) {
    const task = getTask(taskId);
    if (task?.parentSessionId === sessionId) {
      execution.abortController.abort();
      cancelTask(taskId);
      count++;
    }
  }
  return count;
}

// ── Wait for a task to complete ──

export async function waitForTask(taskId: string, timeoutMs?: number): Promise<TaskRecord | null> {
  const execution = activeExecutions.get(taskId);
  if (!execution) {
    return getTask(taskId);
  }

  if (timeoutMs) {
    await Promise.race([
      execution.promise,
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  } else {
    await execution.promise;
  }

  return getTask(taskId);
}

// ── Get active execution count ──

export function getActiveExecutionCount(): number {
  return activeExecutions.size;
}
