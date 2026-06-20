/**
 * Realtime Transcription — continuous speech-to-text processing.
 * Wraps Deepgram/Whisper WebSocket for live audio streams.
 *
 * Reference: OpenClaw src/realtime-transcription/
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export type TranscriptionProvider = 'deepgram' | 'whisper-stream' | 'web-speech';

export interface TranscriptionConfig {
  provider: TranscriptionProvider;
  apiKey?: string;
  language?: string;
  model?: string;          // Provider-specific model name
  interimResults?: boolean; // Emit partial results
  punctuate?: boolean;
  smartFormat?: boolean;
}

export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  confidence: number;
  language?: string;
  durationMs?: number;
  words?: Array<{ word: string; start: number; end: number; confidence: number }>;
}

export type TranscriptionCallback = (result: TranscriptionResult) => void;

// ── State ──

let activeSession: TranscriptionSession | null = null;

interface TranscriptionSession {
  config: TranscriptionConfig;
  ws: any;
  callback: TranscriptionCallback;
  transcript: string;
  startedAt: number;
  isActive: boolean;
}

// ── Start/Stop ──

export async function startTranscription(
  config: TranscriptionConfig,
  callback: TranscriptionCallback
): Promise<boolean> {
  if (activeSession?.isActive) {
    coworkLog('WARN', 'realtimeTranscription', 'Already transcribing, stop first');
    return false;
  }

  const session: TranscriptionSession = {
    config,
    ws: null,
    callback,
    transcript: '',
    startedAt: Date.now(),
    isActive: false,
  };

  try {
    switch (config.provider) {
      case 'deepgram':
        await startDeepgramSession(session);
        break;
      case 'web-speech':
        // Web Speech runs in renderer, not here
        coworkLog('INFO', 'realtimeTranscription', 'Web Speech API runs in renderer via IPC');
        session.isActive = true;
        break;
      default:
        throw new Error(`Unknown transcription provider: ${config.provider}`);
    }

    activeSession = session;
    return true;
  } catch (e) {
    coworkLog('ERROR', 'realtimeTranscription', `Start failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function stopTranscription(): Promise<string> {
  if (!activeSession) return '';

  const transcript = activeSession.transcript;

  if (activeSession.ws) {
    try { activeSession.ws.close(); } catch {}
  }
  activeSession.isActive = false;
  activeSession = null;

  coworkLog('INFO', 'realtimeTranscription', `Stopped, transcript length: ${transcript.length}`);
  return transcript;
}

export function isTranscribing(): boolean {
  return activeSession?.isActive ?? false;
}

export function getCurrentTranscript(): string {
  return activeSession?.transcript ?? '';
}

/**
 * Feed raw audio data to the transcription session.
 * Used when audio comes from a separate capture source.
 */
export function feedAudioData(data: Buffer): void {
  if (!activeSession?.isActive || !activeSession.ws) return;
  try {
    if (activeSession.ws.readyState === 1) { // OPEN
      activeSession.ws.send(data);
    }
  } catch {}
}

// ── Deepgram WebSocket session ──

async function startDeepgramSession(session: TranscriptionSession): Promise<void> {
  if (!session.config.apiKey) throw new Error('Deepgram API key required');

  const params = new URLSearchParams({
    model: session.config.model || 'nova-2',
    language: session.config.language || 'en',
    punctuate: String(session.config.punctuate !== false),
    smart_format: String(session.config.smartFormat !== false),
    interim_results: String(session.config.interimResults !== false),
  });

  const url = `wss://api.deepgram.com/v1/listen?${params}`;
  const WebSocket = require('ws');

  session.ws = new WebSocket(url, {
    headers: { Authorization: `Token ${session.config.apiKey}` },
  });

  return new Promise((resolve, reject) => {
    session.ws.on('open', () => {
      session.isActive = true;
      coworkLog('INFO', 'realtimeTranscription', 'Deepgram session started');
      resolve();
    });

    session.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.channel?.alternatives?.[0]) {
          const alt = msg.channel.alternatives[0];
          const result: TranscriptionResult = {
            text: alt.transcript || '',
            isFinal: msg.is_final === true,
            confidence: alt.confidence || 0,
            language: msg.channel?.detected_language,
            words: alt.words,
          };

          if (result.isFinal && result.text) {
            session.transcript += (session.transcript ? ' ' : '') + result.text;
          }

          session.callback(result);
        }
      } catch {}
    });

    session.ws.on('error', (err: Error) => {
      coworkLog('ERROR', 'realtimeTranscription', `Deepgram error: ${err.message}`);
      if (!session.isActive) reject(err);
    });

    session.ws.on('close', () => {
      session.isActive = false;
    });

    setTimeout(() => {
      if (!session.isActive) reject(new Error('Connection timeout'));
    }, 10000);
  });
}
