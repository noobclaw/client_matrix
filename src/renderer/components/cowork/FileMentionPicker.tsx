/**
 * File @mention autocomplete popup.
 *
 * Opens above the composer when the user types "@" followed by any
 * characters. Pulls the file list from workspace:listFiles (cached
 * 10 s server-side), runs a tiny fuzzy matcher client-side, and
 * renders the top 12 matches. Selecting inserts the relative path
 * at the cursor, replacing the "@query" fragment.
 *
 * The fuzzy scorer is inline (~20 lines) rather than a dependency —
 * file lists are <= 8k entries and the user's query is usually a
 * few characters, so a simple substring + sequential-match bonus
 * beats pulling in fzy/fzf and keeps the bundle small.
 *
 * Navigation keys (↑/↓ Enter Tab Esc) are captured by the parent
 * composer and forwarded through the same pattern as SlashCommandPicker.
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';

export interface WorkspaceEntry {
  rel: string;
  size: number;
  kind: 'file' | 'dir';
}

interface Props {
  query: string;
  workingDirectory: string;
  onSelect: (rel: string) => void;
  onClose: () => void;
  forwardRef?: React.MutableRefObject<{
    moveDown: () => void;
    moveUp: () => void;
    acceptCurrent: () => void;
  } | null>;
}

// ── Fuzzy scorer (substring match with sequential-char bonus) ──

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === lastMatchIdx + 1) score += 3; // sequential bonus
      if (ti === 0 || t[ti - 1] === '/' || t[ti - 1] === '_' || t[ti - 1] === '-' || t[ti - 1] === '.') {
        score += 2; // boundary bonus
      }
      lastMatchIdx = ti;
      qi += 1;
    }
  }
  if (qi < q.length) return 0;
  // Shorter paths are slightly preferred on ties.
  return score - t.length * 0.01;
}

const FileMentionPicker: React.FC<Props> = ({ query, workingDirectory, onSelect, onClose, forwardRef }) => {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // Deduplicate requests per workingDirectory — a rapid keystroke
  // burst should only fire one listFiles call.
  const reqKey = useRef<string>('');

  useEffect(() => {
    const key = workingDirectory || '';
    if (reqKey.current === key && entries.length > 0) return;
    reqKey.current = key;
    setLoaded(false);
    const anyWindow = window as unknown as {
      electron?: { workspace?: { listFiles: (root: string) => Promise<WorkspaceEntry[]> } };
    };
    const api = anyWindow.electron?.workspace;
    if (!api || !key) {
      setLoaded(true);
      setEntries([]);
      return;
    }
    let cancelled = false;
    api.listFiles(key).then((list) => {
      if (cancelled) return;
      setEntries(Array.isArray(list) ? list : []);
      setLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [workingDirectory, entries.length]);

  const ranked = useMemo(() => {
    if (!entries.length) return [];
    const scored = entries.map((e) => ({ e, score: fuzzyScore(query, e.rel) }));
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((s) => s.e);
  }, [entries, query]);

  useEffect(() => {
    if (activeIdx >= ranked.length) setActiveIdx(ranked.length > 0 ? ranked.length - 1 : 0);
  }, [ranked, activeIdx]);

  const accept = useCallback((idx: number) => {
    const pick = ranked[idx];
    if (pick) onSelect(pick.rel);
  }, [ranked, onSelect]);

  useEffect(() => {
    if (!forwardRef) return;
    forwardRef.current = {
      moveDown: () => setActiveIdx((i) => Math.min(ranked.length - 1, i + 1)),
      moveUp: () => setActiveIdx((i) => Math.max(0, i - 1)),
      acceptCurrent: () => accept(activeIdx),
    };
    return () => { if (forwardRef) forwardRef.current = null; };
  }, [forwardRef, ranked.length, activeIdx, accept]);

  if (!loaded) return null;
  if (ranked.length === 0) {
    return (
      <div
        className="absolute left-0 right-0 bottom-full mb-2 z-30 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border shadow-lg text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary px-3 py-2"
        onMouseDown={(e) => e.preventDefault()}
      >
        {query
          ? <>No files matching "<span className="font-mono">{query}</span>" in the working directory.</>
          : <>Type a filename after @ to search the working directory.</>}
      </div>
    );
  }

  return (
    <div
      className="absolute left-0 right-0 bottom-full mb-2 z-30 max-h-64 overflow-y-auto rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary dark:border-b-claude-darkBorder border-b-claude-border border-b flex items-center justify-between">
        <span>Files · {workingDirectory.replace(/^.*[\\/]/, '')}</span>
        <button type="button" className="hover:underline" onClick={onClose}>esc</button>
      </div>
      {ranked.map((entry, idx) => (
        <div
          key={entry.rel}
          className={`px-3 py-1.5 cursor-pointer flex items-center gap-2 font-mono text-xs ${
            idx === activeIdx
              ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
              : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
          }`}
          onMouseEnter={() => setActiveIdx(idx)}
          onClick={() => accept(idx)}
        >
          <span className="shrink-0 opacity-60">{entry.kind === 'dir' ? '📁' : '📄'}</span>
          <span className="truncate dark:text-claude-darkText text-claude-text">{entry.rel}</span>
          {entry.kind === 'file' && entry.size > 0 && (
            <span className="ml-auto shrink-0 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {entry.size < 1024 ? `${entry.size}B` : `${Math.round(entry.size / 1024)}KB`}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};

export default FileMentionPicker;
