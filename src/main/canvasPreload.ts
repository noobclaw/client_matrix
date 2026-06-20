/**
 * Canvas Preload — contextBridge for A2UI canvas windows.
 * Exposes window.electronCanvasBridge for capturing user interactions.
 *
 * This file is loaded as the preload script for canvas BrowserWindows.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronCanvasBridge', {
  /**
   * Send a user action from the canvas to the main process.
   */
  sendAction(sessionId: string, action: {
    type: string;
    target?: string;
    value?: string;
    data?: Record<string, unknown>;
    timestamp: number;
  }) {
    ipcRenderer.send('canvas:action', sessionId, action);
  },

  /**
   * Listen for updates pushed from the main process.
   */
  onUpdate(callback: (update: { html?: string; js?: string; selector?: string }) => void) {
    ipcRenderer.on('canvas:update', (_event: any, update: any) => {
      callback(update);
    });
  },

  /**
   * Notify the main process that the canvas is ready.
   */
  ready(sessionId: string) {
    ipcRenderer.send('canvas:ready', sessionId);
  },
});
