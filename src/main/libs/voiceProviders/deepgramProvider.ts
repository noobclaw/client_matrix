/**
 * Deepgram STT Provider — real-time speech-to-text via Deepgram WebSocket API.
 * Reference: OpenClaw extensions/deepgram/
 */

import type { STTProvider } from '../voiceProviderRegistry';
import { coworkLog } from '../coworkLogger';

let apiKey: string | null = null;
let ws: any = null;
let listening = false;
let transcript = '';

export function configureDeepgram(key: string): void {
  apiKey = key;
  coworkLog('INFO', 'deepgram', 'Deepgram STT configured');
}

export const deepgramProvider: STTProvider = {
  name: 'deepgram',
  type: 'stt',

  isAvailable(): boolean {
    return !!apiKey;
  },

  async startListening(options?: { language?: string }): Promise<void> {
    if (!apiKey) throw new Error('Deepgram API key not configured');
    if (listening) return;

    const lang = options?.language || 'en';
    const url = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${lang}&punctuate=true&smart_format=true`;

    const WebSocket = require('ws');
    ws = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    transcript = '';
    listening = true;

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.channel?.alternatives?.[0]?.transcript) {
          const text = msg.channel.alternatives[0].transcript;
          if (msg.is_final) {
            transcript += (transcript ? ' ' : '') + text;
          }
        }
      } catch {}
    });

    ws.on('error', (err: Error) => {
      coworkLog('ERROR', 'deepgram', `WebSocket error: ${err.message}`);
    });

    ws.on('close', () => {
      listening = false;
    });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      setTimeout(() => reject(new Error('Deepgram connection timeout')), 10000);
    });

    coworkLog('INFO', 'deepgram', 'Listening started');

    // Start capturing microphone via system command
    // On macOS: use sox/rec, on Windows: use PowerShell audio capture
    startAudioCapture();
  },

  async stopListening(): Promise<string> {
    listening = false;
    stopAudioCapture();

    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }

    coworkLog('INFO', 'deepgram', `Stopped, transcript: ${transcript.slice(0, 100)}`);
    return transcript;
  },

  isListening(): boolean {
    return listening;
  },
};

// ── Audio capture helpers ──

let audioProcess: any = null;

function startAudioCapture(): void {
  if (!ws) return;

  const { spawn } = require('child_process');

  if (process.platform === 'darwin') {
    // Use sox/rec for macOS audio capture → pipe raw PCM to WebSocket
    audioProcess = spawn('rec', ['-q', '-r', '16000', '-e', 'signed', '-b', '16', '-c', '1', '-t', 'raw', '-'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } else if (process.platform === 'win32') {
    // PowerShell audio capture
    audioProcess = spawn('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Speech; $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine; $r.SetInputToDefaultAudioDevice(); $s = $r.AudioStream; $buf = New-Object byte[] 4096; while($true) { $n = $s.Read($buf, 0, 4096); if($n -gt 0) { [Console]::OpenStandardOutput().Write($buf, 0, $n) } }`
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
  }

  if (audioProcess?.stdout) {
    audioProcess.stdout.on('data', (chunk: Buffer) => {
      if (ws?.readyState === 1) { // WebSocket.OPEN
        ws.send(chunk);
      }
    });
  }
}

function stopAudioCapture(): void {
  if (audioProcess) {
    try { audioProcess.kill(); } catch {}
    audioProcess = null;
  }
}
