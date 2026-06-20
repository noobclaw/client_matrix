/**
 * Diff Utils — generate and format file diffs for display.
 * Shows what changed with context lines for user review.
 *
 * Reference: Claude Code src/utils/diff.ts
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface DiffResult {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  hasChanges: boolean;
}

// ── Generate diff ──

/**
 * Generate a unified diff between two strings.
 * Returns structured hunks with context lines.
 */
export function generateDiff(
  oldText: string,
  newText: string,
  contextLines: number = 3
): DiffResult {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Simple LCS-based diff
  const changes = computeChanges(oldLines, newLines);

  if (changes.length === 0) {
    return { hunks: [], additions: 0, deletions: 0, hasChanges: false };
  }

  // Group changes into hunks with context
  const hunks = buildHunks(oldLines, newLines, changes, contextLines);

  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') additions++;
      if (line.type === 'remove') deletions++;
    }
  }

  return { hunks, additions, deletions, hasChanges: true };
}

// ── Format for display ──

/**
 * Format diff as a human-readable string (unified diff format).
 */
export function formatDiff(
  diff: DiffResult,
  filePath?: string,
  options?: { color?: boolean; maxLines?: number }
): string {
  if (!diff.hasChanges) return '(no changes)';

  const lines: string[] = [];
  const maxLines = options?.maxLines ?? 200;

  if (filePath) {
    lines.push(`--- ${filePath}`);
    lines.push(`+++ ${filePath}`);
  }

  lines.push(`${diff.additions} addition(s), ${diff.deletions} deletion(s)`);
  lines.push('');

  let lineCount = 0;
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    lineCount++;

    for (const line of hunk.lines) {
      if (lineCount >= maxLines) {
        lines.push(`... (${diff.hunks.reduce((s, h) => s + h.lines.length, 0) - lineCount} more lines)`);
        return lines.join('\n');
      }

      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      lines.push(`${prefix} ${line.content}`);
      lineCount++;
    }
  }

  return lines.join('\n');
}

/**
 * Format diff as compact summary (for tool results).
 */
export function formatDiffSummary(diff: DiffResult, filePath: string): string {
  if (!diff.hasChanges) return `${filePath}: no changes`;
  return `${filePath}: +${diff.additions} -${diff.deletions} (${diff.hunks.length} hunk${diff.hunks.length > 1 ? 's' : ''})`;
}

// ── Token estimation ──

export function estimateDiffTokens(diff: DiffResult): number {
  let chars = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      chars += line.content.length + 2; // +2 for prefix and newline
    }
  }
  return Math.ceil(chars / 4); // ~4 chars per token
}

// ── Internal: change computation ──

interface Change {
  type: 'add' | 'remove' | 'equal';
  oldIndex: number;
  newIndex: number;
  oldLine?: string;
  newLine?: string;
}

function computeChanges(oldLines: string[], newLines: string[]): Change[] {
  // Simple O(n*m) LCS for small files, line-by-line comparison for large
  if (oldLines.length * newLines.length > 1_000_000) {
    return computeChangesLinear(oldLines, newLines);
  }

  const changes: Change[] = [];
  const lcs = computeLCS(oldLines, newLines);

  let oi = 0, ni = 0, li = 0;
  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length
        && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      changes.push({ type: 'equal', oldIndex: oi, newIndex: ni });
      oi++; ni++; li++;
    } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
      changes.push({ type: 'remove', oldIndex: oi, newIndex: ni, oldLine: oldLines[oi] });
      oi++;
    } else if (ni < newLines.length) {
      changes.push({ type: 'add', oldIndex: oi, newIndex: ni, newLine: newLines[ni] });
      ni++;
    }
  }

  return changes.filter(c => c.type !== 'equal');
}

function computeChangesLinear(oldLines: string[], newLines: string[]): Change[] {
  // Fallback for very large files: line-by-line comparison
  const changes: Change[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (i >= oldLines.length) {
      changes.push({ type: 'add', oldIndex: oldLines.length, newIndex: i, newLine: newLines[i] });
    } else if (i >= newLines.length) {
      changes.push({ type: 'remove', oldIndex: i, newIndex: newLines.length, oldLine: oldLines[i] });
    } else if (oldLines[i] !== newLines[i]) {
      changes.push({ type: 'remove', oldIndex: i, newIndex: i, oldLine: oldLines[i] });
      changes.push({ type: 'add', oldIndex: i, newIndex: i, newLine: newLines[i] });
    }
  }
  return changes;
}

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] > dp[i][j - 1]) { i--; }
    else { j--; }
  }
  return result;
}

function buildHunks(oldLines: string[], newLines: string[], changes: Change[], context: number): DiffHunk[] {
  if (changes.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let lastChangeIdx = -context - 1;

  // Build a set of changed line indices
  const removedOldIdx = new Set(changes.filter(c => c.type === 'remove').map(c => c.oldIndex));
  const addedNewIdx = new Set(changes.filter(c => c.type === 'add').map(c => c.newIndex));

  // Walk through all lines, creating hunks around changes
  const allIndices = new Set<number>();
  for (const c of changes) {
    const idx = c.type === 'remove' ? c.oldIndex : c.newIndex;
    for (let k = Math.max(0, idx - context); k <= idx + context; k++) allIndices.add(k);
  }

  const sorted = Array.from(allIndices).sort((a, b) => a - b);
  let hunkLines: DiffLine[] = [];
  let oldStart = -1, newStart = -1;

  for (const lineIdx of sorted) {
    if (removedOldIdx.has(lineIdx)) {
      if (oldStart < 0) { oldStart = lineIdx + 1; newStart = lineIdx + 1; }
      hunkLines.push({ type: 'remove', content: oldLines[lineIdx] || '', oldLineNo: lineIdx + 1 });
    } else if (addedNewIdx.has(lineIdx)) {
      if (oldStart < 0) { oldStart = lineIdx + 1; newStart = lineIdx + 1; }
      hunkLines.push({ type: 'add', content: newLines[lineIdx] || '', newLineNo: lineIdx + 1 });
    } else if (lineIdx < oldLines.length) {
      if (oldStart < 0) { oldStart = lineIdx + 1; newStart = lineIdx + 1; }
      hunkLines.push({ type: 'context', content: oldLines[lineIdx] || '', oldLineNo: lineIdx + 1, newLineNo: lineIdx + 1 });
    }
  }

  if (hunkLines.length > 0) {
    const oldCount = hunkLines.filter(l => l.type !== 'add').length;
    const newCount = hunkLines.filter(l => l.type !== 'remove').length;
    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
  }

  return hunks;
}
