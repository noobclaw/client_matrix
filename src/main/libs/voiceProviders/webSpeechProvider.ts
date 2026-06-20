/**
 * Web Speech Provider — bridges renderer-side Web Speech API via IPC.
 * STT and TTS both run in Chromium's renderer process.
 *
 * This provider works by sending IPC messages to the renderer,
 * which calls the browser's SpeechRecognition / SpeechSynthesis APIs.
 */

import { isElectronMode } from '../platformAdapter';

let BrowserWindow: any = null;
try {
  if (isElectronMode()) {
    BrowserWindow = require('electron').BrowserWindow;
  }
} catch {}
import type { STTProvider, TTSProvider } from '../voiceProviderRegistry';
import { coworkLog } from '../coworkLogger';

let listening = false;
let transcriptResolve: ((text: string) => void) | null = null;

function getWindow(): any | null {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

export const webSpeechSTTProvider: STTProvider = {
  name: 'web-speech',
  type: 'stt',

  isAvailable(): boolean {
    return !!getWindow();
  },

  async startListening(options?: { language?: string }): Promise<void> {
    const win = getWindow();
    if (!win) throw new Error('No window available for Web Speech API');
    listening = true;
    win.webContents.send('voice:startListening', { language: options?.language || 'en-US' });
    coworkLog('INFO', 'webSpeechProvider', 'STT listening started via IPC');
  },

  async stopListening(): Promise<string> {
    const win = getWindow();
    if (win) win.webContents.send('voice:stopListening');
    listening = false;

    // Wait for transcript from renderer (set by onVoiceTranscript in voiceTools.ts)
    return new Promise((resolve) => {
      transcriptResolve = resolve;
      // Timeout fallback
      setTimeout(() => {
        if (transcriptResolve === resolve) {
          transcriptResolve = null;
          resolve('');
        }
      }, 5000);
    });
  },

  isListening(): boolean {
    return listening;
  },
};

/**
 * Called from main process when renderer sends transcript via IPC.
 */
export function resolveWebSpeechTranscript(text: string): void {
  if (transcriptResolve) {
    transcriptResolve(text);
    transcriptResolve = null;
  }
}

export const webSpeechTTSProvider: TTSProvider = {
  name: 'web-speech',
  type: 'tts',

  isAvailable(): boolean {
    return !!getWindow();
  },

  async speak(text: string, options?: { voice?: string; speed?: number }): Promise<void> {
    const win = getWindow();
    if (!win) throw new Error('No window available for Web Speech TTS');
    win.webContents.send('voice:speak', {
      text: text.slice(0, 5000),
      voice: options?.voice,
      rate: options?.speed || 1.0,
    });
    coworkLog('INFO', 'webSpeechProvider', `TTS speaking: "${text.slice(0, 50)}..."`);
    // Web Speech TTS is fire-and-forget from main process perspective
  },

  stop(): void {
    const win = getWindow();
    if (win) win.webContents.send('voice:stopSpeaking');
  },

  isSpeaking(): boolean {
    return false; // Can't track from main process
  },
};
