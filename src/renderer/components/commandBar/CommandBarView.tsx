/**
 * Spotlight-style floating command bar.
 *
 * Lives in the secondary Tauri WebviewWindow `command-bar` (declared in
 * tauri.conf.json). The window is decorations:false, transparent:true,
 * alwaysOnTop:true, skipTaskbar:true, and on macOS is further elevated
 * to panel-level by src-tauri/src/lib.rs::elevate_command_bar_to_panel
 * so it floats over full-screen apps and auto-hides on focus loss.
 *
 * Global hotkey: ⌥⌘Space (mac) / Ctrl+Alt+Space (win/linux) toggles
 * visibility via the toggle_command_bar Tauri command.
 *
 * Flow:
 *   1. User hits the global shortcut.
 *   2. Rust calls show_command_bar → NSPanel appears centered at 22%
 *      from the top of the active screen.
 *   3. The <input> auto-focuses, user types a prompt, hits Enter.
 *   4. We POST /api/cowork:session:create on the sidecar with the
 *      prompt text, get a sessionId back, then call show_main_window
 *      and navigate the main window to that session.
 *   5. The command bar hides itself (hide_command_bar).
 *
 * Bundle size: the command bar shares the main dist bundle so there's
 * zero extra JS to ship. The root `#command-bar` hash route in
 * main.tsx branches to this component instead of <App />.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';

// Minimal Tauri core invoke reference. We avoid a hard import of
// @tauri-apps/api so this file still type-checks in Electron builds
// where the package is not present at runtime.
function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const anyWindow = window as unknown as {
    __TAURI__?: { core?: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } };
  };
  const invoke = anyWindow.__TAURI__?.core?.invoke;
  if (!invoke) return Promise.resolve(null);
  return invoke(cmd, args || {});
}

const CommandBarView: React.FC = () => {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input whenever the window becomes visible. Tauri fires a
  // `tauri://focus` event but listening to it requires the @tauri-apps
  // event module; polling window.visibilityState on a 200ms interval
  // is simpler and has no observable cost for such a light view.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden && document.activeElement !== inputRef.current) {
        inputRef.current?.focus();
      }
    }, 200);
    inputRef.current?.focus();
    return () => window.clearInterval(id);
  }, []);

  // ESC hides the bar. Enter submits.
  const onKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setValue('');
      await tauriInvoke('hide_command_bar');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = value.trim();
      if (!text || busy) return;
      setBusy(true);
      try {
        // Hand the prompt off to the main window. We use a custom JS
        // event the main App listens for — it creates a new cowork
        // session and streams into it. Same protocol the tray menu
        // "New Chat" uses so we don't duplicate session-creation logic.
        const payload = JSON.stringify({ prompt: text, source: 'command-bar' });
        // Dispatch into the main window via BroadcastChannel (works
        // across Tauri webviews backed by the same scheme) and also
        // persist the pending prompt to sessionStorage as a fallback.
        try {
          const bc = new BroadcastChannel('noobclaw-command-bar');
          bc.postMessage({ type: 'submit', payload: JSON.parse(payload) });
          bc.close();
        } catch { /* older webviews without BroadcastChannel */ }
        try {
          localStorage.setItem('noobclaw:command-bar:pending', payload);
        } catch { /* private mode — fine */ }

        // Bring the main window to the foreground so the user sees
        // the session kick off immediately.
        await tauriInvoke('show_main_window');
        await tauriInvoke('hide_command_bar');
        setValue('');
      } finally {
        setBusy(false);
      }
    }
  }, [value, busy]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        // Draggable shell so the user can reposition the bar if the
        // centered spot is blocked. Tauri v2 honors `data-tauri-drag-region`
        // on any element to drag the window from there.
      }}
      data-tauri-drag-region=""
    >
      <div
        style={{
          width: '660px',
          height: '54px',
          borderRadius: '14px',
          background: 'rgba(22, 22, 26, 0.86)',
          backdropFilter: 'blur(30px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(30px) saturate(1.4)',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 18px',
          gap: '14px',
        }}
      >
        {/* Orange dot = NoobClaw brand mark */}
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: '#ff7a18',
            flexShrink: 0,
            boxShadow: '0 0 10px rgba(255, 122, 24, 0.7)',
          }}
        />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask NoobClaw anything…"
          spellCheck={false}
          autoFocus
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#f5f5f7',
            fontSize: '18px',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
            fontWeight: 400,
            caretColor: '#ff7a18',
          }}
        />
        {busy && (
          <div
            style={{
              color: '#999',
              fontSize: '12px',
              flexShrink: 0,
            }}
          >
            ⏎ working…
          </div>
        )}
        {!busy && value.length > 0 && (
          <div style={{ color: '#666', fontSize: '11px', flexShrink: 0 }}>
            ⏎ send · Esc close
          </div>
        )}
      </div>
    </div>
  );
};

export default CommandBarView;
