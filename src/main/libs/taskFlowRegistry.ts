/**
 * Task Flow Registry — manages multi-step task workflows.
 * A flow is a sequence of tasks that execute in order,
 * with optional branching and cascading cancellation.
 *
 * Ported from OpenClaw src/tasks/task-flow-registry.ts
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getTask,
  cancelTask,
  isTerminalTask,
  type TaskRecord,
  type TaskStatus,
} from './taskRegistry';
import { executeTask, cancelRunningTask, waitForTask } from './taskExecutor';
import type { ToolDefinition } from './toolSystem';
import type { CanUseToolFn } from './toolOrchestration';
import { coworkLog } from './coworkLogger';

// ── Flow Types (from OpenClaw task-flow-registry.types.ts) ──

export type FlowSyncMode = 'task_mirrored' | 'managed';

export type FlowStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface TaskFlowStep {
  goal: string;
  label?: string;
  agentId?: string;
  toolWhitelist?: string[];
  model?: string;
  dependsOn?: number[]; // indices of steps this depends on
}

export interface TaskFlowRecord {
  id: string;
  parentSessionId: string;
  goal: string;
  syncMode: FlowSyncMode;
  status: FlowStatus;
  currentStep: number;
  steps: TaskFlowStep[];
  taskIds: string[]; // task ID per step
  blockedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFlowParams {
  parentSessionId: string;
  goal: string;
  steps: TaskFlowStep[];
  syncMode?: FlowSyncMode;
}

// ── In-memory registry ──

const flows = new Map<string, TaskFlowRecord>();

// ── Create a flow ──

export function createFlow(params: CreateFlowParams): TaskFlowRecord {
  const id = uuidv4();
  const now = Date.now();

  const flow: TaskFlowRecord = {
    id,
    parentSessionId: params.parentSessionId,
    goal: params.goal,
    syncMode: params.syncMode ?? 'managed',
    status: 'running',
    currentStep: 0,
    steps: params.steps,
    taskIds: new Array(params.steps.length).fill(''),
    blockedReason: null,
    createdAt: now,
    updatedAt: now,
  };

  flows.set(id, flow);
  coworkLog('INFO', 'taskFlowRegistry', `Flow created: ${id} with ${params.steps.length} steps`);
  return flow;
}

// ── Execute a flow (runs steps in sequence) ──

export async function executeFlow(
  flow: TaskFlowRecord,
  tools: ToolDefinition[],
  cwd: string,
  canUseTool: CanUseToolFn,
  onStepComplete?: (flowId: string, stepIndex: number, task: TaskRecord) => void,
): Promise<TaskFlowRecord> {
  coworkLog('INFO', 'taskFlowRegistry', `Executing flow ${flow.id}: "${flow.goal}"`);

  for (let i = flow.currentStep; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    flow.currentStep = i;
    flow.updatedAt = Date.now();

    // Check dependencies
    if (step.dependsOn && step.dependsOn.length > 0) {
      for (const depIdx of step.dependsOn) {
        const depTaskId = flow.taskIds[depIdx];
        if (!depTaskId) continue;
        const depTask = getTask(depTaskId);
        if (depTask && !isTerminalTask(depTask.status)) {
          // Wait for dependency
          await waitForTask(depTaskId);
        }
        const updatedDep = getTask(depTaskId);
        if (updatedDep && updatedDep.status !== 'succeeded') {
          // Dependency failed — block the flow
          flow.status = 'blocked';
          flow.blockedReason = `Step ${depIdx} (${updatedDep.label}) ${updatedDep.status}`;
          flow.updatedAt = Date.now();
          coworkLog('WARN', 'taskFlowRegistry', `Flow ${flow.id} blocked at step ${i}: dep ${depIdx} ${updatedDep.status}`);
          return flow;
        }
      }
    }

    // Build context from previous step results
    let contextFromPrevious = '';
    if (i > 0) {
      const prevTaskId = flow.taskIds[i - 1];
      if (prevTaskId) {
        const prevTask = getTask(prevTaskId);
        if (prevTask?.result) {
          contextFromPrevious = `\n\nContext from previous step:\n${prevTask.result.slice(0, 2000)}`;
        }
      }
    }

    // Execute step as a task
    const task = executeTask({
      parentSessionId: flow.parentSessionId,
      agentId: step.agentId,
      goal: step.goal + contextFromPrevious,
      label: step.label || `Step ${i + 1}: ${step.goal.slice(0, 60)}`,
      toolWhitelist: step.toolWhitelist,
      model: step.model,
      tools,
      cwd,
      canUseTool,
    });

    flow.taskIds[i] = task.id;
    flow.updatedAt = Date.now();

    // Wait for task completion
    const completed = await waitForTask(task.id);

    if (completed) {
      if (onStepComplete) {
        onStepComplete(flow.id, i, completed);
      }

      if (completed.status !== 'succeeded') {
        // Step failed — check sync mode
        if (flow.syncMode === 'managed') {
          // In managed mode, failure stops the flow
          flow.status = 'failed';
          flow.updatedAt = Date.now();
          coworkLog('ERROR', 'taskFlowRegistry', `Flow ${flow.id} failed at step ${i}: ${completed.error}`);
          return flow;
        }
        // In task_mirrored mode, continue despite failure
        coworkLog('WARN', 'taskFlowRegistry', `Flow ${flow.id} step ${i} failed but continuing (task_mirrored mode)`);
      }
    }

    // Check if flow was cancelled externally
    if (flow.status === 'cancelled') {
      return flow;
    }
  }

  flow.status = 'succeeded';
  flow.updatedAt = Date.now();
  coworkLog('INFO', 'taskFlowRegistry', `Flow ${flow.id} completed successfully`);
  return flow;
}

// ── Cancel a flow (cascading) ──

export function cancelFlow(flowId: string): TaskFlowRecord | null {
  const flow = flows.get(flowId);
  if (!flow || flow.status === 'succeeded') return null;

  flow.status = 'cancelled';
  flow.updatedAt = Date.now();

  // Cancel all active tasks in this flow
  for (const taskId of flow.taskIds) {
    if (taskId) {
      cancelRunningTask(taskId);
    }
  }

  coworkLog('INFO', 'taskFlowRegistry', `Flow ${flow.id} cancelled with ${flow.taskIds.filter(Boolean).length} tasks`);
  return flow;
}

// ── Query functions ──

export function getFlow(flowId: string): TaskFlowRecord | null {
  return flows.get(flowId) ?? null;
}

export function getFlowsBySession(sessionId: string): TaskFlowRecord[] {
  return Array.from(flows.values()).filter(f => f.parentSessionId === sessionId);
}

export function getActiveFlows(): TaskFlowRecord[] {
  return Array.from(flows.values()).filter(f => f.status === 'running' || f.status === 'blocked');
}

export function getAllFlows(limit: number = 50): TaskFlowRecord[] {
  return Array.from(flows.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

// ── Cleanup ──

export function clearCompletedFlows(olderThanMs: number = 3600_000): number {
  const cutoff = Date.now() - olderThanMs;
  let cleared = 0;

  for (const [id, flow] of flows) {
    if (
      (flow.status === 'succeeded' || flow.status === 'failed' || flow.status === 'cancelled') &&
      flow.updatedAt < cutoff
    ) {
      flows.delete(id);
      cleared++;
    }
  }

  return cleared;
}
