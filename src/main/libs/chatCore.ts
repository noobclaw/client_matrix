/**
 * Chat Core — message formatting, session management, typing indicators.
 * Centralizes chat logic that was previously scattered across coworkRunner.
 *
 * Reference: OpenClaw src/chat/ (10 files)
 */

import { coworkLog } from './coworkLogger';

// ── Message formatting ──

export interface FormattedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  metadata?: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    isThinking?: boolean;
    isStreaming?: boolean;
    isError?: boolean;
    images?: string[];      // Base64 or file paths
    attachments?: string[]; // File paths
  };
}

/**
 * Format raw store messages into display-ready format.
 * Handles markdown, code blocks, tool results, thinking blocks.
 */
export function formatMessageForDisplay(raw: {
  id: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}): FormattedMessage {
  const roleMap: Record<string, FormattedMessage['role']> = {
    user: 'user',
    assistant: 'assistant',
    system: 'system',
    tool_use: 'tool',
    tool_result: 'tool',
  };

  return {
    id: raw.id,
    role: roleMap[raw.type] || 'system',
    content: raw.content || '',
    timestamp: raw.timestamp || Date.now(),
    metadata: raw.metadata ? {
      toolName: raw.metadata.toolName as string | undefined,
      toolInput: raw.metadata.toolInput as Record<string, unknown> | undefined,
      isThinking: raw.metadata.isThinking as boolean | undefined,
      isStreaming: raw.metadata.isStreaming as boolean | undefined,
      isError: raw.metadata.isError as boolean | undefined,
    } : undefined,
  };
}

// ── Session context builder ──

/**
 * Build conversation context from stored messages for API calls.
 * Handles role alternation, tool result pairing, thinking block preservation.
 */
export function buildConversationContext(
  messages: FormattedMessage[],
  maxMessages?: number,
  maxChars?: number
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let totalChars = 0;
  const limit = maxChars ?? 100_000;

  // Process in reverse (newest first) then reverse back
  const recent = maxMessages ? messages.slice(-maxMessages) : messages;

  for (const msg of recent) {
    if (totalChars > limit) break;

    const role = msg.role === 'user' ? 'user' : 'assistant';
    const content = msg.content;

    if (!content.trim()) continue;

    // Merge consecutive same-role messages
    const prev = result[result.length - 1];
    if (prev && prev.role === role) {
      prev.content += '\n\n' + content;
    } else {
      result.push({ role, content });
    }

    totalChars += content.length;
  }

  // Ensure first message is from user
  if (result.length > 0 && result[0].role !== 'user') {
    result.unshift({ role: 'user', content: '(continue)' });
  }

  return result;
}

// ── Typing indicators ──

const typingState = new Map<string, {
  isTyping: boolean;
  startedAt: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
}>();

export function setTyping(channelKey: string, isTyping: boolean, autoStopMs: number = 30000): void {
  const existing = typingState.get(channelKey);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);

  if (isTyping) {
    typingState.set(channelKey, {
      isTyping: true,
      startedAt: Date.now(),
      timeoutId: setTimeout(() => setTyping(channelKey, false), autoStopMs),
    });
  } else {
    typingState.delete(channelKey);
  }
}

export function isTyping(channelKey: string): boolean {
  return typingState.get(channelKey)?.isTyping ?? false;
}

// ── Message chunking (for IM platforms with length limits) ──

export function chunkMessage(text: string, maxLength: number = 4096): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx < maxLength * 0.3) {
      // No good paragraph break, try line break
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIdx < maxLength * 0.3) {
      // No good line break, try sentence
      splitIdx = remaining.lastIndexOf('. ', maxLength);
      if (splitIdx > 0) splitIdx += 1; // Include the period
    }
    if (splitIdx < maxLength * 0.3) {
      // No good split point, hard break at word boundary
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < 1) {
      // Worst case: hard break
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ── Mention detection ──

export function extractMentions(text: string): string[] {
  const mentions = text.match(/@(\w+)/g);
  return mentions ? mentions.map(m => m.slice(1)) : [];
}

export function isMentioned(text: string, name: string): boolean {
  return text.toLowerCase().includes(`@${name.toLowerCase()}`);
}

// ── Message sanitization ──

export function sanitizeMessageContent(content: string): string {
  // Remove null bytes
  let cleaned = content.replace(/\0/g, '');
  // Limit length
  if (cleaned.length > 100_000) {
    cleaned = cleaned.slice(0, 100_000) + '\n\n[Content truncated]';
  }
  return cleaned;
}
