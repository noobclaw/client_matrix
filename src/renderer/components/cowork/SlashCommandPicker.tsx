/**
 * Slash command autocomplete popup.
 *
 * Rendered just above the composer when the user types "/" as the
 * first character of the input. Fetches user commands from the
 * sidecar (slashCommands:list IPC) and shows a filterable dropdown.
 * Selecting an entry replaces the entire composer value with
 * "/name " so the user can type arguments inline — coworkRunner
 * expands the body on session start (see userSlashCommands.ts).
 *
 * Navigation: ↑/↓ to move, Enter/Tab to accept, Esc to close.
 * The parent component owns the input value and open state and
 * routes key events here via props.
 *
 * Keeping this component stateless-ish (all state lifted up except
 * the local command cache) makes it easy to position it next to the
 * composer without refactoring the existing handlers.
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';

export interface UserSlashCommand {
  name: string;
  description: string;
  file: string;
}

interface Props {
  query: string; // Partial command name the user has typed after "/"
  onSelect: (name: string) => void;
  onClose: () => void;
  /** Allow the parent to imperatively trigger navigation from its keyDown handler. */
  forwardRef?: React.MutableRefObject<{
    moveDown: () => void;
    moveUp: () => void;
    acceptCurrent: () => void;
  } | null>;
}

const SlashCommandPicker: React.FC<Props> = ({ query, onSelect, onClose, forwardRef }) => {
  const [commands, setCommands] = useState<UserSlashCommand[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // Lazy-load once when the popup first opens. Refreshing is cheap
  // (just a filesystem walk) but we don't want to re-hit it on every
  // keystroke, so we cache for the life of the popup.
  useEffect(() => {
    let cancelled = false;
    const anyWindow = window as unknown as {
      electron?: { slashCommands?: { list: () => Promise<UserSlashCommand[]> } };
    };
    const api = anyWindow.electron?.slashCommands;
    if (!api) {
      setLoaded(true);
      return;
    }
    api.list().then((list) => {
      if (cancelled) return;
      setCommands(Array.isArray(list) ? list : []);
      setLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter((c) =>
      c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Keep activeIdx in bounds when the filter narrows the list.
  useEffect(() => {
    if (activeIdx >= filtered.length) {
      setActiveIdx(filtered.length > 0 ? filtered.length - 1 : 0);
    }
  }, [filtered, activeIdx]);

  const accept = useCallback((idx: number) => {
    const cmd = filtered[idx];
    if (cmd) onSelect(cmd.name);
  }, [filtered, onSelect]);

  // Expose navigation methods to the parent so it can forward arrow
  // keys from its own keyDown handler without us duplicating focus.
  useEffect(() => {
    if (!forwardRef) return;
    forwardRef.current = {
      moveDown: () => setActiveIdx((i) => Math.min(filtered.length - 1, i + 1)),
      moveUp: () => setActiveIdx((i) => Math.max(0, i - 1)),
      acceptCurrent: () => accept(activeIdx),
    };
    return () => { if (forwardRef) forwardRef.current = null; };
  }, [forwardRef, filtered.length, activeIdx, accept]);

  if (!loaded) return null;
  if (filtered.length === 0) {
    return (
      <div
        className="absolute left-0 right-0 bottom-full mb-2 z-30 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border shadow-lg text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary px-3 py-2"
        onMouseDown={(e) => e.preventDefault()}
      >
        No commands matching "<span className="font-mono">/{query}</span>".
        {' '}
        Drop markdown files into the <code>commands/</code> folder to create them.
      </div>
    );
  }

  return (
    <div
      className="absolute left-0 right-0 bottom-full mb-2 z-30 max-h-64 overflow-y-auto rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border shadow-lg"
      onMouseDown={(e) => e.preventDefault()} // Don't steal focus from the textarea
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary dark:border-b-claude-darkBorder border-b-claude-border border-b flex items-center justify-between">
        <span>Slash commands</span>
        <button
          type="button"
          className="hover:underline"
          onClick={onClose}
        >
          esc
        </button>
      </div>
      {filtered.map((cmd, idx) => (
        <div
          key={cmd.name}
          className={`px-3 py-2 cursor-pointer flex items-start gap-2 ${
            idx === activeIdx
              ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
              : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
          }`}
          onMouseEnter={() => setActiveIdx(idx)}
          onClick={() => accept(idx)}
        >
          <span className="font-mono text-xs dark:text-claude-accent text-claude-accent shrink-0">/{cmd.name}</span>
          {cmd.description && (
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {cmd.description}
            </span>
          )}
        </div>
      ))}
    </div>
  );
};

export default SlashCommandPicker;
