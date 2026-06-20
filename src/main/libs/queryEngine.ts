/**
 * Query Engine — the core agent loop that replaces claude-agent-sdk's
 * black-box query() function.
 *
 * Implements: while(true) { API call → stream → detect tool_use → execute → loop }
 *
 * Ported from OpenClaw (Claude Code) src/query.ts
 */

import type { MessageParam, ToolUseBlock, MessageStreamEvent, ContentBlock, Tool as AnthropicTool } from './anthropicClient';
import {
  getAnthropicClient,
  createMessageStream,
  createMessage,
  type ApiConfig,
} from './anthropicClient';
import type { ToolDefinition, PermissionResult, ToolContext } from './toolSystem';
import { toolsToApiSchemas } from './toolSystem';
import { executeCompact, microcompactMessages, shouldCompact } from './coworkCompact';
import { hashPromptCacheKey, reportCacheKey } from './promptCacheMonitor';
import { StreamingToolExecutor } from './streamingToolExecutor';
import {
  buildUserMessage,
  buildToolResultMessage,
  extractToolUseBlocks,
  normalizeMessagesForAPI,
  truncateText,
  TOOL_RESULT_MAX_CHARS,
  setCurrentModel,
} from './messageManager';
import { runTools, type CanUseToolFn, type ToolExecutionResult } from './toolOrchestration';
import { coworkLog } from './coworkLogger';

// ── Types ──

/** Reasons the agent loop can terminate */
export type TerminalReason =
  | 'completed'          // Model finished without tool_use
  | 'max_turns'          // Hit turn limit
  | 'aborted'            // User/signal aborted
  | 'error'              // Unrecoverable API error
  | 'prompt_too_long';   // Context overflow, recovery failed

export interface Terminal {
  reason: TerminalReason;
  error?: string;
}

/** Events yielded by the query engine to the caller (UI layer) */
export type QueryEvent =
  | { type: 'stream_event'; event: MessageStreamEvent }
  | { type: 'assistant'; message: MessageParam }
  | { type: 'tool_use'; toolUseId: string; toolName: string; toolInput: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; toolName: string; content: string; isError: boolean }
  | { type: 'error'; error: string; code?: string }
  | { type: 'turn_start'; turnCount: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };

/** Parameters for the query engine */
export interface QueryParams {
  /** Initial user prompt (text) */
  prompt: string;

  /** Optional image attachments */
  images?: Array<{ name: string; mimeType: string; base64Data: string }>;

  /** System prompt */
  systemPrompt: string;

  /** Prior conversation messages (for continue/multi-turn) */
  priorMessages?: MessageParam[];

  /** Available tools (all — used for tool execution) */
  tools: ToolDefinition[];

  /** Pre-computed API tool schemas (subset — used for API calls, saves tokens) */
  apiToolSchemas?: AnthropicTool[];

  /** Effort level for this query (auto-detected or user-specified) */
  effort?: import('./effortSystem').EffortLevel;

  /** API configuration */
  apiConfig: ApiConfig;

  /** Working directory */
  cwd: string;

  /** Session ID */
  sessionId: string;

  /** Abort signal */
  abortSignal?: AbortSignal;

  /** Permission callback */
  canUseTool: CanUseToolFn;

  /** Max turns before stopping (default: 100) */
  maxTurns?: number;

  /** Callback when a tool result is ready (for real-time UI) */
  onToolResult?: (result: ToolExecutionResult) => void;
}

// ── Internal state ──
// Reference: OpenClaw src/query.ts State type

interface QueryState {
  messages: MessageParam[];
  turnCount: number;
  maxOutputTokensRecoveryCount: number;
}

// ── Constants ──

const DEFAULT_MAX_TURNS = 100;

// ── In-loop message compression (Claude Code pattern) ──
//
// Key principle: ONLY clear tool outputs, NEVER touch model reasoning.
// Tool outputs are large but re-fetchable (just Read again).
// Model reasoning is small but irreplaceable (decision context).
//
// What gets cleared:
//   - tool_result content (replaced with "[cleared]")
//   - thinking blocks from old turns (removed entirely)
//   - image blocks from old turns (each ~2000 tokens)
//
// What is PRESERVED:
//   - assistant text (model's reasoning and explanations)
//   - tool_use blocks (name + input — shows what tools were called)
//   - message structure (role alternation for API compatibility)

const KEEP_RECENT_RESULTS = 5;
const CLEARED_RESULT = '[Old tool result content cleared]';

