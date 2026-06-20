/**
 * Message Hooks — lifecycle hooks for IM messages.
 * Connects to the existing hookSystem to trigger agent sessions
 * when messages are received from IM channels.
 *
 * Ported from OpenClaw src/hooks/message-hooks.ts
 */

import { registerHook, emitHookEvent, type HookEvent, type HookCallback } from './hookSystem';
import { coworkLog } from './coworkLogger';

// ── Message event types ──

export interface MessageReceivedEvent {
  sender: string;
  senderName?: string;
  content: string;
  channel: string;          // 'telegram', 'discord', 'dingtalk', etc.
  chatId: string;
  isGroup: boolean;
  mediaType?: string;       // 'text', 'image', 'audio', 'file'
  mediaUrl?: string;
  timestamp: number;
}

export interface MessageSentEvent {
  recipient: string;
  content: string;
  channel: string;
  chatId: string;
  success: boolean;
  timestamp: number;
}

export interface MessageTranscribedEvent {
  originalMediaUrl: string;
  transcript: string;
  language?: string;
  channel: string;
  chatId: string;
  timestamp: number;
}

// ── Convenience emitters ──

export function emitMessageReceived(event: MessageReceivedEvent): void {
  emitHookEvent({
    type: 'message:received',
    timestamp: event.timestamp || Date.now(),
    data: event as unknown as Record<string, unknown>,
  }).catch(() => {});
}

export function emitMessageSent(event: MessageSentEvent): void {
  emitHookEvent({
    type: 'message:sent',
    timestamp: event.timestamp || Date.now(),
    data: event as unknown as Record<string, unknown>,
  }).catch(() => {});
}

// ── Hook registration helpers ──

/**
 * Register a handler that fires when any IM message is received.
 * The handler can decide whether to start a new agent session based on
 * sender, content, channel, etc.
 */
export function onMessageReceived(id: string, handler: (event: MessageReceivedEvent) => void | Promise<void>): void {
  registerHook('message:received', id, (hookEvent: HookEvent) => {
    return handler(hookEvent.data as unknown as MessageReceivedEvent);
  });
}

/**
 * Register a handler that fires when a message is successfully sent.
 */
export function onMessageSent(id: string, handler: (event: MessageSentEvent) => void | Promise<void>): void {
  registerHook('message:sent', id, (hookEvent: HookEvent) => {
    return handler(hookEvent.data as unknown as MessageSentEvent);
  });
}

/**
 * Auto-reply hook: when a message matching a pattern is received,
 * automatically start an agent session with the message as prompt.
 */
export function registerAutoReplyHook(
  id: string,
  config: {
    channels?: string[];        // filter by channel, empty = all
    senderPattern?: RegExp;     // filter by sender
    contentPattern?: RegExp;    // filter by content
    promptTemplate: string;     // template: {{sender}}, {{content}}, {{channel}}
  },
  startSession: (prompt: string, channel: string, chatId: string) => void
): void {
  onMessageReceived(`auto-reply-${id}`, (event) => {
    // Channel filter
    if (config.channels && config.channels.length > 0 && !config.channels.includes(event.channel)) return;
    // Sender filter
    if (config.senderPattern && !config.senderPattern.test(event.sender)) return;
    // Content filter
    if (config.contentPattern && !config.contentPattern.test(event.content)) return;

    // Build prompt from template
    const prompt = config.promptTemplate
      .replace(/\{\{sender\}\}/g, event.sender)
      .replace(/\{\{senderName\}\}/g, event.senderName || event.sender)
      .replace(/\{\{content\}\}/g, event.content)
      .replace(/\{\{channel\}\}/g, event.channel)
      .replace(/\{\{chatId\}\}/g, event.chatId);

    coworkLog('INFO', 'messageHooks', `Auto-reply triggered: ${event.channel}/${event.chatId} from ${event.sender}`);
    startSession(prompt, event.channel, event.chatId);
  });
}
