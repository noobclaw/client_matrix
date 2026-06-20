/**
 * StreamingToolExecutor — executes tools as soon as their tool_use blocks
 * are fully streamed, WHILE the model is still generating.
 *
 * This reduces latency significantly for multi-tool responses:
 * e.g., 3 parallel Reads can start immediately instead of waiting
 * for the entire model response to complete.
 *
 * Ported from OpenClaw (Claude Code) src/services/tools/StreamingToolExecutor.ts
 */

import type { ToolUseBlock } from './anthropicClient';
import type { ToolDefinition, ToolContext } from './toolSystem';
import type { CanUseToolFn, ToolExecutionResult } from './toolOrchestration';
import { coworkLog } from './coworkLogger';

// ── Types ──

interface PendingTool {
  block: ToolUseBlock;
  isSafe: boolean;
  promise: Promise<ToolExecutionResult> | null; // null = not yet started (non-safe)
}

/**
 * Manages streaming tool execution.
 *
 * Usage:
 * 1. Create executor before streaming starts
 * 2. During streaming, call addTool() when a tool_use block completes
 * 3. Call getCompletedResults() periodically to yield finished results
 * 4. After streaming ends, call getRemainingResults() to drain all pending
 * 5. Call getAllResults() to get the complete list for building toolResultMessage
 */
export class StreamingToolExecutor {
  private pending: PendingTool[] = [];
  private completed: ToolExecutionResult[] = [];
  private yieldedIds = new Set<string>(); // Track which results have been yielded
  private allResults: ToolExecutionResult[] = []; // Complete list of ALL results
  private tools: ToolDefinition[];
  private context: ToolContext;
  private canUseTool: CanUseToolFn;
  private discarded = false;

  constructor(
    tools: ToolDefinition[],
    context: ToolContext,
    canUseTool: CanUseToolFn
  ) {
    this.tools = tools;
    this.context = context;
    this.canUseTool = canUseTool;
  }

  /**
   * Add a tool_use block for immediate execution.
   * Concurrency-safe tools start immediately; non-safe tools are queued.
   */
  addTool(block: ToolUseBlock): void {
    if (this.discarded) return;

    const tool = this.tools.find(t => t.name === block.name);
    const isSafe = typeof tool?.isConcurrencySafe === 'function'
      ? (tool.isConcurrencySafe as Function)(block.input)
      : (tool?.isConcurrencySafe ?? false);

    if (!isSafe) {
      // Queue non-safe tools — executed in getRemainingResults
      this.pending.push({ block, isSafe: false, promise: null });
      return;
    }

    // Execute concurrency-safe tools immediately
    const promise = this.executeOne(block);
    this.pending.push({ block, isSafe: true, promise });

    promise.then(result => {
      if (!this.discarded) {
        this.completed.push(result);
        this.allResults.push(result);
      }
    }).catch(err => {
      if (!this.discarded) {
        const errorResult: ToolExecutionResult = {
          toolUseId: block.id,
          toolName: block.name,
          result: {
            content: [{ type: 'text', text: `Streaming execution error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          },
        };
        this.completed.push(errorResult);
        this.allResults.push(errorResult);
      }
    });
  }

  /**
   * Get results that have completed since the last call.
   * Non-blocking — returns immediately with whatever is ready.
   * Marks results as yielded to prevent duplicates.
   */
  getCompletedResults(): ToolExecutionResult[] {
    const results: ToolExecutionResult[] = [];
    for (const r of this.completed) {
      if (!this.yieldedIds.has(r.toolUseId)) {
        this.yieldedIds.add(r.toolUseId);
        results.push(r);
      }
    }
    this.completed = [];
    return results;
  }

  /**
   * After streaming ends, execute remaining non-safe tools and
   * wait for all pending tools to complete.
   * Only yields results that haven't been yielded via getCompletedResults().
   */
  async *getRemainingResults(): AsyncGenerator<ToolExecutionResult> {
    if (this.discarded) return;

    for (const p of this.pending) {
      if (p.isSafe && p.promise) {
        // Already executing — wait for it, only yield if not already yielded
        try {
          const result = await p.promise;
          if (result && !this.yieldedIds.has(result.toolUseId)) {
            this.yieldedIds.add(result.toolUseId);
            yield result;
          }
        } catch (err) {
          const errorResult: ToolExecutionResult = {
            toolUseId: p.block.id,
            toolName: p.block.name,
            result: {
              content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            },
          };
          if (!this.yieldedIds.has(p.block.id)) {
            this.yieldedIds.add(p.block.id);
            this.allResults.push(errorResult);
            yield errorResult;
          }
        }
      } else if (!p.isSafe) {
        // Non-safe tool — execute now, serially
        const result = await this.executeOne(p.block);
        this.allResults.push(result);
        this.yieldedIds.add(result.toolUseId);
        yield result;
      }
    }

    this.pending = [];
  }

  /**
   * Get ALL results (both streaming-completed and remaining).
   * Used to build the toolResultMessage for the API.
   * Call AFTER getRemainingResults() has drained.
   */
  getAllResults(): ToolExecutionResult[] {
    return [...this.allResults];
  }

  /**
   * Discard all pending work (e.g., on streaming fallback or abort).
   */
  discard(): void {
    this.discarded = true;
    this.pending = [];
    this.completed = [];
    this.allResults = [];
    this.yieldedIds.clear();
    coworkLog('INFO', 'StreamingToolExecutor', 'Discarded all pending tools');
  }

  private async executeOne(block: ToolUseBlock): Promise<ToolExecutionResult> {
    const toolName = block.name;
    const toolInput = (block.input ?? {}) as Record<string, unknown>;

    const tool = this.tools.find(t => t.name === toolName);
    if (!tool) {
      return {
        toolUseId: block.id,
        toolName,
        result: {
          content: [{ type: 'text', text: `Tool "${toolName}" not found` }],
          isError: true,
        },
      };
    }

    try {
      const permission = await this.canUseTool(toolName, toolInput, {
        signal: this.context.abortSignal ?? new AbortController().signal,
      });

      if (permission.behavior === 'deny') {
        return {
          toolUseId: block.id,
          toolName,
          result: {
            content: [{ type: 'text', text: permission.message || 'Permission denied' }],
            isError: true,
          },
        };
      }

      const finalInput = permission.updatedInput
        ? { ...toolInput, ...permission.updatedInput }
        : toolInput;

      let validatedInput: unknown;
      try {
        validatedInput = tool.inputSchema.parse(finalInput);
      } catch (e) {
        return {
          toolUseId: block.id,
          toolName,
          result: {
            content: [{ type: 'text', text: `Input validation error: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          },
        };
      }

      coworkLog('INFO', 'StreamingToolExecutor', `Executing "${toolName}" (streaming)`, { toolUseId: block.id });
      const result = await tool.call(validatedInput as any, this.context);
      return { toolUseId: block.id, toolName, result };
    } catch (e) {
      return {
        toolUseId: block.id,
        toolName,
        result: {
          content: [{ type: 'text', text: `Tool error: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        },
      };
    }
  }
}
