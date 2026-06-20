/**
 * Collapse Results — compresses repetitive tool results in conversation display.
 * Multiple consecutive searches/reads collapse into summary lines.
 *
 * Reference: Claude Code src/utils/collapseReadSearch.ts
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export type CollapseCategory = 'search' | 'read' | 'meta' | 'none';

export interface CollapsedGroup {
  category: CollapseCategory;
  toolNames: string[];
  count: number;
  summary: string;          // "3 file reads, 2 searches"
  startIndex: number;
  endIndex: number;
}

// ── Tool classification ──

const SEARCH_TOOLS = new Set([
  'Grep', 'Glob', 'web_search', 'memory_recall', 'memory_search',
  'browser_find', 'lsp_references', 'lsp_symbols',
]);

const READ_TOOLS = new Set([
  'Read', 'browser_get_text', 'browser_read_page', 'web_fetch',
  'lsp_hover', 'lsp_definition', 'process_poll',
]);

const META_TOOLS = new Set([
  'tool_search', 'memory_dreaming_status', 'gmail_status',
  'process_list', 'list_tasks', 'list_agents', 'webhook_list',
  'canvas_list', 'browser_get_url', 'browser_page_info',
]);

/**
 * Classify a tool into a collapse category.
 */
export function classifyToolForCollapse(toolName: string): CollapseCategory {
  if (SEARCH_TOOLS.has(toolName)) return 'search';
  if (READ_TOOLS.has(toolName)) return 'read';
  if (META_TOOLS.has(toolName)) return 'meta';
  return 'none';
}

// ── Collapse algorithm ──

/**
 * Scan a message list and identify groups of consecutive collapsible tool calls.
 * Returns groups that can be visually collapsed in the UI.
 */
export function findCollapsibleGroups(messages: Array<{
  type: string;
  metadata?: { toolName?: string };
}>): CollapsedGroup[] {
  const groups: CollapsedGroup[] = [];
  let currentGroup: CollapsedGroup | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type !== 'tool_use' && msg.type !== 'tool_result') {
      // Non-tool message breaks the group
      if (currentGroup && currentGroup.count >= 2) {
        groups.push(currentGroup);
      }
      currentGroup = null;
      continue;
    }

    const toolName = msg.metadata?.toolName || '';
    const category = classifyToolForCollapse(toolName);

    if (category === 'none') {
      // Non-collapsible tool breaks the group
      if (currentGroup && currentGroup.count >= 2) {
        groups.push(currentGroup);
      }
      currentGroup = null;
      continue;
    }

    if (currentGroup && currentGroup.category === category) {
      // Extend current group
      currentGroup.count++;
      currentGroup.endIndex = i;
      if (!currentGroup.toolNames.includes(toolName)) {
        currentGroup.toolNames.push(toolName);
      }
    } else {
      // Start new group (save old one if it had 2+ items)
      if (currentGroup && currentGroup.count >= 2) {
        groups.push(currentGroup);
      }
      currentGroup = {
        category,
        toolNames: [toolName],
        count: 1,
        summary: '',
        startIndex: i,
        endIndex: i,
      };
    }
  }

  // Don't forget the last group
  if (currentGroup && currentGroup.count >= 2) {
    groups.push(currentGroup);
  }

  // Generate summaries
  for (const group of groups) {
    group.summary = formatGroupSummary(group);
  }

  return groups;
}

function formatGroupSummary(group: CollapsedGroup): string {
  const icon = { search: '🔍', read: '📖', meta: 'ℹ️', none: '' }[group.category];
  const toolList = group.toolNames.join(', ');

  if (group.count <= 3) {
    return `${icon} ${group.count} ${group.category} operations (${toolList})`;
  }
  return `${icon} ${group.count} ${group.category} operations`;
}

/**
 * Check if a message index falls within any collapsed group.
 * Returns the group if collapsed, null if visible.
 */
export function isMessageCollapsed(
  messageIndex: number,
  groups: CollapsedGroup[]
): CollapsedGroup | null {
  for (const group of groups) {
    // Show first message of group, collapse the rest
    if (messageIndex > group.startIndex && messageIndex <= group.endIndex) {
      return group;
    }
  }
  return null;
}

/**
 * Get the summary message to display at the start of a collapsed group.
 */
export function getCollapseSummary(
  messageIndex: number,
  groups: CollapsedGroup[]
): string | null {
  for (const group of groups) {
    if (messageIndex === group.startIndex) {
      return group.summary;
    }
  }
  return null;
}
