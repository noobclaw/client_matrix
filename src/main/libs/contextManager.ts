/**
 * Context Manager — unified context window optimization.
 * Controls: history compression, SKILL selection, token budgeting.
 *
 * Reference: Claude Code's multi-layer compaction system
 *
 * Strategy:
 * - Recent 3 turns: keep complete
 * - Older turns: strip tool results, keep only assistant text
 * - Very old turns: compress to summary
 * - SKILLs: only inject relevant ones based on message intent
 */

import { coworkLog } from './coworkLogger';

// ── Constants ──

/** Max recent turns to keep complete (with tool calls/results) */
const KEEP_RECENT_TURNS = 3;

/** Max chars for older messages (assistant text only, no tool details) */
const OLDER_MESSAGE_MAX_CHARS = 500;

/** Max total chars for injected history */
const HISTORY_MAX_CHARS = 8000;

/** Max messages in history injection */
const HISTORY_MAX_MESSAGES = 12;

/** Max chars per individual message */
const MESSAGE_MAX_CHARS = 2000;

// ── History Compression ──

export interface CompressedHistory {
  blocks: string[];
  totalChars: number;
  originalCount: number;
  keptComplete: number;
  compressed: number;
  dropped: number;
}

/**
 * Compress conversation history for context injection.
 * Recent turns kept complete, older ones stripped, very old ones dropped.
 */
export function compressHistory(
  messages: Array<{ type: string; content: string; metadata?: Record<string, unknown> }>,
  currentPrompt: string
): CompressedHistory {
  const result: CompressedHistory = {
    blocks: [],
    totalChars: 0,
    originalCount: messages.length,
    keptComplete: 0,
    compressed: 0,
    dropped: 0,
  };

  if (messages.length === 0) return result;

  // Identify turns (a turn = user message + assistant response + tool calls)
  const turns = groupIntoTurns(messages);

  // Process from newest to oldest
  const reversed = [...turns].reverse();
  const blocks: string[] = [];
  let totalChars = 0;

  for (let i = 0; i < reversed.length; i++) {
    const turn = reversed[i];

    if (totalChars >= HISTORY_MAX_CHARS) {
      result.dropped += turn.length;
      continue;
    }

    if (i < KEEP_RECENT_TURNS) {
      // Recent: keep complete but truncate individual messages
      for (const msg of turn) {
        const block = formatMessage(msg, MESSAGE_MAX_CHARS);
        if (totalChars + block.length <= HISTORY_MAX_CHARS) {
          blocks.unshift(block);
          totalChars += block.length;
          result.keptComplete++;
        }
      }
    } else {
      // Older: only keep assistant text, strip tool calls/results
      const assistantMsgs = turn.filter(m => m.type === 'assistant');
      for (const msg of assistantMsgs) {
        const compressed = compressMessage(msg, OLDER_MESSAGE_MAX_CHARS);
        if (compressed && totalChars + compressed.length <= HISTORY_MAX_CHARS) {
          blocks.unshift(compressed);
          totalChars += compressed.length;
          result.compressed++;
        }
      }
      result.dropped += turn.length - assistantMsgs.length;
    }
  }

  result.blocks = blocks.slice(0, HISTORY_MAX_MESSAGES);
  result.totalChars = totalChars;

  coworkLog('INFO', 'contextManager', `History: ${result.originalCount} msgs → ${result.blocks.length} blocks (${result.keptComplete} complete, ${result.compressed} compressed, ${result.dropped} dropped, ${totalChars} chars)`);

  return result;
}

