/**
 * File State Cache — tracks which files the model has read.
 * Prevents editing files that haven't been read (common "dumb" behavior).
 *
 * Reference: Claude Code src/utils/fileStateCache.ts (142 lines)
 */

import path from 'path';
import { coworkLog } from './coworkLogger';

// ── Types ──

interface FileState {
  content: string;
  readAt: number;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  size: number;
}

// ── LRU Cache ──

const MAX_ENTRIES = 100;
const MAX_TOTAL_SIZE = 25 * 1024 * 1024; // 25MB

const cache = new Map<string, FileState>();
let totalSize = 0;

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

// ── Record file read ──

export function recordFileRead(filePath: string, content: string, options?: {
  offset?: number;
  limit?: number;
  totalLines?: number;
}): void {
  const key = normalizePath(filePath);
  const isPartial = !!(options?.offset && options.offset > 1) || !!(options?.limit);

  // Evict old entries if over size
  while (totalSize + content.length > MAX_TOTAL_SIZE && cache.size > 0) {
    const oldest = cache.keys().next().value;
    if (oldest) evict(oldest);
    else break;
  }

  // Evict if over count
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) evict(oldest);
    else break;
  }

  // Remove old entry if exists
  if (cache.has(key)) evict(key);

  cache.set(key, {
    content,
    readAt: Date.now(),
    offset: options?.offset,
    limit: options?.limit,
    isPartialView: isPartial,
    size: content.length,
  });
  totalSize += content.length;
}

function evict(key: string): void {
  const entry = cache.get(key);
  if (entry) {
    totalSize -= entry.size;
    cache.delete(key);
  }
}

// ── Check file state ──

/**
 * Check if the model has read a file before allowing edit.
 * Returns null if OK to edit, or an error message if not.
 */
export function checkFileReadBeforeEdit(filePath: string): string | null {
  const key = normalizePath(filePath);
  const state = cache.get(key);

  if (!state) {
    return `You must Read "${filePath}" before editing it. The model has not seen this file's contents.`;
  }

  if (state.isPartialView) {
    return `Warning: You only read a partial view of "${filePath}" (offset=${state.offset}, limit=${state.limit}). Consider reading the full file before making edits.`;
  }

  // Check if file was read more than 10 minutes ago
  const ageMinutes = (Date.now() - state.readAt) / 60_000;
  if (ageMinutes > 10) {
    return `Warning: "${filePath}" was last read ${Math.round(ageMinutes)} minutes ago. The file may have changed. Consider re-reading.`;
  }

  return null; // OK to edit
}

/**
 * Check if a file has been read (for any purpose).
 */
export function hasFileBeenRead(filePath: string): boolean {
  return cache.has(normalizePath(filePath));
}

/**
 * Get cached content of a file (if available).
 */
export function getCachedFileContent(filePath: string): string | null {
  const state = cache.get(normalizePath(filePath));
  return state?.content ?? null;
}

/**
 * Record a file write/edit (updates the cache with new content).
 */
export function recordFileWrite(filePath: string, content: string): void {
  recordFileRead(filePath, content);
}

// ── Stats ──

export function getFileStateCacheStats(): { entries: number; totalSizeKB: number } {
  return { entries: cache.size, totalSizeKB: Math.round(totalSize / 1024) };
}

export function clearFileStateCache(): void {
  cache.clear();
  totalSize = 0;
}