function compressMessagesInLoop(messages: MessageParam[]): MessageParam[] {
  if (messages.length <= 6) return messages;

  // Find all tool_result positions (newest first)
  const toolResultPositions: Array<{ msgIdx: number; blockIdx: number }> = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let j = (msg.content as any[]).length - 1; j >= 0; j--) {
        const block = (msg.content as any[])[j];
        if (block?.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 100) {
          toolResultPositions.push({ msgIdx: i, blockIdx: j });
        }
      }
    }
  }

  // Mark which tool_results to clear (all except most recent N)
  const toClear = new Set<string>();
  for (let i = KEEP_RECENT_RESULTS; i < toolResultPositions.length; i++) {
    toClear.add(`${toolResultPositions[i].msgIdx}:${toolResultPositions[i].blockIdx}`);
  }

  if (toClear.size === 0) return messages;

  // Build compressed messages
  const compressed: MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const blocks = (msg.content as any[]).map((block: any, j: number) => {
        if (block?.type === 'tool_result' && toClear.has(`${i}:${j}`)) {
          return { ...block, content: CLEARED_RESULT };
        }
        return block;
      });
      compressed.push({ role: msg.role, content: blocks });
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      // Remove thinking + images from non-recent messages, KEEP text
      const isRecent = i >= messages.length - 6;
      const blocks = (msg.content as any[]).filter((block: any) => {
        if (!isRecent && block?.type === 'thinking') return false;
        if (!isRecent && block?.type === 'image') return false;
        return true;
      });
      compressed.push({ role: msg.role, content: blocks.length > 0 ? blocks : msg.content });
    } else {
      compressed.push(msg);
    }
  }

  coworkLog('INFO', 'queryEngine', `Micro-compact: cleared ${toClear.size} old tool results, kept ${KEEP_RECENT_RESULTS} recent`);
  return compressed;
}

/** Parse API error into user-friendly message */
function formatApiError(errMsg: string): { message: string; code: string } {
  if (errMsg.includes('402') || errMsg.includes('balance depleted') || errMsg.includes('top up')) {
    return { message: '账户余额不足，请充值后重试。\nInsufficient balance. Please top up and try again.', code: '402' };
  }
  if (errMsg.includes('401') || errMsg.includes('Unauthorized') || errMsg.includes('invalid.*key')) {
    return { message: 'API 密钥无效或已过期，请在设置中检查。\nInvalid API key. Please check your settings.', code: '401' };
  }
  if (errMsg.includes('429') || errMsg.includes('rate_limit')) {
    return { message: '请求频率超限，请稍后重试。\nRate limit exceeded. Please wait and try again.', code: '429' };
  }
  if (errMsg.includes('413') || errMsg.includes('prompt is too long') || errMsg.includes('prompt_too_long')) {
    return { message: '对话内容过长，请开始新对话或减少上下文。\nConversation too long. Start a new chat or reduce context.', code: '413' };
  }
  if (errMsg.includes('500') || errMsg.includes('internal_server_error')) {
    return { message: 'AI 服务暂时不可用，请稍后重试。\nAI service temporarily unavailable.', code: '500' };
  }
  if (errMsg.includes('timeout') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ECONNREFUSED')) {
    return { message: '网络连接超时，请检查网络或 API 服务状态。\nNetwork timeout. Check your connection.', code: 'timeout' };
  }
  return { message: errMsg, code: 'unknown' };
}
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
const DEFAULT_MAX_TOKENS = 16384;
const ESCALATED_MAX_TOKENS = 65536;

// ── Main query loop ──

/**
 * The core agent loop (non-streaming version).
 * @deprecated Use queryLoopStreaming instead — this version does not yield stream events.
 */
