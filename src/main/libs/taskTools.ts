/**
 * Task Tools — tool definitions for the sub-agent system.
 * These tools are registered into allTools and allow the main
 * agent to spawn, monitor, and cancel sub-agent tasks.
 *
 * Ported from OpenClaw's task/agent tool patterns.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition, type ToolContext } from './toolSystem';
import { executeTask, cancelRunningTask, waitForTask, getActiveExecutionCount } from './taskExecutor';
import { summarizeAgentResult } from './agentSummary';
import {
  getTask,
  getAllTasks,
  getActiveTasks,
  getChildTasks,
  formatTaskStatusTitle,
  formatTaskStatusDetail,
  type TaskRecord,
} from './taskRegistry';
import {
  createFlow,
  executeFlow,
  getFlow,
  getActiveFlows,
  cancelFlow,
  type TaskFlowStep,
} from './taskFlowRegistry';
import type { CanUseToolFn } from './toolOrchestration';

/**
 * Build all task-related tool definitions.
 * Called during tool assembly in coworkRunner.ts.
 */
export function buildTaskTools(
  allTools: ToolDefinition[],
  canUseTool: CanUseToolFn,
): ToolDefinition[] {
  return [
    // ── spawn_subagent: Create and run a sub-agent task ──
    buildTool({
      name: 'spawn_subagent',
      description: [
        'Spawn a sub-agent to handle a specific task autonomously.',
        'The sub-agent runs in the background with its own conversation context.',
        '',
        'When to use:',
        '- Complex tasks that can run independently (research, code generation, testing)',
        '- Tasks that would pollute the main conversation context',
        '- Parallel work: spawn multiple sub-agents for different aspects',
        '',
        'When NOT to use:',
        '- Simple one-step tasks (just do them directly)',
        '- Tasks requiring real-time user interaction',
        '',
        'The sub-agent has access to the same tools as you (or a subset if tool_whitelist is specified).',
        'Use get_task_result to check status and retrieve results.',
      ].join('\n'),
      inputSchema: z.object({
        goal: z.string().min(1).describe('Clear description of what the sub-agent should accomplish'),
        label: z.string().optional().describe('Short label for the task (max 80 chars)'),
        agent_id: z.string().optional().describe('Agent ID to use (default: "main")'),
        model: z.string().optional().describe('Model override (e.g., "claude-haiku-4-5-20251001" for fast tasks)'),
        tool_whitelist: z.array(z.string()).optional().describe('Restrict sub-agent to only these tools'),
        timeout_seconds: z.number().min(10).max(3600).optional().describe('Timeout in seconds (default: 300)'),
        run_in_background: z.boolean().optional().describe('If true, return immediately without waiting (default: false)'),
      }),
      call: async (input, context) => {
        const task = executeTask({
          parentSessionId: context.sessionId,
          agentId: input.agent_id,
          goal: input.goal,
          label: input.label,
          model: input.model,
          toolWhitelist: input.tool_whitelist,
          timeoutMs: input.timeout_seconds ? input.timeout_seconds * 1000 : undefined,
          tools: allTools,
          cwd: context.cwd,
          canUseTool,
        });

        if (input.run_in_background) {
          return {
            content: [{
              type: 'text',
              text: `Sub-agent spawned in background.\nTask ID: ${task.id}\nGoal: ${task.goal}\n\nUse get_task_result with this task ID to check progress and retrieve results.`,
            }],
          };
        }

        // Wait for completion (default behavior)
        const completed = await waitForTask(task.id);
        if (!completed) {
          return {
            content: [{ type: 'text', text: `Task ${task.id} not found after execution` }],
            isError: true,
          };
        }

        // Agent Summary pass: subagent results that exceed the
        // summarization threshold are compressed down to a dense
        // bullet summary before being injected into the parent's
        // tool-result message, so 3K-8K token raw outputs don't
        // explode the parent's context window. Failures are a
        // graceful passthrough — we never fail a task because
        // summarization broke.
        const rawResult = completed.result || '';
        let resultText = rawResult || '(no result)';
        let summaryNote = '';
        if (completed.status === 'succeeded' && rawResult.length > 0) {
          try {
            const summary = await summarizeAgentResult({
              goal: task.goal,
              rawResult,
              status: 'succeeded',
            });
            if (summary.compressed) {
              resultText = summary.text;
              summaryNote = `\n\n(Compressed ${summary.originalChars} chars → ${summary.text.length} chars by Agent Summary)`;
            }
          } catch { /* silent passthrough */ }
        }

        return {
          content: [{
            type: 'text',
            text: [
              `Task: ${formatTaskStatusTitle(completed)}`,
              `Status: ${completed.status}`,
              `Duration: ${completed.completedAt && completed.startedAt ? Math.round((completed.completedAt - completed.startedAt) / 1000) + 's' : 'N/A'}`,
              '',
              completed.status === 'succeeded'
                ? `Result:\n${resultText}${summaryNote}`
                : `Error: ${completed.error || 'Unknown'}`,
            ].join('\n'),
          }],
          isError: completed.status !== 'succeeded',
        };
      },
    }),

    // ── get_task_result: Check status or get result of a task ──
    buildTool({
      name: 'get_task_result',
      description: 'Get the status and result of a previously spawned sub-agent task. Use this to check on background tasks.',
      inputSchema: z.object({
        task_id: z.string().min(1).describe('Task ID returned by spawn_subagent'),
        wait: z.boolean().optional().describe('If true, wait for the task to complete (default: false)'),
        wait_timeout_seconds: z.number().min(1).max(300).optional().describe('Max seconds to wait (default: 60)'),
      }),
      call: async (input) => {
        if (input.wait) {
          await waitForTask(input.task_id, (input.wait_timeout_seconds ?? 60) * 1000);
        }

        const task = getTask(input.task_id);
        if (!task) {
          return {
            content: [{ type: 'text', text: `Task ${input.task_id} not found` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: [
              `Task: ${formatTaskStatusTitle(task)}`,
              `Status: ${task.status}`,
              `Agent: ${task.agentId}`,
              `Created: ${new Date(task.createdAt).toISOString()}`,
              task.startedAt ? `Started: ${new Date(task.startedAt).toISOString()}` : '',
              task.completedAt ? `Completed: ${new Date(task.completedAt).toISOString()}` : '',
              '',
              formatTaskStatusDetail(task),
            ].filter(Boolean).join('\n'),
          }],
          isError: task.status === 'failed' || task.status === 'timed_out',
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── list_tasks: Show all tasks ──
    buildTool({
      name: 'list_tasks',
      description: 'List all sub-agent tasks. Shows active tasks by default, or all tasks with show_all=true.',
      inputSchema: z.object({
        show_all: z.boolean().optional().describe('Show completed/failed tasks too (default: false)'),
        limit: z.number().min(1).max(100).optional().describe('Max tasks to show (default: 20)'),
      }),
      call: async (input) => {
        const tasks = input.show_all
          ? getAllTasks(input.limit ?? 20)
          : getActiveTasks();

        if (tasks.length === 0) {
          return {
            content: [{ type: 'text', text: 'No tasks found.' }],
          };
        }

        const lines = tasks.map(t =>
          `[${t.status.toUpperCase()}] ${t.id.slice(0, 8)}... ${formatTaskStatusTitle(t)} (${t.agentId})`
        );

        return {
          content: [{
            type: 'text',
            text: `Tasks (${tasks.length}):\n${lines.join('\n')}`,
          }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── cancel_task: Cancel a running task ──
    buildTool({
      name: 'cancel_task',
      description: 'Cancel a running or queued sub-agent task. Also cancels all child tasks (cascading).',
      inputSchema: z.object({
        task_id: z.string().min(1).describe('Task ID to cancel'),
      }),
      call: async (input) => {
        const success = cancelRunningTask(input.task_id);
        return {
          content: [{
            type: 'text',
            text: success
              ? `Task ${input.task_id} cancelled.`
              : `Task ${input.task_id} not found or already completed.`,
          }],
          isError: !success,
        };
      },
    }),

    // ── run_task_flow: Execute a multi-step task flow ──
    buildTool({
      name: 'run_task_flow',
      description: [
        'Execute a multi-step task flow where each step runs as a sub-agent.',
        'Steps run sequentially by default. Use depends_on to create parallel branches.',
        '',
        'Example: Research + implement + test flow:',
        '  steps: [',
        '    { goal: "Research best practices for X" },',
        '    { goal: "Implement based on research findings" },',
        '    { goal: "Write tests for the implementation" }',
        '  ]',
      ].join('\n'),
      inputSchema: z.object({
        goal: z.string().min(1).describe('Overall goal of the flow'),
        steps: z.array(z.object({
          goal: z.string().min(1),
          label: z.string().optional(),
          agent_id: z.string().optional(),
          tool_whitelist: z.array(z.string()).optional(),
          model: z.string().optional(),
          depends_on: z.array(z.number()).optional().describe('Step indices this step depends on'),
        })).min(1).max(20),
        sync_mode: z.enum(['managed', 'task_mirrored']).optional()
          .describe('managed: stop on failure. task_mirrored: continue despite failures.'),
      }),
      call: async (input, context) => {
        const flow = createFlow({
          parentSessionId: context.sessionId,
          goal: input.goal,
          steps: input.steps as TaskFlowStep[],
          syncMode: input.sync_mode,
        });

        const completed = await executeFlow(
          flow,
          allTools,
          context.cwd,
          canUseTool,
        );

        const stepSummaries = completed.taskIds.map((taskId, i) => {
          const task = taskId ? getTask(taskId) : null;
          const step = completed.steps[i];
          return `  Step ${i + 1} [${task?.status || 'not started'}]: ${step.label || step.goal.slice(0, 60)}`;
        });

        return {
          content: [{
            type: 'text',
            text: [
              `Flow: ${completed.goal}`,
              `Status: ${completed.status}`,
              `Steps:`,
              ...stepSummaries,
              '',
              completed.status === 'blocked' ? `Blocked: ${completed.blockedReason}` : '',
            ].filter(Boolean).join('\n'),
          }],
          isError: completed.status !== 'succeeded',
        };
      },
    }),
  ];
}