function groupIntoTurns(messages: Array<{ type: string; content: string; metadata?: Record<string, unknown> }>): Array<Array<{ type: string; content: string; metadata?: Record<string, unknown> }>> {
  const turns: Array<Array<typeof messages[0]>> = [];
  let currentTurn: Array<typeof messages[0]> = [];

  for (const msg of messages) {
    if (msg.type === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(msg);
  }
  if (currentTurn.length > 0) turns.push(currentTurn);
  return turns;
}

function formatMessage(msg: { type: string; content: string; metadata?: Record<string, unknown> }, maxChars: number): string {
  const role = msg.type === 'user' ? 'User' : msg.type === 'assistant' ? 'Assistant' : msg.type;
  let content = msg.content || '';

  // Strip tool result details (keep just the tool name)
  if (msg.type === 'tool_use') {
    const toolName = (msg.metadata?.toolName as string) || 'tool';
    content = `[Used tool: ${toolName}]`;
  } else if (msg.type === 'tool_result') {
    const toolName = (msg.metadata?.toolName as string) || '';
    const isError = msg.metadata?.isError;
    content = isError ? `[Tool error: ${toolName}]` : `[Tool result: ${toolName} — ${content.slice(0, 100)}...]`;
  }

  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + '...[truncated]';
  }

  return `[${role}] ${content}`;
}

function compressMessage(msg: { type: string; content: string }, maxChars: number): string | null {
  if (!msg.content?.trim()) return null;
  const content = msg.content.length > maxChars
    ? msg.content.slice(0, maxChars) + '...[truncated]'
    : msg.content;
  return `[Assistant] ${content}`;
}

// ── SKILL Intent Detection + Selection ──

const SKILL_INTENTS: Record<string, string[]> = {
  // Keywords → skill IDs to load
  'web|search|google|browse|url|网页|搜索|浏览': ['web-search', 'playwright'],
  'doc|word|docx|文档|报告': ['docx'],
  'excel|xlsx|spreadsheet|表格': ['xlsx'],
  'ppt|slide|presentation|幻灯片|演示': ['pptx'],
  'pdf': ['pdf'],
  'email|邮件|imap|smtp': ['imap-smtp-email'],
  'design|设计|canvas|画布|ui|界面': ['canvas-design', 'frontend-design'],
  'image|图片|edit|编辑': ['image-editor'],
  'game|游戏': ['develop-web-game'],
  'video|视频|seedance': ['seedance', 'remotion'],
  'music|音乐': ['music-search'],
  'weather|天气': ['weather'],
  'movie|film|电影': ['films-search'],
  'translate|翻译': ['translator'],
  'schedule|定时|cron|计划': ['scheduled-task'],
  'desktop|桌面|屏幕|控制': ['desktop-control'],
  'cursor|vscode|编辑器': ['cursor-control'],
  'monitor|系统|cpu|内存': ['system-monitor'],
  'clipboard|剪贴板': ['clipboard-manager'],
  'file|文件|管理': ['file-manager'],
  'news|新闻|技术': ['technology-news-search'],
  'plan|计划|规划': ['create-plan'],
  'skill|技能|创建': ['skill-creator'],
};

/**
 * Select relevant SKILLs based on user message.
 * Returns skill IDs that should be loaded.
 * Only loads 0-3 SKILLs per message instead of all 28.
 */
export function selectRelevantSkills(message: string, maxSkills: number = 3): string[] {
  if (!message) return [];
  const lower = message.toLowerCase();
  const matched = new Set<string>();

  for (const [pattern, skillIds] of Object.entries(SKILL_INTENTS)) {
    const regex = new RegExp(`\\b(${pattern})\\b`, 'i');
    if (regex.test(lower)) {
      for (const id of skillIds) {
        matched.add(id);
      }
    }
  }

  const result = Array.from(matched).slice(0, maxSkills);

  if (result.length > 0) {
    coworkLog('INFO', 'contextManager', `Selected ${result.length} SKILLs: ${result.join(', ')}`);
  }

  return result;
}

// ── Optimized History Constants Export ──

/** Export optimized constants for coworkRunner to use instead of old ones */
export const OPTIMIZED_HISTORY = {
  maxMessages: HISTORY_MAX_MESSAGES,
  maxTotalChars: HISTORY_MAX_CHARS,
  maxMessageChars: MESSAGE_MAX_CHARS,
};