export async function* queryLoop(params: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
  const {
    prompt,
    images,
    systemPrompt,
    priorMessages,
    tools,
    apiConfig,
    cwd,
    sessionId,
    abortSignal,
    canUseTool,
    onToolResult,
  } = params;

  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
  const client = getAnthropicClient(apiConfig);
  const apiTools = params.apiToolSchemas ?? toolsToApiSchemas(tools);

  // Initialize state
  const userMessage = buildUserMessage(prompt, images?.map(i => ({
    mimeType: i.mimeType,
    base64Data: i.base64Data,
  })));

  let state: QueryState = {
    messages: [...(priorMessages || []), userMessage],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
  };

  coworkLog('INFO', 'queryEngine', 'Starting agent loop', {
    sessionId,
    model: apiConfig.model,
    toolCount: tools.length,
    maxTurns,
    priorMessageCount: priorMessages?.length || 0,
  });

  // ── Main loop ──
  // Reference: OpenClaw src/query.ts line 307 while(true)

  while (true) {
    // Check abort
    if (abortSignal?.aborted) {
      coworkLog('INFO', 'queryEngine', 'Aborted before API call');
      return { reason: 'aborted' };
    }

    // Check max turns
    if (state.turnCount >= maxTurns) {
      coworkLog('WARN', 'queryEngine', `Max turns reached: ${maxTurns}`);
      return { reason: 'max_turns' };
    }

    state.turnCount++;
    yield { type: 'turn_start', turnCount: state.turnCount };

    coworkLog('INFO', 'queryEngine', `Turn ${state.turnCount}: ${state.messages.length} messages, calling API`);

    // ── Phase 1: Normalize messages ──
    const messagesForQuery = normalizeMessagesForAPI(state.messages);

    // ── Phase 2: API call with streaming ──
    // Reference: OpenClaw src/query.ts line 659

    let assistantContentBlocks: Array<Record<string, unknown>> = [];
    let toolUseBlocks: ToolUseBlock[] = [];
    let needsFollowUp = false;
    let stopReason: string | null = null;
    let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null = null;

    const maxTokens = state.maxOutputTokensRecoveryCount > 0
      ? ESCALATED_MAX_TOKENS
      : (apiConfig.maxTokens ?? DEFAULT_MAX_TOKENS);

    // Report the prompt-cache key BEFORE the request is issued. If the
    // hash drifts turn-over-turn the monitor logs a WARN; the operator
    // can then trace which component made the prompt prefix unstable.
    try {
      const cacheKey = hashPromptCacheKey(systemPrompt, apiTools as unknown as unknown[]);
      reportCacheKey(sessionId, cacheKey, state.turnCount);
    } catch { /* non-fatal */ }

    try {
      const stream = await createMessageStream({
        client,
        model: apiConfig.model,
        systemPrompt,
        messages: messagesForQuery,
        tools: apiTools,
        maxTokens,
        thinkingBudget: apiConfig.thinkingBudget,
        signal: abortSignal,
        apiConfig,
      });

      // ── Phase 3: Stream processing ──
      // Reference: OpenClaw src/query.ts line 659-863

      // Use the stream's event emitter pattern
      const finalMessage = await stream.finalMessage();

      // Extract content blocks from the final message
      for (const block of finalMessage.content) {
        assistantContentBlocks.push(block as unknown as Record<string, unknown>);

        if (block.type === 'tool_use') {
          toolUseBlocks.push(block as ToolUseBlock);
          needsFollowUp = true;
        }
      }

      stopReason = finalMessage.stop_reason;
      usage = finalMessage.usage as typeof usage;

      // Yield streaming events for UI
      // We forward the raw stream events so the existing handleStreamEvent can process them
      // But since we consumed the stream via finalMessage(), we emit the assembled result
      // The caller should use the 'assistant' event type for the complete message

    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      // Check for abort
      if (abortSignal?.aborted) {
        return { reason: 'aborted' };
      }

      // ── Phase 4: Error recovery ──
      // Reference: OpenClaw src/query.ts lines 1062-1242

      // Prompt too long (413)
      if (errMsg.includes('prompt is too long') || errMsg.includes('413') || errMsg.includes('prompt_too_long')) {
        coworkLog('ERROR', 'queryEngine', 'Prompt too long error', { messageCount: messagesForQuery.length });
        const parsed = formatApiError(errMsg);
        yield { type: 'error', error: parsed.message, code: parsed.code };
        return { reason: 'prompt_too_long', error: errMsg };
      }

      // Rate limit — if we reach here, SDK retries were exhausted
      if (errMsg.includes('429') || errMsg.includes('rate_limit')) {
        coworkLog('ERROR', 'queryEngine', 'Rate limit error (SDK retries exhausted)');
      }

      coworkLog('ERROR', 'queryEngine', `API error: ${errMsg}`);
      const parsed = formatApiError(errMsg);
      yield { type: 'error', error: parsed.message, code: parsed.code };
      return { reason: 'error', error: errMsg };
    }

    // Yield usage info
    if (usage) {
      yield {
        type: 'usage',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
      };
    }

    // Build the assistant message for conversation history
    const assistantMessage: MessageParam = {
      role: 'assistant',
      content: assistantContentBlocks as any,
    };

    // Yield the complete assistant message
    yield { type: 'assistant', message: assistantMessage };

    // Yield individual tool_use events for UI
    for (const block of toolUseBlocks) {
      yield {
        type: 'tool_use',
        toolUseId: block.id,
        toolName: block.name,
        toolInput: (block.input ?? {}) as Record<string, unknown>,
      };
    }

    // ── Check: max_tokens recovery ──
    // Reference: OpenClaw src/query.ts lines 1188-1256
    if (stopReason === 'max_tokens' && !needsFollowUp) {
      if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        coworkLog('WARN', 'queryEngine', `max_tokens hit, recovery attempt ${state.maxOutputTokensRecoveryCount + 1}`);
        state.maxOutputTokensRecoveryCount++;
        // Add assistant message + a user nudge to continue
        state.messages = [
          ...messagesForQuery,
          assistantMessage,
          { role: 'user', content: 'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.' },
        ];
        continue;
      }
    }

    // ── Phase 5: No tool_use → completed ──
    if (!needsFollowUp) {
      coworkLog('INFO', 'queryEngine', `Turn ${state.turnCount}: completed (stop_reason=${stopReason})`);
      return { reason: 'completed' };
    }

    // ── Phase 6: Execute tools ──
    // Reference: OpenClaw src/query.ts lines 1384-1443

    const toolContext: ToolContext = {
      sessionId,
      cwd,
      abortSignal,
    };

    const toolResults = await runTools(
      toolUseBlocks,
      tools,
      toolContext,
      canUseTool,
      (result) => {
        // Yield tool_result events for real-time UI
        const content = result.result.content.map(c => c.text).join('\n');
        // Note: we use a synchronous callback here; the yield happens below
        if (onToolResult) onToolResult(result);
      }
    );

    // Check abort after tool execution
    if (abortSignal?.aborted) {
      return { reason: 'aborted' };
    }

    // Yield tool results for UI
    for (const tr of toolResults) {
      const content = tr.result.content.map(c => c.text).join('\n');
      yield {
        type: 'tool_result',
        toolUseId: tr.toolUseId,
        toolName: tr.toolName,
        content: truncateText(content, TOOL_RESULT_MAX_CHARS),
        isError: tr.result.isError ?? false,
      };
    }

    // Build tool_result message for conversation history
    const toolResultMessage = buildToolResultMessage(
      toolResults.map(tr => ({
        tool_use_id: tr.toolUseId,
        content: truncateText(
          tr.result.content.map(c => c.text).join('\n'),
          TOOL_RESULT_MAX_CHARS
        ),
        is_error: tr.result.isError,
      }))
    );

    // ── Phase 7: Update state, continue loop ──
    // Reference: OpenClaw src/query.ts lines 1714-1728

    state = {
      messages: [...messagesForQuery, assistantMessage, toolResultMessage],
      turnCount: state.turnCount,
      maxOutputTokensRecoveryCount: 0,
    };

    coworkLog('INFO', 'queryEngine', `Turn ${state.turnCount}: ${toolUseBlocks.length} tools executed, continuing loop`);
  }
}

