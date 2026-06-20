/**
 * Message Manager — handles message array construction, normalization,
 * and tool_use/tool_result pairing for the Anthropic Messages API.
 *
 * Ported from OpenClaw (Claude Code) src/utils/messages.ts
 */

import type { MessageParam, ContentBlockParam, ToolResultBlockParam, ToolUseBlock } from './anthropicClient';
import { coworkLog } from './coworkLogger';

// ── Constants ──

/** Max characters for a single tool result before truncation.
 *
 * Tightened from 30_000 → 8_192 (8 KB ≈ 2K tokens) to slash prompt-cache
 * bloat. Every tool_result ends up in the conversation history forever
 * and is re-sent on every subsequent turn; at the old 30K ceiling a
 * handful of Read / Bash calls could quietly dump 50K+ tokens into the
 * cache prefix. 8 KB is enough to show the head + tail of most file
 * reads / command outputs, and the truncation is now MIDDLE-cut
 * (see `truncateText` below) so both the beginning of a file and its
 * most recent output are preserved.
 *
 * If the caller genuinely needs more, it should pass a larger `maxChars`
 * explicitly — or re-read with Read offset/limit params. */
export const TOOL_RESULT_MAX_CHARS = 8_192;

/** Maximum share of context window a single tool result can occupy.
 * Reference: OpenClaw tool-result-truncation.ts MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3 */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/** Approximate chars per token (for context window calculation) */
const CHARS_PER_TOKEN = 4;

/** Context window sizes by model family (in tokens) */
const MODEL_CONTEXT_SIZES: Record<string, number> = {
  'claude': 200000,
  'gpt-5': 128000,
  'gpt-4': 128000,
  'gemini': 2000000,
  'qwen': 131072,
  'deepseek': 131072,
  'glm': 131072,
  'kimi': 131072,
  'default': 128000,
};

let _currentModel = '';

/** Set the current model for proportional truncation */
export function setCurrentModel(model: string): void {
  _currentModel = model.toLowerCase();
}

/** Get the max chars for tool results based on current model's context window */
export function getToolResultMaxChars(): number {
  const model = _currentModel;
  let contextTokens = MODEL_CONTEXT_SIZES['default'];
  for (const [prefix, tokens] of Object.entries(MODEL_CONTEXT_SIZES)) {
    if (model.includes(prefix)) { contextTokens = tokens; break; }
  }
  const maxChars = Math.floor(contextTokens * CHARS_PER_TOKEN * MAX_TOOL_RESULT_CONTEXT_SHARE);
  // Clamp between 10K and 200K
  return Math.max(10_000, Math.min(200_000, maxChars));
}

/** Max characters for streaming text content */
export const STREAMING_TEXT_MAX_CHARS = 120_000;

/** Max characters for streaming thinking content */
export const STREAMING_THINKING_MAX_CHARS = 60_000;

// ── Message construction helpers ──

/**
 * Build a user message with text content and optional image attachments.
 */
export function buildUserMessage(
  text: string,
  images?: Array<{ mimeType: string; base64Data: string }>
): MessageParam {
  if (!images || images.length === 0) {
    return { role: 'user', content: text };
  }

  const content: ContentBlockParam[] = [];

  if (text.trim()) {
    content.push({ type: 'text', text });
  }

  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: img.base64Data,
      },
    });
  }

  return { role: 'user', content };
}

/**
 * Build an assistant message from content blocks.
 */
export function buildAssistantMessage(
  contentBlocks: Array<{ type: string; [key: string]: unknown }>
): MessageParam {
  return {
    role: 'assistant',
    content: contentBlocks as unknown as ContentBlockParam[],
  };
}

/**
 * Build a tool_result user message from executed tool results.
 * Reference: OpenClaw — every tool_use must have a matching tool_result.
 */
export function buildToolResultMessage(
  results: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>
): MessageParam {
  const content: ToolResultBlockParam[] = results.map(r => ({
    type: 'tool_result' as const,
    tool_use_id: r.tool_use_id,
    content: r.content,
    is_error: r.is_error,
  }));

  return { role: 'user', content };
}

// ── Normalization ──

/**
 * Ensure every tool_use in assistant messages has a matching tool_result,
 * and every tool_result has a matching tool_use.
 *
 * Orphaned tool_use: inserts fixup user message RIGHT AFTER the assistant
 * message containing it (not at the end).
 * Orphaned tool_result: removes the orphaned block entirely.
 *
 * Reference: OpenClaw src/utils/messages.ts ensureToolResultPairing()
 */
