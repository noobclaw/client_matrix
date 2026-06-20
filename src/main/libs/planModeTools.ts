/**
 * Plan-mode tools — `EnterPlanMode` / `ExitPlanMode`.
 *
 * These are separate from `planMode.ts` (which detects task complexity
 * and injects prompt-level guidance). This file exposes two tools the
 * AI itself can invoke to toggle a per-session "read-only" flag on
 * `ActiveSession.planMode`. While the flag is on, coworkRunner's
 * `canUseToolFn` refuses every tool that could mutate the workspace,
 * so the model can explore freely before deciding what to do — a real
 * hard gate, not just a prompt suggestion.
 *
 * The AI's expected flow for a complex unattended task:
 *
 *   1. Call `EnterPlanMode` at the start.
 *   2. Use Read / Grep / Glob / LS / WebFetch / etc. to explore.
 *   3. Call `ExitPlanMode({ plan: "short summary" })`.
 *   4. Proceed with Bash / Write / Edit etc. normally.
 *
 * The user coming back later sees the plan text in the session so
 * they know what the model decided to do while they were away.
 */

import { z } from 'zod';
import { buildTool, type ToolContext, type ToolDefinition } from './toolSystem';
import { coworkLog } from './coworkLogger';

// Tools that do NOT mutate anything and remain allowed in plan mode.
// Everything not on this list or not matching the MCP read-only regex
// is refused with a "session is in plan mode" message.
const READ_ONLY_TOOL_ALLOWLIST = new Set<string>([
  'Read',
  'FileRead',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'BashOutput', // read output from a previously-started bash; no NEW execution
  'AskUserQuestion',
  'TodoWrite', // mutates only the AI's own internal todo list
  'EnterPlanMode',
  'ExitPlanMode',
  'ToolSearch',
]);

// MCP tool naming convention: mcp__<server>__<toolname>. By MCP
// convention, tools with these suffix verbs are read-only.
const MCP_READ_ONLY_SUFFIX_RE =
  /^mcp__.*__(list|get|read|search|query|find|describe|inspect|show)/i;

export function isReadOnlyToolForPlanMode(toolName: string): boolean {
  if (!toolName) return false;
  if (READ_ONLY_TOOL_ALLOWLIST.has(toolName)) return true;
  if (MCP_READ_ONLY_SUFFIX_RE.test(toolName)) return true;
  return false;
}

export interface PlanModeToggle {
  enter(sessionId: string): void;
  exit(sessionId: string, plan?: string): void;
}

export function buildEnterPlanModeTool(
  toggle: PlanModeToggle,
  getFallbackSessionId: () => string | null,
): ToolDefinition {
  return buildTool({
    name: 'EnterPlanMode',
    description: [
      'Enter PLAN MODE. While in plan mode the session can only use',
      'read-only tools (Read, Grep, Glob, LS, WebFetch, WebSearch,',
      'BashOutput, and any mcp__*__{list,get,read,search,query,find,',
      'describe,inspect,show}). All write-scope tools (Bash, Write,',
      'Edit, NotebookEdit, etc.) are refused until ExitPlanMode is',
      'called.',
      '',
      'Use this at the start of any non-trivial or unattended task so',
      'you read enough to understand the problem before touching',
      'anything on disk.',
    ].join('\n'),
    inputSchema: z.object({}),
    call: async (_input: unknown, context: ToolContext) => {
      const sessionId = context?.sessionId || getFallbackSessionId();
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: 'EnterPlanMode: no active session' }],
          isError: true,
        };
      }
      toggle.enter(sessionId);
      coworkLog('INFO', 'planModeTools', 'Entered plan mode', { sessionId });
      return {
        content: [
          {
            type: 'text',
            text:
              'Plan mode ON. Read-only tools only. Explore the workspace, '
              + 'then call ExitPlanMode with a brief plan summary before '
              + 'making changes.',
          },
        ],
      };
    },
    isReadOnly: true,
  });
}

export function buildExitPlanModeTool(
  toggle: PlanModeToggle,
  getFallbackSessionId: () => string | null,
): ToolDefinition {
  return buildTool({
    name: 'ExitPlanMode',
    description: [
      'Leave PLAN MODE and resume normal (write-scope) tool access.',
      'Pass a short natural-language summary of the plan that came out',
      'of the plan-mode exploration — it gets recorded in the session',
      'so the user can see what you decided to do when they check back.',
      'One short paragraph is fine, no structured format required.',
    ].join('\n'),
    inputSchema: z.object({
      plan: z
        .string()
        .min(1)
        .describe('Brief free-text plan summary derived from the exploration phase.'),
    }),
    call: async (input: { plan: string }, context: ToolContext) => {
      const sessionId = context?.sessionId || getFallbackSessionId();
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: 'ExitPlanMode: no active session' }],
          isError: true,
        };
      }
      toggle.exit(sessionId, input.plan);
      coworkLog('INFO', 'planModeTools', 'Exited plan mode', {
        sessionId,
        planLength: input.plan.length,
      });
      return {
        content: [
          {
            type: 'text',
            text:
              `Plan mode OFF. Recorded plan:\n\n${input.plan}\n\n`
              + 'Write-scope tools are now allowed.',
          },
        ],
      };
    },
    isReadOnly: false,
  });
}