// ── Convenience wrapper that also handles streaming ──

/**
 * Higher-level wrapper that runs queryLoop and also provides
 * streaming text/thinking deltas for the UI.
 *
 * This version uses the stream's event iterator instead of finalMessage()
 * for true real-time streaming.
 */
export async function* queryLoopStreaming(params: QueryParams): AsyncGenerator<QueryEvent, Terminal> {
  const {
    prompt,
    images,
    systemPrompt,
    priorMessages,
    tools,
    apiConfig,
    cwd,
    sessionId,
    abortSignal,
    canUseTool,
    onToolResult,
  } = params;

  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS;
  const client = getAnthropicClient(apiConfig);
  const apiTools = params.apiToolSchemas ?? toolsToApiSchemas(tools);

  // Set current model for proportional tool result truncation
  try { setCurrentModel(apiConfig.model || ''); } catch {}

  const userMessage = buildUserMessage(prompt, images?.map(i => ({
    mimeType: i.mimeType,
    base64Data: i.base64Data,
  })));

  let state: QueryState = {
    messages: [...(priorMessages || []), userMessage],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
  };

  let hasAttemptedReactiveCompact = false;

  while (true) {
    if (abortSignal?.aborted) return { reason: 'aborted' as const };
    if (state.turnCount >= maxTurns) return { reason: 'max_turns' as const };

    state.turnCount++;
    yield { type: 'turn_start', turnCount: state.turnCount };

    // ── In-loop message compression (Claude Code pattern) ──
    // Keep recent 3 turns complete, strip tool_result content from older turns.
    // This prevents messages from growing unbounded across agent loop iterations.
    if (state.turnCount > 3 && state.messages.length > 10) {
      state.messages = compressMessagesInLoop(state.messages);
    }

    const messagesForQuery = normalizeMessagesForAPI(state.messages);
    const maxTokens = state.maxOutputTokensRecoveryCount > 0
      ? ESCALATED_MAX_TOKENS
      : (apiConfig.maxTokens ?? DEFAULT_MAX_TOKENS);

    let assistantContentBlocks: Array<Record<string, unknown>> = [];
    let toolUseBlocks: ToolUseBlock[] = [];
    let needsFollowUp = false;
    let stopReason: string | null = null;
    let usage: any = null;

    // ── StreamingToolExecutor: start executing tools during streaming ──
    // Reference: OpenClaw src/services/tools/StreamingToolExecutor.ts
    const toolContext: ToolContext = { sessionId, cwd, abortSignal };
    const streamingExecutor = new StreamingToolExecutor(tools, toolContext, canUseTool);
    let streamingFailed = false;

    try {
      if (apiConfig.isOpenAICompat) {
        // ── OpenAI-compat: non-streaming to avoid SDK MessageStream parser bug ──
        // SDK's MessageStream.js crashes on proxy SSE because proxy's message_start
        // event may lack content:[] field, causing internal this._currentMessage.content
        // to be undefined when SDK tries to .push() content blocks.
        coworkLog('INFO', 'queryEngine', 'Using non-streaming mode for OpenAI-compat provider');
        const response = await createMessage({
          client,
          model: apiConfig.model,
          systemPrompt,
          messages: messagesForQuery,
          tools: apiTools,
          maxTokens,
          signal: abortSignal,
          apiConfig,
        });

        for (const block of response.content) {
          assistantContentBlocks.push(block as unknown as Record<string, unknown>);
          if (block.type === 'tool_use') {
            toolUseBlocks.push(block as ToolUseBlock);
            needsFollowUp = true;
            // Queue tool for execution (non-streaming path)
            streamingExecutor.addTool(block as ToolUseBlock);
          }
        }
        stopReason = response.stop_reason;
        usage = response.usage;
      } else {
        // ── Anthropic direct: streaming for real-time UI ──
        const stream = await createMessageStream({
          client,
          model: apiConfig.model,
          systemPrompt,
          messages: messagesForQuery,
          tools: apiTools,
          maxTokens,
          thinkingBudget: apiConfig.thinkingBudget,
          signal: abortSignal,
          apiConfig,
        });

        for await (const event of stream) {
          yield { type: 'stream_event', event };
        }

        const finalMessage = await stream.finalMessage();
        for (const block of finalMessage.content) {
          assistantContentBlocks.push(block as unknown as Record<string, unknown>);
          if (block.type === 'tool_use') {
            toolUseBlocks.push(block as ToolUseBlock);
            needsFollowUp = true;
          }
        }
        stopReason = finalMessage.stop_reason;
        usage = finalMessage.usage;
      }

    } catch (e) {
      if (abortSignal?.aborted) {
        streamingExecutor.discard();
        return { reason: 'aborted' as const };
      }

      const errMsg = e instanceof Error ? e.message : String(e);

      // ── Streaming fallback: retry without streaming ──
      // Reference: OpenClaw src/query.ts FallbackTriggeredError
      if (errMsg.includes('stream') || errMsg.includes('SSE') || errMsg.includes('network')) {
        if (!streamingFailed) {
          streamingFailed = true;
          streamingExecutor.discard();
          coworkLog('WARN', 'queryEngine', 'Streaming failed, retrying with non-streaming fallback');

          try {
            const response = await createMessage({
              client,
              model: apiConfig.model,
              systemPrompt,
              messages: messagesForQuery,
              tools: apiTools,
              maxTokens,
              signal: abortSignal,
            });

            for (const block of response.content) {
              assistantContentBlocks.push(block as unknown as Record<string, unknown>);
              if (block.type === 'tool_use') {
                toolUseBlocks.push(block as ToolUseBlock);
                needsFollowUp = true;
              }
            }
            stopReason = response.stop_reason;
            usage = response.usage;
            // Fall through to normal post-processing below
          } catch (fallbackErr) {
            const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            coworkLog('ERROR', 'queryEngine', `Non-streaming fallback also failed: ${fbMsg}`);
            const parsed = formatApiError(fbMsg);
            yield { type: 'error', error: parsed.message, code: parsed.code };
            return { reason: 'error' as const, error: fbMsg };
          }
        }
      }

      // ── Prompt-too-long recovery ──
      // Reference: OpenClaw src/query.ts lines 1065-1183
      if (!streamingFailed && (errMsg.includes('prompt is too long') || errMsg.includes('413') || errMsg.includes('prompt_too_long'))) {
        streamingExecutor.discard();
        coworkLog('WARN', 'queryEngine', 'Prompt too long — attempting reactive compact', {
          messageCount: messagesForQuery.length,
          hasAttemptedReactiveCompact,
        });

        if (!hasAttemptedReactiveCompact) {
          hasAttemptedReactiveCompact = true;
          try {
            const compactMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
            for (const msg of state.messages) {
              const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
              if (content.trim()) compactMessages.push({ role: msg.role, content });
            }

            if (compactMessages.length > 4) {
              const summary = await executeCompact({
                apiKey: apiConfig.apiKey,
                model: apiConfig.model,
                baseURL: apiConfig.baseUrl,
                messages: compactMessages,
              });

              if (summary) {
                coworkLog('INFO', 'queryEngine', 'Reactive compact succeeded, retrying');
                const recentCount = Math.min(4, state.messages.length);
                state.messages = [
                  { role: 'user', content: summary },
                  { role: 'assistant', content: 'I understand the context. Continuing from where we left off.' },
                  ...state.messages.slice(-recentCount),
                ];
                state.turnCount--;
                continue;
              }
            }
          } catch (compactErr) {
            coworkLog('ERROR', 'queryEngine', `Reactive compact failed: ${compactErr}`);
          }
        }
        { const parsed = formatApiError(errMsg); yield { type: 'error', error: parsed.message, code: parsed.code }; }
        return { reason: 'prompt_too_long' as const, error: errMsg };
      }

      if (!streamingFailed) {
        streamingExecutor.discard();
        if (errMsg.includes('429') || errMsg.includes('rate_limit')) {
          coworkLog('ERROR', 'queryEngine', 'Rate limit error (SDK retries exhausted)');
        }
        coworkLog('ERROR', 'queryEngine', `API error: ${errMsg}`, {
          stack: e instanceof Error ? e.stack : undefined,
        });
        { const parsed = formatApiError(errMsg); yield { type: 'error', error: parsed.message, code: parsed.code }; }
        return { reason: 'error' as const, error: errMsg };
      }
    }

    // ── Post-stream processing ──

    if (usage) {
      yield {
        type: 'usage',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
      };
    }

    const assistantMessage: MessageParam = { role: 'assistant', content: assistantContentBlocks as any };
    yield { type: 'assistant', message: assistantMessage };

    for (const block of toolUseBlocks) {
      yield {
        type: 'tool_use',
        toolUseId: block.id,
        toolName: block.name,
        toolInput: (block.input ?? {}) as Record<string, unknown>,
      };
    }

    // max_tokens recovery
    if (stopReason === 'max_tokens' && !needsFollowUp) {
      if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        state.maxOutputTokensRecoveryCount++;
        state.messages = [
          ...messagesForQuery,
          assistantMessage,
          { role: 'user', content: 'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.' },
        ];
        continue;
      }
    }

    if (!needsFollowUp) return { reason: 'completed' as const };

    // ── Execute remaining tools (non-safe tools queued during streaming) ──
    for await (const result of streamingExecutor.getRemainingResults()) {
      if (onToolResult) onToolResult(result);
      const content = result.result.content.map(c => c.text).join('\n');
      yield {
        type: 'tool_result',
        toolUseId: result.toolUseId,
        toolName: result.toolName,
        content: truncateText(content, TOOL_RESULT_MAX_CHARS),
        isError: result.result.isError ?? false,
      };
    }

    if (abortSignal?.aborted) return { reason: 'aborted' as const };

    // Use getAllResults() to get COMPLETE list (streaming-completed + remaining)
    const allToolResults = streamingExecutor.getAllResults();

    const toolResultMessage = buildToolResultMessage(
      allToolResults.map(tr => ({
        tool_use_id: tr.toolUseId,
        content: truncateText(tr.result.content.map(c => c.text).join('\n'), TOOL_RESULT_MAX_CHARS),
        is_error: tr.result.isError,
      }))
    );

    state = {
      messages: [...messagesForQuery, assistantMessage, toolResultMessage],
      turnCount: state.turnCount,
      maxOutputTokensRecoveryCount: 0,
    };
  }
}
