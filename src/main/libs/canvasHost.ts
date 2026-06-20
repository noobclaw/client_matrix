/**
 * Canvas Host — manages A2UI canvas windows in Electron.
 * Agent generates HTML/JS → renders in BrowserWindow → user actions captured → fed back as tool results.
 *
 * Ported from OpenClaw src/canvas-host/server.ts
 * Adapted for Electron: BrowserWindow instead of HTTP server.
 */

import { isElectronMode } from './platformAdapter';

// Conditionally load Electron modules — unavailable in sidecar mode
let BrowserWindow: any = null;
let ipcMain: any = null;
try {
  if (isElectronMode()) {
    const electron = require('electron');
    BrowserWindow = electron.BrowserWindow;
    ipcMain = electron.ipcMain;
  }
} catch {}
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { coworkLog } from './coworkLogger';

// ── Types ──

export interface CanvasSession {
  id: string;
  parentSessionId: string;
  window: any | null;
  currentHtml: string;
  pendingActions: CanvasAction[];
  actionResolvers: Array<(action: CanvasAction) => void>;
  createdAt: number;
}

export interface CanvasAction {
  type: string;          // 'click', 'submit', 'input', 'custom'
  target?: string;       // CSS selector or element ID
  value?: string;        // input value, button text, etc.
  data?: Record<string, unknown>;
  timestamp: number;
}

// ── Active sessions ──

const canvasSessions = new Map<string, CanvasSession>();

// ── Canvas file management ──

function getCanvasDir(): string {
  const dir = path.join(os.tmpdir(), 'noobclaw-canvas');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCanvasFile(sessionId: string, html: string): string {
  const filePath = path.join(getCanvasDir(), `canvas-${sessionId}.html`);
  // Inject the bridge script before </body>
  const bridgeScript = buildBridgeScript(sessionId);
  const injected = html.includes('</body>')
    ? html.replace('</body>', `${bridgeScript}\n</body>`)
    : `${html}\n${bridgeScript}`;
  fs.writeFileSync(filePath, injected, 'utf-8');
  return filePath;
}

function buildBridgeScript(sessionId: string): string {
  return `
<script>
  // NoobClaw Canvas Bridge — captures user interactions
  (function() {
    const sessionId = ${JSON.stringify(sessionId)};

    function sendAction(type, target, value, data) {
      if (window.electronCanvasBridge) {
        window.electronCanvasBridge.sendAction(sessionId, {
          type, target, value, data, timestamp: Date.now()
        });
      }
    }

    // Capture clicks
    document.addEventListener('click', function(e) {
      const el = e.target;
      const selector = el.id ? '#' + el.id : el.tagName.toLowerCase();
      sendAction('click', selector, el.textContent?.slice(0, 100), {
        tagName: el.tagName, className: el.className, id: el.id
      });
    });

    // Capture form submissions
    document.addEventListener('submit', function(e) {
      e.preventDefault();
      const form = e.target;
      const formData = {};
      new FormData(form).forEach((v, k) => formData[k] = v);
      sendAction('submit', form.id || form.action, JSON.stringify(formData), formData);
    });

    // Expose global for agent JS injection
    window.canvasNotify = function(type, data) {
      sendAction('custom', type, JSON.stringify(data), data);
    };
  })();
</script>`;
}

// ── Create canvas window ──

export function createCanvasWindow(
  parentSessionId: string,
  html: string,
  options?: { title?: string; width?: number; height?: number }
): CanvasSession {
  const id = uuidv4();

  const session: CanvasSession = {
    id,
    parentSessionId,
    window: null,
    currentHtml: html,
    pendingActions: [],
    actionResolvers: [],
    createdAt: Date.now(),
  };

  canvasSessions.set(id, session);

  // Write HTML to temp file
  const filePath = writeCanvasFile(id, html);

  // Create BrowserWindow
  const win = new BrowserWindow({
    width: options?.width || 800,
    height: options?.height || 600,
    title: options?.title || 'NoobClaw Canvas',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'canvasPreload.js'),
    },
  });

  win.loadFile(filePath);
  session.window = win;

  win.on('closed', () => {
    session.window = null;
    coworkLog('INFO', 'canvasHost', `Canvas window closed: ${id}`);
  });

  coworkLog('INFO', 'canvasHost', `Canvas created: ${id}`, {
    parentSessionId,
    title: options?.title,
  });

  return session;
}

// ── Update canvas content ──

