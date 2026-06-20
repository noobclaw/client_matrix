/**
 * Agent Tools — tool definitions for multi-agent routing.
 * Allows the main agent to delegate work, list agents, and register new ones.
 *
 * Ported from OpenClaw agent/routing patterns.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import {
  registerAgent,
  updateAgent,
  deleteAgent,
  getAgent,
  listAgents,
  resolveAgent,
  filterToolsForAgent,
  normalizeAgentId,
  isValidAgentId,
  buildAgentSessionKey,
  type AgentDefinition,
} from './agentRegistry';
import { executeTask, waitForTask } from './taskExecutor';
import { getTask, formatTaskStatusTitle, formatTaskStatusDetail } from './taskRegistry';
import type { CanUseToolFn } from './toolOrchestration';

/**
 * Build all agent-related tool definitions.
 */
export function buildAgentTools(
  allTools: ToolDefinition[],
  canUseTool: CanUseToolFn,
): ToolDefinition[] {
  return [
    // ── delegate_to_agent: Route a task to a specific named agent ──
    buildTool({
      name: 'delegate_to_agent',
      description: [
        'Delegate a task to a specific named agent. The agent runs as a sub-agent',
        'with its own system prompt, tool set, and conversation context.',
        '',
        'Use list_agents first to see available agents and their specializations.',
        '',
        'When to use:',
        '- Tasks that match a specialized agent\'s expertise',
        '- Work that benefits from different tool access or system prompts',
        '- Parallel delegation to multiple specialized agents',
      ].join('\n'),
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('ID of the agent to delegate to'),
        goal: z.string().min(1).describe('What the agent should accomplish'),
        run_in_background: z.boolean().optional().describe('Return immediately without waiting (default: false)'),
      }),
      call: async (input, context) => {
        const agent = resolveAgent(input.agent_id);
        if (!agent) {
          return {
            content: [{ type: 'text', text: `Agent "${input.agent_id}" not found. Use list_agents to see available agents.` }],
            isError: true,
          };
        }

        // Filter tools for this agent
        const agentTools = filterToolsForAgent(agent, allTools) as ToolDefinition[];

        const task = executeTask({
          parentSessionId: context.sessionId,
          agentId: agent.id,
          goal: input.goal,
          label: `[${agent.name}] ${input.goal.slice(0, 60)}`,
          systemPrompt: agent.systemPrompt || undefined,
          toolWhitelist: agent.toolWhitelist || undefined,
          model: agent.model || undefined,
          tools: agentTools,
          cwd: context.cwd,
          canUseTool,
        });

        if (input.run_in_background) {
          return {
            content: [{
              type: 'text',
              text: `Delegated to agent "${agent.name}" (${agent.id}) in background.\nTask ID: ${task.id}\n\nUse get_task_result to check progress.`,
            }],
          };
        }

        const completed = await waitForTask(task.id);
        if (!completed) {
          return {
            content: [{ type: 'text', text: `Task not found after delegation` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text',
            text: [
              `Agent: ${agent.name} (${agent.id})`,
              `Status: ${completed.status}`,
              '',
              completed.status === 'succeeded'
                ? `Result:\n${completed.result || '(no result)'}`
                : `Error: ${completed.error || 'Unknown'}`,
            ].join('\n'),
          }],
          isError: completed.status !== 'succeeded',
        };
      },
    }),

    // ── list_agents: Show all registered agents ──
    buildTool({
      name: 'list_agents',
      description: 'List all registered agents with their specializations and configurations.',
      inputSchema: z.object({}),
      call: async () => {
        const agents = listAgents();
        if (agents.length === 0) {
          return { content: [{ type: 'text', text: 'No agents registered.' }] };
        }

        const lines = agents.map(a => [
          `**${a.name}** (id: ${a.id})`,
          a.description ? `  ${a.description}` : '',
          a.model ? `  Model: ${a.model}` : '  Model: default',
          a.toolWhitelist ? `  Tools: ${a.toolWhitelist.join(', ')}` : '  Tools: all',
          a.toolBlacklist.length > 0 ? `  Excluded: ${a.toolBlacklist.join(', ')}` : '',
        ].filter(Boolean).join('\n'));

        return {
          content: [{ type: 'text', text: `Agents (${agents.length}):\n\n${lines.join('\n\n')}` }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── register_agent: Create a new named agent ──
    buildTool({
      name: 'register_agent',
      description: [
        'Register a new named agent with specific capabilities.',
        'Agents can have custom system prompts, tool restrictions, and model overrides.',
        '',
        'Example: Create a "researcher" agent that only uses web search and file reading.',
      ].join('\n'),
      inputSchema: z.object({
        name: z.string().min(1).max(64).describe('Human-readable agent name'),
        id: z.string().optional().describe('Agent ID (auto-generated from name if omitted)'),
        description: z.string().optional().describe('What this agent specializes in'),
        system_prompt: z.string().optional().describe('Custom system prompt for this agent'),
        tool_whitelist: z.array(z.string()).optional().describe('Only allow these tools'),
        tool_blacklist: z.array(z.string()).optional().describe('Exclude these tools'),
        model: z.string().optional().describe('Model override (e.g., "claude-haiku-4-5-20251001")'),
        max_turns: z.number().min(1).max(200).optional().describe('Max turns per task (default: 100)'),
      }),
      call: async (input) => {
        try {
          const agent = registerAgent({
            id: input.id,
            name: input.name,
            description: input.description,
            systemPrompt: input.system_prompt,
            toolWhitelist: input.tool_whitelist,
            toolBlacklist: input.tool_blacklist,
            model: input.model,
            maxTurns: input.max_turns,
          });

          return {
            content: [{
              type: 'text',
              text: `Agent "${agent.name}" registered with ID "${agent.id}".`,
            }],
          };
        } catch (e) {
          return {
            content: [{ type: 'text', text: `Failed to register agent: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          };
        }
      },
    }),

    // ── update_agent: Modify an existing agent ──
    buildTool({
      name: 'update_agent',
      description: 'Update an existing agent\'s configuration.',
      inputSchema: z.object({
        agent_id: z.string().min(1),
        name: z.string().optional(),
        description: z.string().optional(),
        system_prompt: z.string().optional(),
        tool_whitelist: z.array(z.string()).optional(),
        tool_blacklist: z.array(z.string()).optional(),
        model: z.string().optional(),
        max_turns: z.number().min(1).max(200).optional(),
        enabled: z.boolean().optional(),
      }),
      call: async (input) => {
        const { agent_id, ...updates } = input;
        const agent = updateAgent(agent_id, {
          name: updates.name,
          description: updates.description,
          systemPrompt: updates.system_prompt,
          toolWhitelist: updates.tool_whitelist,
          toolBlacklist: updates.tool_blacklist,
          model: updates.model,
          maxTurns: updates.max_turns,
          enabled: updates.enabled,
        });

        if (!agent) {
          return {
            content: [{ type: 'text', text: `Agent "${agent_id}" not found.` }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: `Agent "${agent.name}" (${agent.id}) updated.` }],
        };
      },
    }),

    // ── delete_agent: Remove an agent ──
    buildTool({
      name: 'delete_agent',
      description: 'Delete a registered agent. Cannot delete the default "main" agent.',
      inputSchema: z.object({
        agent_id: z.string().min(1),
      }),
      call: async (input) => {
        const success = deleteAgent(input.agent_id);
        return {
          content: [{
            type: 'text',
            text: success
              ? `Agent "${input.agent_id}" deleted.`
              : `Cannot delete agent "${input.agent_id}" (not found or is the default agent).`,
          }],
          isError: !success,
        };
      },
    }),
  ];
}
