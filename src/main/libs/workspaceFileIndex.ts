/**
 * Workspace file index for the @mention composer autocomplete.
 *
 * Produces a flat list of relative file paths under a given working
 * directory, filtered through a minimal ignore list (`.git`,
 * `node_modules`, `target`, `.venv`, etc.) and capped at 8_000
 * entries so even huge monorepos don't blow the sidecar's memory.
 * The cache is keyed by directory with a short TTL so the renderer
 * can re-hit the endpoint on every keystroke cheaply without the
 * sidecar walking the filesystem each time.
 *
 * The final list is consumed by src/renderer/components/cowork/
 * FileMentionPicker.tsx which does fuzzy matching client-side —
 * keeping the scoring in the renderer avoids a second IPC round
 * trip per keystroke and lets it stay tight with React state.
 */

import fs from 'fs';
import path from 'path';
import { coworkLog } from './coworkLogger';

export interface WorkspaceFileEntry {
  /** Path relative to the working directory, always forward-slash. */
  rel: string;
  /** File size in bytes. Used by the UI to show a quick size hint. */
  size: number;
  /** `file` or `dir`. We index both so the user can @mention directories. */
  kind: 'file' | 'dir';
}

const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'target', 'dist', 'build', 'out',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo',
  '.DS_Store',
]);

const MAX_ENTRIES = 8_000;
const CACHE_TTL_MS = 10_000;

interface CacheEntry {
  entries: WorkspaceFileEntry[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Walk the directory tree starting at `root` and return up to
 * MAX_ENTRIES relative paths. Results are cached for CACHE_TTL_MS
 * so rapid keystrokes in the composer don't re-walk the disk.
 */
export function listWorkspaceFiles(root: string): WorkspaceFileEntry[] {
  if (!root) return [];
  const now = Date.now();
  const cached = cache.get(root);
  if (cached && cached.expiresAt > now) return cached.entries;

  const entries: WorkspaceFileEntry[] = [];
  let stopped = false;

  const walk = (dir: string, relPrefix: string): void => {
    if (stopped) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (stopped) return;
      if (item.name.startsWith('.') && IGNORED_DIRS.has(item.name)) continue;
      if (IGNORED_DIRS.has(item.name)) continue;

      const abs = path.join(dir, item.name);
      const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;

      if (item.isDirectory()) {
        entries.push({ rel, size: 0, kind: 'dir' });
        if (entries.length >= MAX_ENTRIES) { stopped = true; return; }
        walk(abs, rel);
      } else if (item.isFile()) {
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { /* ignore */ }
        entries.push({ rel, size, kind: 'file' });
        if (entries.length >= MAX_ENTRIES) { stopped = true; return; }
      }
    }
  };

  try {
    walk(root, '');
  } catch (e) {
    coworkLog('WARN', 'workspaceFileIndex', `walk failed at ${root}: ${e}`);
  }

  cache.set(root, { entries, expiresAt: now + CACHE_TTL_MS });
  coworkLog('INFO', 'workspaceFileIndex', `Indexed ${entries.length} entries under ${root}${stopped ? ' (truncated at MAX_ENTRIES)' : ''}`);
  return entries;
}

/**
 * Drop the cache for a specific directory — called when the user
 * explicitly triggers a refresh, or can be wired to a file-system
 * watcher later. No-op for unknown roots.
 */
export function invalidateWorkspaceFileIndex(root?: string): void {
  if (!root) {
    cache.clear();
    return;
  }
  cache.delete(root);
}