export function updateCanvas(
  sessionId: string,
  update: { html?: string; js?: string; selector?: string }
): boolean {
  const session = canvasSessions.get(sessionId);
  if (!session?.window || session.window.isDestroyed()) return false;

  if (update.html && update.selector) {
    // Update specific element
    session.window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(update.selector)}).innerHTML = ${JSON.stringify(update.html)};`
    ).catch(() => {});
  } else if (update.html) {
    // Full HTML replace
    session.currentHtml = update.html;
    const filePath = writeCanvasFile(sessionId, update.html);
    session.window.loadFile(filePath);
  } else if (update.js) {
    // Execute JavaScript
    session.window.webContents.executeJavaScript(update.js).catch(() => {});
  }

  return true;
}

// ── Wait for user action ──

export function waitForCanvasAction(sessionId: string, timeoutMs: number = 60000): Promise<CanvasAction | null> {
  const session = canvasSessions.get(sessionId);
  if (!session) return Promise.resolve(null);

  // Check pending actions first
  if (session.pendingActions.length > 0) {
    return Promise.resolve(session.pendingActions.shift()!);
  }

  // Wait for next action
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = session.actionResolvers.indexOf(resolve as any);
      if (idx >= 0) session.actionResolvers.splice(idx, 1);
      resolve(null);
    }, timeoutMs);

    session.actionResolvers.push((action) => {
      clearTimeout(timer);
      resolve(action);
    });
  });
}

// ── Receive action from preload bridge ──

export function onCanvasAction(sessionId: string, action: CanvasAction): void {
  const session = canvasSessions.get(sessionId);
  if (!session) return;

  coworkLog('INFO', 'canvasHost', `Canvas action: ${action.type} on ${action.target}`, { sessionId });

  // If someone is waiting for an action, resolve immediately
  const resolver = session.actionResolvers.shift();
  if (resolver) {
    resolver(action);
  } else {
    // Queue for later retrieval
    session.pendingActions.push(action);
    // Limit queue size
    if (session.pendingActions.length > 100) {
      session.pendingActions.shift();
    }
  }
}

// ── Close canvas ──

export function closeCanvas(sessionId: string): boolean {
  const session = canvasSessions.get(sessionId);
  if (!session) return false;

  if (session.window && !session.window.isDestroyed()) {
    session.window.close();
  }

  // Resolve any pending waiters with null
  for (const resolver of session.actionResolvers) {
    resolver({ type: 'closed', timestamp: Date.now() });
  }

  canvasSessions.delete(sessionId);
  return true;
}

// ── Query ──

export function getCanvasSession(sessionId: string): CanvasSession | null {
  return canvasSessions.get(sessionId) ?? null;
}

export function getCanvasSessionsByParent(parentSessionId: string): CanvasSession[] {
  return Array.from(canvasSessions.values()).filter(s => s.parentSessionId === parentSessionId);
}

// ── Snapshot — capture canvas as image or HTML text ──

export async function captureCanvasSnapshot(sessionId: string): Promise<{ type: 'image' | 'html'; data: string } | null> {
  const session = canvasSessions.get(sessionId);
  if (!session) return null;

  // Electron mode: capture as PNG via webContents
  if (session.window && !session.window.isDestroyed()) {
    try {
      const image = await session.window.webContents.capturePage();
      const pngBuffer = image.toPNG();
      return { type: 'image', data: pngBuffer.toString('base64') };
    } catch {}
  }

  // Fallback (Tauri/sidecar): return HTML source as text snapshot
  return { type: 'html', data: session.currentHtml };
}

// ── A2UI Push — inject data into canvas without replacing entire HTML ──

export function pushCanvasData(sessionId: string, jsonlData: string): boolean {
  const session = canvasSessions.get(sessionId);
  if (!session) return false;

  // Execute JS in canvas to inject data
  const js = `
    (function() {
      try {
        const lines = ${JSON.stringify(jsonlData)}.split('\\n').filter(Boolean);
        const data = lines.map(l => JSON.parse(l));
        window.__noobclaw_canvas_data = data;
        window.dispatchEvent(new CustomEvent('noobclaw:data', { detail: data }));
      } catch (e) { console.error('A2UI push error:', e); }
    })();
  `;

  if (session.window && !session.window.isDestroyed()) {
    try {
      session.window.webContents.executeJavaScript(js);
      return true;
    } catch {}
  }
  return false;
}

// ── Get canvas HTML source ──

export function getCanvasHTML(sessionId: string): string | null {
  const session = canvasSessions.get(sessionId);
  return session?.currentHtml ?? null;
}

// ── Initialize IPC handlers ──

export function initCanvasIPC(): void {
  ipcMain.on('canvas:action', (_event: any, sessionId: string, action: CanvasAction) => {
    onCanvasAction(sessionId, action);
  });

  coworkLog('INFO', 'canvasHost', 'Canvas IPC initialized');
}
