/**
 * Context Engine — manages token budget allocation and tool deferred loading.
 * Prevents 85+ tool descriptions from overwhelming the context window.
 *
 * Reference: OpenClaw src/context-engine/ (registry.ts, types.ts, delegate.ts)
 *
 * Token budget allocation:
 *   System prompt: 15% | Tools: 25% | Messages: 50% | Output: 10%
 *
 * Tool deferred loading (when total tools > DEFER_THRESHOLD):
 *   - Top-N frequently used tools: full description
 *   - Other tools: name + one-line summary only
 *   - tool_search tool: lets model request full description on demand
 */

import { coworkLog } from './coworkLogger';
import type { ToolDefinition } from './toolSystem';
import type { Tool as AnthropicTool } from './anthropicClient';
import { toolToApiSchema } from './toolSystem';

// ── Configuration ──

export interface ContextBudget {
  totalTokens: number;
  systemPromptTokens: number;
  toolDescriptionTokens: number;
  messageTokens: number;
  outputTokens: number;
}

export interface ContextEngineConfig {
  contextWindowSize: number;      // Model context window (default: 200K)
  systemPromptRatio: number;      // Default: 0.15
  toolDescriptionRatio: number;   // Default: 0.25
  messageRatio: number;           // Default: 0.50
  outputRatio: number;            // Default: 0.10
  deferThreshold: number;         // Tools > this count triggers deferred loading (default: 30)
  topToolCount: number;           // Number of tools to load fully (default: 20)
  maxToolDescriptionChars: number;// Truncate individual tool descriptions (default: 2048)
  lastUserMessage?: string;       // Used for intent-based tool selection
}

const DEFAULT_CONFIG: ContextEngineConfig = {
  contextWindowSize: 200_000,
  systemPromptRatio: 0.15,
  toolDescriptionRatio: 0.25,
  messageRatio: 0.50,
  outputRatio: 0.10,
  deferThreshold: 30,
  topToolCount: 25,  // Raised to ensure desktop/browser tools always available
  maxToolDescriptionChars: 2048,
  lastUserMessage: '',
};

// ── State ──

let config = { ...DEFAULT_CONFIG };
const toolUsageCount = new Map<string, number>(); // Track how often each tool is used

// ── Configure ──

export function configureContextEngine(custom?: Partial<ContextEngineConfig>): void {
  if (custom) config = { ...config, ...custom };
  coworkLog('INFO', 'contextEngine', `Configured: window=${config.contextWindowSize}, deferThreshold=${config.deferThreshold}`);
}

// ── Token Budget Computation ──

export function computeBudget(contextWindowOverride?: number): ContextBudget {
  const total = contextWindowOverride ?? config.contextWindowSize;
  return {
    totalTokens: total,
    systemPromptTokens: Math.floor(total * config.systemPromptRatio),
    toolDescriptionTokens: Math.floor(total * config.toolDescriptionRatio),
    messageTokens: Math.floor(total * config.messageRatio),
    outputTokens: Math.floor(total * config.outputRatio),
  };
}

/**
 * Estimate token count from text (rough: ~4 chars/token for English, ~2 for CJK).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u3040-\u30ff]/g) || []).length;
  const nonCjk = text.length - cjkCount;
  return Math.ceil(nonCjk / 4 + cjkCount / 1.5);
}

// ── Tool Deferred Loading ──

export interface DeferredToolSet {
  /** Tools with full descriptions (top-N + always-load) */
  fullTools: AnthropicTool[];
  /** Tools with truncated descriptions (name + one-liner) */
  deferredTools: AnthropicTool[];
  /** All tools combined (full + deferred) for API */
  allApiTools: AnthropicTool[];
  /** Original tool definitions (for tool_search lookups) */
  originalTools: ToolDefinition[];
  /** Whether deferred loading was applied */
  isDeferred: boolean;
  /** Token estimate for tool descriptions */
  estimatedToolTokens: number;
}

