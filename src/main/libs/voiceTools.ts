/**
 * Voice Tools — tool definitions for speech interaction.
 * Bridges renderer-side Web Speech API and main-side providers via IPC.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import { getActiveSTT, getActiveTTS, listProviders, setActiveSTT, setActiveTTS } from './voiceProviderRegistry';
import { isElectronMode } from './platformAdapter';

// Conditionally load Electron modules — unavailable in sidecar mode
let BrowserWindow: any = null;
try {
  if (isElectronMode()) {
    BrowserWindow = require('electron').BrowserWindow;
  }
} catch {}
import { coworkLog } from './coworkLogger';

// ── IPC bridge for renderer-side Web Speech API ──

let voiceIPCResolve: ((transcript: string) => void) | null = null;

/**
 * Called from main.ts when renderer sends voice transcript via IPC.
 */
export function onVoiceTranscript(transcript: string): void {
  if (voiceIPCResolve) {
    voiceIPCResolve(transcript);
    voiceIPCResolve = null;
  }
}

/**
 * Request voice listening via renderer IPC.
 * The renderer uses Web Speech API and sends transcript back.
 */
async function listenViaRenderer(timeoutMs: number = 30000): Promise<string> {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win) return '(no window available for voice input)';

  win.webContents.send('voice:startListening');

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      win.webContents.send('voice:stopListening');
      voiceIPCResolve = null;
      resolve('(voice listening timed out)');
    }, timeoutMs);

    voiceIPCResolve = (transcript) => {
      clearTimeout(timer);
      resolve(transcript);
    };
  });
}

/**
 * Request TTS speech via renderer IPC.
 */
async function speakViaRenderer(text: string): Promise<void> {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win) return;
  win.webContents.send('voice:speak', text);
}

// ── Tool definitions ──

export function buildVoiceTools(): ToolDefinition[] {
  return [
    buildTool({
      name: 'voice_listen',
      description: [
        'Listen for speech input from the user\'s microphone.',
        'Returns the transcribed text. Uses Web Speech API or configured STT provider.',
        '',
        'Use when the user asks to speak or when voice input would be helpful.',
      ].join('\n'),
      inputSchema: z.object({
        timeout_seconds: z.number().min(5).max(120).optional()
          .describe('Max listening duration in seconds (default: 30)'),
        language: z.string().optional().describe('Language code, e.g., "en-US", "zh-CN"'),
      }),
      call: async (input) => {
        const stt = getActiveSTT();
        const timeoutMs = (input.timeout_seconds ?? 30) * 1000;

        try {
          let transcript: string;

          if (stt && stt.name !== 'web-speech') {
            // Use main-process STT provider (e.g., Deepgram)
            await stt.startListening({ language: input.language });
            await new Promise(r => setTimeout(r, timeoutMs));
            transcript = await stt.stopListening();
          } else {
            // Use renderer Web Speech API via IPC
            transcript = await listenViaRenderer(timeoutMs);
          }

          if (!transcript || transcript.startsWith('(')) {
            return { content: [{ type: 'text', text: transcript || '(no speech detected)' }] };
          }

          return { content: [{ type: 'text', text: `User said: "${transcript}"` }] };
        } catch (e) {
          return {
            content: [{ type: 'text', text: `Voice listening error: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          };
        }
      },
    }),

    buildTool({
      name: 'voice_speak',
      description: [
        'Speak text aloud to the user using text-to-speech.',
        'Uses system TTS or configured TTS provider (ElevenLabs, etc.).',
      ].join('\n'),
      inputSchema: z.object({
        text: z.string().min(1).describe('Text to speak aloud'),
        voice: z.string().optional().describe('Voice name or ID (provider-specific)'),
      }),
      call: async (input) => {
        const tts = getActiveTTS();

        try {
          if (tts && tts.name !== 'web-speech') {
            await tts.speak(input.text, { voice: input.voice });
          } else {
            await speakViaRenderer(input.text);
          }

          return { content: [{ type: 'text', text: `Spoke: "${input.text.slice(0, 100)}${input.text.length > 100 ? '...' : ''}"` }] };
        } catch (e) {
          return {
            content: [{ type: 'text', text: `Voice speak error: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          };
        }
      },
    }),

    buildTool({
      name: 'voice_set_provider',
      description: 'Switch the active STT or TTS provider.',
      inputSchema: z.object({
        stt_provider: z.string().optional().describe('STT provider name (e.g., "web-speech", "deepgram")'),
        tts_provider: z.string().optional().describe('TTS provider name (e.g., "web-speech", "elevenlabs")'),
      }),
      call: async (input) => {
        const results: string[] = [];
        if (input.stt_provider) {
          const ok = setActiveSTT(input.stt_provider);
          results.push(ok ? `STT: ${input.stt_provider}` : `STT provider "${input.stt_provider}" not found`);
        }
        if (input.tts_provider) {
          const ok = setActiveTTS(input.tts_provider);
          results.push(ok ? `TTS: ${input.tts_provider}` : `TTS provider "${input.tts_provider}" not found`);
        }
        if (results.length === 0) {
          const info = listProviders();
          results.push(
            `Available STT: ${info.stt.join(', ')} (active: ${info.activeSTT})`,
            `Available TTS: ${info.tts.join(', ')} (active: ${info.activeTTS})`
          );
        }
        return { content: [{ type: 'text', text: results.join('\n') }] };
      },
      isConcurrencySafe: true,
    }),
  ];
}