export function ensureToolResultPairing(messages: MessageParam[]): MessageParam[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  // Pass 1: collect all IDs
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (typeof block === 'string') continue;
      const b = block as unknown as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolUseIds.add(b.id);
      }
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        toolResultIds.add(b.tool_use_id);
      }
    }
  }

  // Find orphaned tool_use IDs (no matching tool_result)
  const orphanedUseIds = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUseIds.add(id);
  }

  // Find orphaned tool_result IDs (no matching tool_use)
  const orphanedResultIds = new Set<string>();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResultIds.add(id);
  }

  if (orphanedUseIds.size === 0 && orphanedResultIds.size === 0) return messages;

  if (orphanedUseIds.size > 0) {
    coworkLog('WARN', 'messageManager', `Found ${orphanedUseIds.size} orphaned tool_use blocks, inserting fixup tool_results`);
  }
  if (orphanedResultIds.size > 0) {
    coworkLog('WARN', 'messageManager', `Found ${orphanedResultIds.size} orphaned tool_result blocks, removing them`);
  }

  // Pass 2: build fixed message array
  const result: MessageParam[] = [];

  for (const msg of messages) {
    // Remove orphaned tool_result blocks from user messages
    if (orphanedResultIds.size > 0 && msg.role === 'user' && Array.isArray(msg.content)) {
      const filtered = (msg.content as any[]).filter((block: any) => {
        if (typeof block === 'string') return true;
        if (block.type === 'tool_result' && orphanedResultIds.has(block.tool_use_id)) return false;
        return true;
      });
      if (filtered.length === 0) continue; // skip entirely empty message
      result.push({ role: msg.role, content: filtered });
    } else {
      result.push(msg);
    }

    // After each assistant message, check if it has orphaned tool_use blocks
    if (orphanedUseIds.size > 0 && msg.role === 'assistant' && Array.isArray(msg.content)) {
      const orphansInThis: string[] = [];
      for (const block of msg.content) {
        if (typeof block === 'string') continue;
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.id === 'string' && orphanedUseIds.has(b.id)) {
          orphansInThis.push(b.id);
        }
      }
      if (orphansInThis.length > 0) {
        // Insert fixup user message right after this assistant message
        const fixupResults: ToolResultBlockParam[] = orphansInThis.map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: '[Tool execution was interrupted]',
          is_error: true,
        }));
        result.push({ role: 'user', content: fixupResults });
      }
    }
  }

  return result;
}

/**
 * Merge consecutive messages from the same role.
 * The API requires alternating user/assistant messages.
 * Reference: OpenClaw src/utils/messages.ts
 */
export function mergeConsecutiveMessages(messages: MessageParam[]): MessageParam[] {
  if (messages.length <= 1) return messages;

  const result: MessageParam[] = [];

  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (prev && prev.role === msg.role) {
      // Merge into previous message
      const prevContent = normalizeContent(prev.content);
      const currContent = normalizeContent(msg.content);
      prev.content = [...prevContent, ...currContent];
    } else {
      // Deep copy to avoid mutating originals
      result.push({
        role: msg.role,
        content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
      });
    }
  }

  return result;
}

function normalizeContent(content: MessageParam['content']): ContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content as ContentBlockParam[];
  }
  return [];
}

/**
 * Prepare messages for API call — full normalization pipeline.
 * Reference: OpenClaw src/utils/messages.ts normalizeMessagesForAPI()
 */
export function normalizeMessagesForAPI(messages: MessageParam[]): MessageParam[] {
  let result = [...messages];

  // 1. Ensure tool_use/tool_result pairing
  result = ensureToolResultPairing(result);

  // 2. Merge consecutive same-role messages
  result = mergeConsecutiveMessages(result);

  // 3. Ensure first message is from user (API requirement)
  if (result.length > 0 && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: '(continue)' });
  }

  return result;
}

// ── Content extraction helpers ──

/**
 * Extract tool_use blocks from an assistant message.
 */
export function extractToolUseBlocks(message: MessageParam): ToolUseBlock[] {
  if (typeof message.content === 'string') return [];
  if (!Array.isArray(message.content)) return [];

  return message.content.filter(
    (block: any): block is ToolUseBlock =>
      typeof block === 'object' && block !== null && block.type === 'tool_use'
  );
}

/**
 * Extract text content from an assistant message.
 */
export function extractTextContent(message: MessageParam): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';

  return message.content
    .filter((block: any): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && block.type === 'text'
    )
    .map((block: any) => block.text)
    .join('');
}

/**
 * Truncate text to max chars with a MIDDLE cut. Keeps the first ~half
 * and the last ~half of the budget and drops the middle, replacing it
 * with a `[N characters omitted]` marker. We prefer middle truncation
 * over tail truncation for tool results because:
 *
 *   - the HEAD of a file read / command output usually carries the
 *     filename, header lines, column definitions, or the command echo
 *     — useful anchors for the model
 *   - the TAIL usually carries the most recent progress, the final
 *     error message, or the success indicator — the part the model
 *     actually needs to decide "what next"
 *   - the middle is typically the noisy body (logs, repeated rows,
 *     long stack frames) that the model rarely references after the
 *     first turn
 *
 * Reference: Claude Code's messages.ts truncates tool results with a
 * similar head+tail strategy.
 */
export function truncateText(text: string, maxChars?: number): string {
  const limit = maxChars ?? getToolResultMaxChars();
  if (text.length <= limit) return text;

  // Roughly split the budget evenly between head and tail. Reserve a
  // little room for the truncation marker itself.
  const marker = '\n\n[... {N} characters omitted from the middle ...]\n\n';
  const budget = Math.max(limit - marker.length, 256);
  const headBudget = Math.floor(budget / 2);
  const tailBudget = budget - headBudget;

  // Try to snap head cut to a newline so we don't slice mid-token.
  let headCut = headBudget;
  const lastHeadNewline = text.lastIndexOf('\n', headBudget);
  if (lastHeadNewline > headBudget * 0.8) {
    headCut = lastHeadNewline;
  }

  // Try to snap tail start to a newline going forward.
  const tailStartIdx = text.length - tailBudget;
  let tailStart = tailStartIdx;
  const firstTailNewline = text.indexOf('\n', tailStartIdx);
  if (firstTailNewline >= 0 && firstTailNewline < tailStartIdx + tailBudget * 0.2) {
    tailStart = firstTailNewline + 1;
  }

  const head = text.slice(0, headCut);
  const tail = text.slice(tailStart);
  const omitted = text.length - head.length - tail.length;
  if (omitted <= 0) return text; // safety: nothing to cut
  return head + marker.replace('{N}', String(omitted)) + tail;
}