/**
 * Build the tool set with optional deferred loading.
 * When tools > deferThreshold, only top-N tools get full descriptions.
 */
export function buildDeferredToolSet(tools: ToolDefinition[]): DeferredToolSet {
  const budget = computeBudget();

  if (tools.length <= config.deferThreshold) {
    // Under threshold — load all tools fully
    const apiTools = tools.map(t => {
      const schema = toolToApiSchema(t);
      schema.description = truncateDescription(schema.description || '', config.maxToolDescriptionChars);
      return schema;
    });

    const tokenEstimate = apiTools.reduce((sum, t) =>
      sum + estimateTokens(t.name) + estimateTokens(t.description || '') + estimateTokens(JSON.stringify(t.input_schema)), 0);

    return {
      fullTools: apiTools,
      deferredTools: [],
      allApiTools: apiTools,
      originalTools: tools,
      isDeferred: false,
      estimatedToolTokens: tokenEstimate,
    };
  }

  // Send ALL tools to the API — no filtering, no deferral.
  // Let the LLM decide which tools to use based on its own judgment.
  // This matches OpenClaw/Claude Code's approach of trusting the model.
  const allApiTools = tools.map(t => {
    const schema = toolToApiSchema(t);
    schema.description = truncateDescription(schema.description || '', config.maxToolDescriptionChars);
    return schema;
  });

  const tokenEstimate = allApiTools.reduce((sum, t) =>
    sum + estimateTokens(t.name) + estimateTokens(t.description || '') + estimateTokens(JSON.stringify(t.input_schema)), 0);

  coworkLog('INFO', 'contextEngine', `Tool set: ALL ${allApiTools.length} tools sent to API (~${tokenEstimate} tokens)`);

  return {
    fullTools: allApiTools,
    deferredTools: [],
    allApiTools,
    originalTools: tools,
    isDeferred: false,
    estimatedToolTokens: tokenEstimate,
  };
}

// ── Tool Usage Tracking ──

export function recordToolUsage(toolName: string): void {
  toolUsageCount.set(toolName, (toolUsageCount.get(toolName) ?? 0) + 1);
}

export function getToolUsageStats(): Map<string, number> {
  return new Map(toolUsageCount);
}

// ── Tool Search (used by contextTools.ts) ──

/**
 * Search for tools by keyword and return full descriptions.
 * Used when deferred loading is active and model needs a tool's full schema.
 */
export function searchTools(query: string, tools: ToolDefinition[], maxResults: number = 5): Array<{
  name: string; description: string; inputSchema: Record<string, unknown>;
}> {
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);

  const scored = tools.map(tool => {
    const name = tool.name.toLowerCase();
    const desc = tool.description.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (name.includes(kw)) score += 3;
      if (desc.includes(kw)) score += 1;
    }
    return { tool, score };
  }).filter(s => s.score > 0);

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map(s => {
    const schema = toolToApiSchema(s.tool);
    return {
      name: schema.name,
      description: schema.description || '',
      inputSchema: schema.input_schema as Record<string, unknown>,
    };
  });
}

// ── Intent-based tool selection ──

/**
 * Detect which tool categories are relevant based on user message.
 * Returns tool names to add to the always-load set.
 * This dramatically reduces token usage: only send tools the user needs.
 */
