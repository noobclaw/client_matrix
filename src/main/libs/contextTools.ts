/**
 * Context Tools — tool_search for deferred tool loading.
 * When context engine defers tool descriptions, the model uses this
 * tool to look up full details of a tool it needs.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import { searchTools, type DeferredToolSet } from './contextEngine';

/**
 * Build the tool_search tool.
 * Must be called with the deferred tool set so it can search original definitions.
 */
export function buildContextTools(deferredToolSet: DeferredToolSet): ToolDefinition[] {
  if (!deferredToolSet.isDeferred) {
    // No deferred loading — no need for tool_search
    return [];
  }

  return [
    buildTool({
      name: 'tool_search',
      description: [
        'Search for available tools by keyword. Returns full tool descriptions and input schemas.',
        'Use this when you see a tool marked [Deferred] and need its full details before calling it.',
        '',
        'Example: tool_search query="browser upload" to find browser_upload_file details.',
      ].join('\n'),
      inputSchema: z.object({
        query: z.string().min(1).describe('Keywords to search for (tool name or capability)'),
        max_results: z.number().min(1).max(10).optional().describe('Max results (default: 5)'),
      }),
      call: async (input) => {
        const results = searchTools(
          input.query,
          deferredToolSet.originalTools,
          input.max_results ?? 5
        );

        if (results.length === 0) {
          return { content: [{ type: 'text', text: `No tools found matching "${input.query}".` }] };
        }

        const formatted = results.map(r =>
          `**${r.name}**\n${r.description}\nInput: ${JSON.stringify(r.inputSchema, null, 2)}`
        ).join('\n\n---\n\n');

        return {
          content: [{ type: 'text', text: `Found ${results.length} tools:\n\n${formatted}` }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
  ];
}
