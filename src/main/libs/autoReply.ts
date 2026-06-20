/**
 * Auto Reply — rule-based automatic responses to IM messages.
 * When a message matches configured rules, automatically starts
 * an agent session with a templated prompt.
 *
 * Reference: OpenClaw src/auto-reply/ (5 files)
 */

import { coworkLog } from './coworkLogger';
import { onMessageReceived, type MessageReceivedEvent } from './messageHooks';

// ── Types ──

export interface AutoReplyRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;            // Lower = higher priority

  // Matching conditions (all must match)
  channels?: string[];         // Filter by channel name, empty = all
  senderPattern?: string;      // Regex pattern for sender
  contentPattern?: string;     // Regex pattern for content
  isGroupOnly?: boolean;       // Only match group messages
  isDMOnly?: boolean;          // Only match DMs

  // Action
  promptTemplate: string;      // Supports: {{sender}}, {{senderName}}, {{content}}, {{channel}}, {{chatId}}
  model?: string;              // Model override for this rule
  maxTurns?: number;           // Max turns for auto-reply session
  cooldownMs?: number;         // Min time between triggers for same sender (default: 60s)
}

// ── State ──

const rules: AutoReplyRule[] = [];
const cooldowns = new Map<string, number>(); // "ruleId:sender" → last trigger time
let sessionStarter: ((prompt: string, channel: string, chatId: string, model?: string) => void) | null = null;
let registered = false;

// ── Configuration ──

export function setAutoReplyRules(newRules: AutoReplyRule[]): void {
  rules.length = 0;
  rules.push(...newRules.sort((a, b) => a.priority - b.priority));
  coworkLog('INFO', 'autoReply', `Loaded ${rules.length} auto-reply rules`);
}

export function addAutoReplyRule(rule: AutoReplyRule): void {
  rules.push(rule);
  rules.sort((a, b) => a.priority - b.priority);
}

export function removeAutoReplyRule(id: string): boolean {
  const idx = rules.findIndex(r => r.id === id);
  if (idx < 0) return false;
  rules.splice(idx, 1);
  return true;
}

export function getAutoReplyRules(): AutoReplyRule[] {
  return [...rules];
}

// ── Initialize ──

export function initAutoReply(
  startSession: (prompt: string, channel: string, chatId: string, model?: string) => void
): void {
  sessionStarter = startSession;

  if (!registered) {
    registered = true;
    onMessageReceived('auto-reply-engine', handleMessage);
    coworkLog('INFO', 'autoReply', 'Auto-reply engine initialized');
  }
}

// ── Message handler ──

function handleMessage(event: MessageReceivedEvent): void {
  if (!sessionStarter || rules.length === 0) return;

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchesRule(rule, event)) continue;

    // Cooldown check
    const cooldownKey = `${rule.id}:${event.sender}`;
    const lastTrigger = cooldowns.get(cooldownKey) || 0;
    const cooldown = rule.cooldownMs ?? 60_000;
    if (Date.now() - lastTrigger < cooldown) continue;

    // Match! Build prompt and start session
    const prompt = buildPrompt(rule.promptTemplate, event);
    cooldowns.set(cooldownKey, Date.now());

    coworkLog('INFO', 'autoReply', `Rule "${rule.name}" matched: ${event.channel}/${event.sender}`, {
      content: event.content.slice(0, 100),
    });

    sessionStarter(prompt, event.channel, event.chatId, rule.model);
    return; // First matching rule wins
  }
}

// ── Rule matching ──

function matchesRule(rule: AutoReplyRule, event: MessageReceivedEvent): boolean {
  // Channel filter
  if (rule.channels && rule.channels.length > 0) {
    if (!rule.channels.includes(event.channel)) return false;
  }

  // Group/DM filter
  if (rule.isGroupOnly && !event.isGroup) return false;
  if (rule.isDMOnly && event.isGroup) return false;

  // Sender pattern
  if (rule.senderPattern) {
    try {
      if (!new RegExp(rule.senderPattern, 'i').test(event.sender)) return false;
    } catch { return false; }
  }

  // Content pattern
  if (rule.contentPattern) {
    try {
      if (!new RegExp(rule.contentPattern, 'i').test(event.content)) return false;
    } catch { return false; }
  }

  return true;
}

// ── Prompt building ──

function buildPrompt(template: string, event: MessageReceivedEvent): string {
  return template
    .replace(/\{\{sender\}\}/g, event.sender)
    .replace(/\{\{senderName\}\}/g, event.senderName || event.sender)
    .replace(/\{\{content\}\}/g, event.content)
    .replace(/\{\{channel\}\}/g, event.channel)
    .replace(/\{\{chatId\}\}/g, event.chatId)
    .replace(/\{\{isGroup\}\}/g, String(event.isGroup))
    .replace(/\{\{timestamp\}\}/g, new Date(event.timestamp).toISOString());
}

// ── Cleanup ──

export function clearCooldowns(): void {
  cooldowns.clear();
}