function detectIntentTools(message: string): string[] {
  if (!message) return [];
  const lower = message.toLowerCase();
  const tools: string[] = [];

  // Browser intent — match URLs, website names, browsing actions
  if (/browser|网页|打开.*网|browse|url|website|chrome|safari|edge|navigate|小红书|抖音|bilibili|youtube|twitter|github|百度|谷歌|google|bing|搜一下|看看.*网/i.test(lower)) {
    tools.push('browser_navigate', 'browser_screenshot', 'browser_observe', 'browser_click', 'browser_type', 'browser_get_text', 'browser_read_page');
  }

  // Desktop control intent — match app names, desktop actions, media playback
  if (/desktop|桌面|屏幕|screenshot|截图|点击|click|打开|启动|运行|open|launch|start|鼠标|mouse|应用|app|微信|wechat|qq|钉钉|飞书|spotify|播放|play|音乐|music|视频|video|word|excel|ppt|vscode|terminal|终端|文件管理|finder|资源管理器|explorer/i.test(lower)) {
    tools.push('desktop_screenshot', 'desktop_click', 'desktop_type', 'desktop_open_app', 'desktop_key', 'desktop_mouse_move');
  }

  // Memory intent
  if (/remember|记住|recall|记忆|memory|之前|以前|上次|你还记得|你知道我/i.test(lower)) {
    tools.push('memory_recall', 'memory_store', 'memory_search');
  }

  // Sub-agent intent
  if (/parallel|并行|agent|delegate|拆分|分配|子任务|同时.*做|一起.*做/i.test(lower)) {
    tools.push('spawn_subagent', 'delegate_to_agent', 'get_task_result');
  }

  // Process intent
  if (/server|dev.*server|start.*server|npm|node|process|后台|进程|运行.*服务|启动.*服务/i.test(lower)) {
    tools.push('process_spawn', 'process_list', 'process_poll', 'process_kill');
  }

  // Search intent
  if (/search|搜索|google|find.*online|查找|web|查一下|搜一下|帮我.*找/i.test(lower)) {
    tools.push('web_search', 'web_fetch');
  }

  // Canvas intent
  if (/canvas|画布|html|render|interactive|表单|form|界面|ui|页面/i.test(lower)) {
    tools.push('canvas_render', 'canvas_read_action');
  }

  // Voice intent
  if (/voice|语音|speak|说|listen|听|tts|stt|朗读|读出来/i.test(lower)) {
    tools.push('voice_listen', 'voice_speak');
  }

  // Gmail intent
  if (/email|邮件|gmail|mail|发.*邮件|收.*邮件/i.test(lower)) {
    tools.push('gmail_search', 'gmail_send', 'gmail_status');
  }

  // Media intent
  if (/图片|image|photo|照片|视频|video|音频|audio|转换|convert|下载.*视频|下载.*音乐|生成.*图/i.test(lower)) {
    tools.push('describe_image', 'transcribe_audio', 'convert_media', 'download_media', 'generate_media');
  }

  return tools;
}

/**
 * Set the user message for intent detection before building tool set.
 */
export function setLastUserMessage(message: string): void {
  config.lastUserMessage = message;
}

// ── Context Pressure Monitoring ──

export interface ContextPressure {
  estimatedTokens: number;
  budgetTokens: number;
  usagePercent: number;
  isOverBudget: boolean;
}

export function checkContextPressure(
  systemPromptChars: number,
  toolDescriptionTokens: number,
  messageChars: number,
): ContextPressure {
  const budget = computeBudget();
  const estimated = estimateTokens(' '.repeat(systemPromptChars)) + toolDescriptionTokens + estimateTokens(' '.repeat(messageChars));
  const budgetTokens = budget.systemPromptTokens + budget.toolDescriptionTokens + budget.messageTokens;

  return {
    estimatedTokens: estimated,
    budgetTokens,
    usagePercent: Math.round((estimated / budgetTokens) * 100),
    isOverBudget: estimated > budgetTokens,
  };
}

// ── Helpers ──

function truncateDescription(desc: string, maxChars: number): string {
  if (desc.length <= maxChars) return desc;
  return desc.slice(0, maxChars - 50) + '\n\n[Description truncated. Use tool_search for full details.]';
}

function getOneLiner(desc: string): string {
  // Extract first sentence or first line
  const firstLine = desc.split('\n')[0].trim();
  const firstSentence = firstLine.split(/\.\s/)[0];
  return firstSentence.slice(0, 120);
}
