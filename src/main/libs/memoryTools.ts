/**
 * Memory Tools — tool definitions for the Dreaming memory system.
 * Replaces the old conversation_search, recent_chats, memory_user_edits tools.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import {
  storeMemory,
  recallMemories,
  updateMemory,
  deleteMemory,
  getMemoryStats,
  getMemoriesByType,
  getBehavioralPatterns,
  formatMemoriesForPrompt,
  type MemoryType,
} from './memoryStore';
import { triggerPhase, getDreamingStatus } from './dreamingEngine';

/**
 * Build all memory-related tool definitions.
 */
export function buildMemoryTools(): ToolDefinition[] {
  return [
    buildTool({
      name: 'memory_recall',
      description: [
        'Search and retrieve relevant memories based on a query.',
        'Returns memories ranked by relevance and recency (14-day half-life decay).',
        '',
        'Use this when:',
        '- The user asks about something from previous conversations',
        '- You need context about the user\'s preferences or past decisions',
        '- Looking up facts, events, or behavioral patterns',
        '',
        'Do NOT use this for every request — only when historical context is needed.',
      ].join('\n'),
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query — keywords about what you want to recall'),
        limit: z.number().min(1).max(30).optional().describe('Max results (default: 15)'),
      }),
      call: async (input) => {
        const memories = await recallMemories(input.query, input.limit ?? 15);
        if (memories.length === 0) {
          return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
        }
        const formatted = formatMemoriesForPrompt(memories);
        return { content: [{ type: 'text', text: formatted }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'memory_store',
      description: [
        'Store a new memory for long-term recall. Use when the user explicitly asks',
        'to remember something, or when you discover an important fact/preference.',
        '',
        'Memory types:',
        '- semantic: Facts about the user (name, job, preferences) — importance 0.9+',
        '- episodic: Time-bound events — importance 0.7-0.9',
        '- procedural: Preferences, habits, workflows — importance 0.5-0.7',
        '',
        'Do NOT store:',
        '- Code patterns or file paths (derive from current project state)',
        '- Debugging solutions (they\'re in git history)',
        '- Ephemeral task details',
      ].join('\n'),
      inputSchema: z.object({
        content: z.string().min(1).describe('The memory content to store'),
        type: z.enum(['semantic', 'episodic', 'procedural']).describe('Memory type'),
        score: z.number().min(0).max(1).optional().describe('Importance score 0-1 (default: 0.5)'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
      }),
      call: async (input, context) => {
        const memory = storeMemory({
          type: input.type,
          content: input.content,
          score: input.score,
          tags: input.tags,
          sourceSessionId: context.sessionId,
        });
        return {
          content: [{ type: 'text', text: `Memory stored (${memory.type}, score: ${memory.score}): ${memory.content.slice(0, 100)}...` }],
        };
      },
    }),

    buildTool({
      name: 'memory_search',
      description: 'Browse memories by type. Use to review what the system has stored.',
      inputSchema: z.object({
        type: z.enum(['semantic', 'episodic', 'procedural', 'behavioral']).optional().describe('Filter by type'),
        limit: z.number().min(1).max(50).optional().describe('Max results (default: 20)'),
      }),
      call: async (input) => {
        if (input.type) {
          const memories = getMemoriesByType(input.type as MemoryType, input.limit ?? 20);
          const lines = memories.map(m =>
            `[${m.id.slice(0, 8)}] score:${m.score.toFixed(2)} recalls:${m.recallCount} — ${m.content.slice(0, 120)}`
          );
          return {
            content: [{ type: 'text', text: `${input.type} memories (${memories.length}):\n${lines.join('\n') || '(none)'}` }],
          };
        }

        const stats = getMemoryStats();
        const patterns = getBehavioralPatterns();
        return {
          content: [{
            type: 'text',
            text: [
              `Memory Stats:`,
              `  Total: ${stats.total}`,
              `  Semantic: ${stats.byType.semantic}`,
              `  Episodic: ${stats.byType.episodic}`,
              `  Procedural: ${stats.byType.procedural}`,
              `  Behavioral: ${stats.byType.behavioral}`,
              `  Avg Score: ${stats.averageScore.toFixed(2)}`,
              `  Avg Recalls: ${stats.averageRecalls.toFixed(1)}`,
              patterns.length > 0 ? `\nBehavioral Patterns (${patterns.length}):` : '',
              ...patterns.map(p => `  [${p.strength.toFixed(2)}] ${p.description}`),
            ].filter(Boolean).join('\n'),
          }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'memory_update',
      description: 'Update or delete a specific memory by ID.',
      inputSchema: z.object({
        memory_id: z.string().min(1).describe('Memory ID (from memory_search)'),
        action: z.enum(['update', 'delete']).describe('Action to perform'),
        content: z.string().optional().describe('New content (for update)'),
        score: z.number().min(0).max(1).optional().describe('New score (for update)'),
        tags: z.array(z.string()).optional().describe('New tags (for update)'),
      }),
      call: async (input) => {
        if (input.action === 'delete') {
          const success = deleteMemory(input.memory_id);
          return {
            content: [{ type: 'text', text: success ? `Memory ${input.memory_id} deleted.` : `Memory not found.` }],
            isError: !success,
          };
        }

        const success = updateMemory(input.memory_id, {
          content: input.content,
          score: input.score,
          tags: input.tags,
        });
        return {
          content: [{ type: 'text', text: success ? `Memory ${input.memory_id} updated.` : `Memory not found.` }],
          isError: !success,
        };
      },
    }),

    buildTool({
      name: 'memory_dreaming_status',
      description: 'Check the status of the Dreaming memory consolidation engine and optionally trigger a phase.',
      inputSchema: z.object({
        trigger_phase: z.enum(['light', 'deep', 'rem']).optional()
          .describe('Manually trigger a dreaming phase (optional)'),
      }),
      call: async (input) => {
        if (input.trigger_phase) {
          const result = await triggerPhase(input.trigger_phase);
          return {
            content: [{
              type: 'text',
              text: [
                `${input.trigger_phase.toUpperCase()} Dreaming triggered:`,
                `  Processed: ${result.memoriesProcessed}`,
                `  Merged: ${result.memoriesMerged}`,
                `  Created: ${result.memoriesCreated}`,
                `  Duration: ${result.completedAt - result.startedAt}ms`,
              ].join('\n'),
            }],
          };
        }

        const status = getDreamingStatus();
        return {
          content: [{
            type: 'text',
            text: [
              `Dreaming Engine: ${status.running ? 'RUNNING' : 'STOPPED'}`,
              `  Light: every ${status.config.lightIntervalMs / 3600000}h (dedup threshold: ${status.config.lightDedupThreshold})`,
              `  Deep: daily at ${status.config.deepCronHour}:00 (min score: ${status.config.deepMinScore})`,
              `  REM: ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][status.config.remCronDay]} at ${status.config.remCronHour}:00 (pattern threshold: ${status.config.remMinPatternStrength})`,
            ].join('\n'),
          }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
  ];
}
