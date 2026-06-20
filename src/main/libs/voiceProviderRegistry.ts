/**
 * Voice Provider Registry — manages STT/TTS providers.
 * Ported from OpenClaw src/realtime-voice/provider-registry.ts
 *
 * Providers:
 * - Web Speech API (built-in, runs in renderer via IPC)
 * - ElevenLabs TTS (optional, API key)
 * - Deepgram STT (optional, API key)
 */

import { coworkLog } from './coworkLogger';

// ── Provider interface ──

export interface VoiceProvider {
  name: string;
  type: 'stt' | 'tts' | 'both';
  isAvailable(): boolean;
  init?(): Promise<void>;
  dispose?(): void;
}

export interface STTProvider extends VoiceProvider {
  type: 'stt' | 'both';
  startListening(options?: { language?: string }): Promise<void>;
  stopListening(): Promise<string>; // Returns transcript
  isListening(): boolean;
}

export interface TTSProvider extends VoiceProvider {
  type: 'tts' | 'both';
  speak(text: string, options?: { voice?: string; speed?: number }): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
}

// ── Registry ──

const sttProviders = new Map<string, STTProvider>();
const ttsProviders = new Map<string, TTSProvider>();
let activeSTT: string = 'web-speech';
let activeTTS: string = 'web-speech';

export function registerSTTProvider(provider: STTProvider): void {
  sttProviders.set(provider.name, provider);
  coworkLog('INFO', 'voiceRegistry', `STT provider registered: ${provider.name}`);
}

export function registerTTSProvider(provider: TTSProvider): void {
  ttsProviders.set(provider.name, provider);
  coworkLog('INFO', 'voiceRegistry', `TTS provider registered: ${provider.name}`);
}

export function getActiveSTT(): STTProvider | null {
  return sttProviders.get(activeSTT) ?? null;
}

export function getActiveTTS(): TTSProvider | null {
  return ttsProviders.get(activeTTS) ?? null;
}

export function setActiveSTT(name: string): boolean {
  if (!sttProviders.has(name)) return false;
  activeSTT = name;
  return true;
}

export function setActiveTTS(name: string): boolean {
  if (!ttsProviders.has(name)) return false;
  activeTTS = name;
  return true;
}

export function listProviders(): { stt: string[]; tts: string[]; activeSTT: string; activeTTS: string } {
  return {
    stt: Array.from(sttProviders.keys()),
    tts: Array.from(ttsProviders.keys()),
    activeSTT,
    activeTTS,
  };
}
