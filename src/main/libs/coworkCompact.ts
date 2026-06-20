/**
 * Context compaction module — ported from Claude Code's compact system.
 *
 * When a conversation exceeds a token threshold, this module summarizes the
 * entire history into a structured summary using the same model, then replaces
 * the old messages with the summary so the conversation can continue without
 * losing important context.
 */

import { coworkLog } from './coworkLogger';

// ── Compact prompt (ported verbatim from Claude Code prompts.ts) ──────────

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const DETAILED_ANALYSIS_INSTRUCTION = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

const POST_COMPACT_USER_MESSAGE = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.`;

// ── Rough token estimation ────────────────────────────────────────────────

/**
 * Estimate token count from a string.
 * Rough heuristic: ~4 chars per token for English, ~2 for CJK.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(nonCjkLength / 4 + cjkCount / 1.5);
}

function estimateMessagesTokens(messages: Array<{ content?: string; type?: string }>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content || '');
    total += 4; // message framing overhead
  }
  return total;
}

// ── Compact summary formatting ────────────────────────────────────────────

/**
 * Strip the <analysis> scratchpad block from the compact result,
 * keeping only the <summary> content.
 */
function formatCompactSummary(rawOutput: string): string {
  // Remove <analysis>...</analysis> block
  let cleaned = rawOutput.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  // Extract content from <summary> tags if present
  const summaryMatch = cleaned.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    cleaned = summaryMatch[1].trim();
  }
  return cleaned;
}

// ── Compaction trigger check ──────────────────────────────────────────────

export interface CompactConfig {
  /** Context window size in tokens (default: model-dependent, fallback 128000) */
  contextWindowSize?: number;
  /** Max output tokens reserved (default: 16384) */
  maxOutputTokens?: number;
  /** Buffer before triggering compact (default: 13000) */
  bufferTokens?: number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 16_384;
const DEFAULT_BUFFER = 13_000;

/**
 * Check whether compaction should be triggered based on estimated token usage.
 */
export function shouldCompact(
  messages: Array<{ content?: string; type?: string }>,
  config: CompactConfig = {}
): boolean {
  const contextWindow = config.contextWindowSize || DEFAULT_CONTEXT_WINDOW;
  const maxOutput = config.maxOutputTokens || DEFAULT_MAX_OUTPUT;
  const buffer = config.bufferTokens || DEFAULT_BUFFER;

  const currentTokens = estimateMessagesTokens(messages);
  const threshold = contextWindow - maxOutput - buffer;

  coworkLog('INFO', 'shouldCompact', `tokens≈${currentTokens} threshold=${threshold}`);
  return currentTokens > threshold;
}

// ── Build compact request ─────────────────────────────────────────────────

export interface CompactRequest {
  systemPrompt: string;
  userMessage: string;
}

/**
 * Build the prompt pair for a compaction API call.
 * The conversation history should be passed as prior assistant/user messages
 * in the API call; this function returns the final user message that triggers
 * the summary.
 */
export function buildCompactRequest(): CompactRequest {
  return {
    systemPrompt: 'You are a helpful assistant that summarizes conversations accurately and thoroughly.',
    userMessage: NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT,
  };
}

// ── Format the compacted summary for injection ────────────────────────────

/**
 * Given the raw model output from a compact call, produce a clean summary
 * string suitable for injection as conversation history.
 */
export function processCompactResult(rawOutput: string): string {
  const summary = formatCompactSummary(rawOutput);
  return `${POST_COMPACT_USER_MESSAGE}\n\nSummary:\n${summary}`;
}

// ── Perform compaction via direct Anthropic API call ───────────────────────

export interface CompactOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  config?: CompactConfig;
}

/**
 * Execute a compaction call using the Anthropic Messages API.
 * Returns the formatted summary string, or null on failure.
 *
 * Circuit breaker: caller should track consecutive failures and stop
 * retrying after 3.
 */
export async function executeCompact(options: CompactOptions): Promise<string | null> {
  const { apiKey, model, baseURL, messages } = options;

  if (!apiKey || !messages || messages.length === 0) {
    coworkLog('WARN', 'executeCompact', 'Missing apiKey or messages');
    return null;
  }

  const compactReq = buildCompactRequest();

  // Ensure alternating user/assistant roles for API compliance
  // If last message is user, insert a synthetic assistant message
  const paddedMessages = [...messages];
  if (paddedMessages.length > 0 && paddedMessages[paddedMessages.length - 1].role === 'user') {
    paddedMessages.push({ role: 'assistant' as const, content: 'Understood. Please continue.' });
  }
  const apiMessages = [
    ...paddedMessages,
    { role: 'user' as const, content: compactReq.userMessage },
  ];

  try {
    coworkLog('INFO', 'executeCompact', `Compacting ${messages.length} messages with model ${model}`);

    const url = `${baseURL || 'https://api.anthropic.com'}/v1/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: compactReq.systemPrompt,
        messages: apiMessages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      coworkLog('ERROR', 'executeCompact', `API error: ${response.status} ${errorText.slice(0, 500)}`);
      return null;
    }

    const data = await response.json();
    const rawText = data?.content?.[0]?.text;
    if (!rawText) {
      coworkLog('ERROR', 'executeCompact', 'No text in API response');
      return null;
    }

    const result = processCompactResult(rawText);
    coworkLog('INFO', 'executeCompact', `Compact complete: ${estimateTokens(result)} tokens summary`);
    return result;
  } catch (error) {
    coworkLog('ERROR', 'executeCompact', `Compact failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ── Layer 1: Microcompact — clear old tool results without LLM call ───────
// Ported from Claude Code services/compact/microCompact.ts

/** Tool names whose results can be safely cleared after they age out */
const COMPACTABLE_TOOLS = new Set([
  'Read', 'FileRead', 'Bash', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'Edit', 'FileEdit', 'Write', 'FileWrite',
  'browser_read_page', 'browser_get_text', 'browser_screenshot',
  'desktop_screenshot',
]);

export const TOOL_RESULT_CLEARED_MARKER = '[Old tool result content cleared]';
const TOOL_RESULT_CLEARED = TOOL_RESULT_CLEARED_MARKER;

/**
 * Store message shape (from CoworkStore).
 * tool_use messages have metadata.toolName and metadata.toolUseId.
 * tool_result messages have metadata.toolUseId matching the tool_use.
 */
interface StoreMessage {
  id: string;
  content?: string;
  type?: string;
  metadata?: {
    toolName?: string;
    toolUseId?: string | null;
    [key: string]: unknown;
  };
}

/**
 * Layer 1 microcompact: Clear old tool results to free context space.
 * Keeps the most recent `keepRecent` tool results intact.
 * Returns a new messages array (does not mutate input).
 *
 * Ported from OpenClaw: first build toolUseId → toolName map from tool_use
 * messages, then match tool_result messages by toolUseId to find their tool name.
 */
export function microcompactMessages(
  messages: StoreMessage[],
  keepRecent: number = 5
): StoreMessage[] {
  // Step 1: Build toolUseId → toolName map from tool_use messages
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type === 'tool_use' && msg.metadata?.toolName && msg.metadata?.toolUseId) {
      toolNameMap.set(msg.metadata.toolUseId, msg.metadata.toolName);
    }
  }

  // Step 2: Find compactable tool_result indices
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type !== 'tool_result') continue;
    if (msg.content === TOOL_RESULT_CLEARED) continue; // already cleared

    const toolUseId = msg.metadata?.toolUseId;
    if (!toolUseId) continue;

    const toolName = toolNameMap.get(toolUseId) || '';
    if (COMPACTABLE_TOOLS.has(toolName)) {
      toolResultIndices.push(i);
    }
  }

  if (toolResultIndices.length <= keepRecent) {
    return messages; // Nothing to clear
  }

  // Step 3: Clear all but the most recent keepRecent
  const toClear = new Set(toolResultIndices.slice(0, -keepRecent));
  const cleared = messages.map((msg, i) => {
    if (toClear.has(i)) {
      return { ...msg, content: TOOL_RESULT_CLEARED };
    }
    return msg;
  });

  coworkLog('INFO', 'microcompactMessages', `Cleared ${toClear.size} old tool results, kept ${keepRecent} recent`);
  return cleared;
}

// ── Layer 2: Session Memory Compact — use pre-extracted notes ─────────────
// Ported from Claude Code services/compact/sessionMemoryCompact.ts

/**
 * Layer 2: If a session memory file exists (from SessionMemory extraction),
 * use it as the summary instead of running a full LLM compaction call.
 * Much cheaper — no API call needed.
 *
 * Returns the summary string if session memory is available, or null.
 */
export function trySessionMemoryCompact(
  sessionMemoryContent: string | null,
  messages: Array<{ content?: string; type?: string }>,
  minKeepMessages: number = 5,
  minKeepTokens: number = 10_000,
  maxKeepTokens: number = 40_000
): string | null {
  if (!sessionMemoryContent || sessionMemoryContent.trim().length < 50) {
    return null;
  }

  // Calculate how many messages to keep (from the end)
  let keepIndex = messages.length;
  let keptTokens = 0;
  let textBlockCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(messages[i].content || '');
    if (keptTokens + tokens > maxKeepTokens) break;
    keptTokens += tokens;
    keepIndex = i;
    if (messages[i].content && messages[i].content!.trim().length > 0) {
      textBlockCount++;
    }
    // Stop expanding once we meet both minimums
    if (keptTokens >= minKeepTokens && textBlockCount >= minKeepMessages) break;
  }

  const summary = `${POST_COMPACT_USER_MESSAGE}\n\nSession Notes:\n${sessionMemoryContent}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly.`;

  coworkLog('INFO', 'trySessionMemoryCompact', `Using session memory as summary, keeping ${messages.length - keepIndex} recent messages`);
  return summary;
}

// ── Layer 3: Full compact — already implemented above as executeCompact ───

// ── Orchestrator: try layers in order ─────────────────────────────────────

export interface MultiLayerCompactOptions extends CompactOptions {
  sessionMemoryContent?: string | null;
}

/**
 * Try compaction strategies in order:
 * 1. Microcompact (clear old tool results)
 * 2. Session Memory Compact (use pre-extracted notes)
 * 3. Full LLM Compact (API call)
 *
 * Returns the summary string or null if all layers fail.
 */
export async function multiLayerCompact(options: MultiLayerCompactOptions): Promise<{
  summary: string | null;
  layer: 'microcompact' | 'session_memory' | 'full_compact' | 'none';
  microcompactedMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
}> {
  const { messages, sessionMemoryContent } = options;

  // Layer 1: Microcompact — try clearing old tool results first
  // (This happens at the message level in coworkRunner, not here)

  // Layer 2: Session Memory Compact — use pre-extracted notes if available
  if (sessionMemoryContent) {
    const smMessages = messages.map(m => ({ content: m.content, type: m.role }));
    const summary = trySessionMemoryCompact(sessionMemoryContent, smMessages);
    if (summary) {
      return { summary, layer: 'session_memory' };
    }
  }

  // Layer 3: Full LLM Compact
  const summary = await executeCompact(options);
  if (summary) {
    return { summary, layer: 'full_compact' };
  }

  return { summary: null, layer: 'none' };
}

// ── Layer 0: Time-based Microcompact ────────────────────────────────────
// Reference: Claude Code src/services/compact/timeBasedMCConfig.ts
// Triggers when gap since last assistant message > threshold (cache expired)

const TIME_BASED_MC_GAP_MINUTES = 60; // 1 hour (matches prompt cache TTL)
const IMAGE_MAX_TOKEN_SIZE = 2000;     // Flat cap per image

/**
 * Check if time-based micro-compact should trigger.
 * Returns true if the gap since last assistant message exceeds the threshold.
 */
export function shouldTimeBasedMicrocompact(
  messages: Array<{ type?: string; timestamp?: number }>,
  lastAssistantTimestamp?: number
): boolean {
  if (!lastAssistantTimestamp) {
    // Find the last assistant message timestamp
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'assistant' && messages[i].timestamp) {
        lastAssistantTimestamp = messages[i].timestamp;
        break;
      }
    }
  }
  if (!lastAssistantTimestamp) return false;

  const gapMinutes = (Date.now() - lastAssistantTimestamp) / 60_000;
  return gapMinutes >= TIME_BASED_MC_GAP_MINUTES;
}

/**
 * Apply time-based micro-compact: clears old tool results when cache is cold.
 * More aggressive than regular micro-compact since the full context must be resent anyway.
 */
export function timeBasedMicrocompactMessages(
  messages: StoreMessage[],
  keepRecent: number = 3 // Keep fewer than regular MC since cache is cold
): { messages: StoreMessage[]; clearedCount: number } {
  // Build toolUseId → toolName map
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type === 'tool_use' && msg.metadata?.toolName && msg.metadata?.toolUseId) {
      toolNameMap.set(msg.metadata.toolUseId, msg.metadata.toolName);
    }
  }

  // Find clearable tool_result indices
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type !== 'tool_result') continue;
    if (msg.content === TOOL_RESULT_CLEARED) continue;
    const toolUseId = msg.metadata?.toolUseId;
    if (!toolUseId) continue;
    const toolName = toolNameMap.get(toolUseId) || '';
    if (COMPACTABLE_TOOLS.has(toolName)) {
      toolResultIndices.push(i);
    }
  }

  if (toolResultIndices.length <= keepRecent) {
    return { messages, clearedCount: 0 };
  }

  const toClear = new Set(toolResultIndices.slice(0, -keepRecent));
  let clearedCount = 0;
  const result = messages.map((msg, i) => {
    if (toClear.has(i)) {
      clearedCount++;
      return { ...msg, content: TOOL_RESULT_CLEARED };
    }
    return msg;
  });

  coworkLog('INFO', 'timeBasedMicrocompact', `Cleared ${clearedCount} old tool results (time-based, kept ${keepRecent} recent)`);
  return { messages: result, clearedCount };
}

// Re-exports for convenience
export { estimateTokens, estimateMessagesTokens, POST_COMPACT_USER_MESSAGE };
