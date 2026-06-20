/**
 * ElevenLabs TTS Provider — high-quality text-to-speech via ElevenLabs API.
 * Reference: OpenClaw extensions/elevenlabs/
 */

import type { TTSProvider } from '../voiceProviderRegistry';
import { coworkLog } from '../coworkLogger';

let apiKey: string | null = null;
let speaking = false;
let currentAudio: any = null;

export function configureElevenLabs(key: string): void {
  apiKey = key;
  coworkLog('INFO', 'elevenLabs', 'ElevenLabs TTS configured');
}

export const elevenLabsProvider: TTSProvider = {
  name: 'elevenlabs',
  type: 'tts',

  isAvailable(): boolean {
    return !!apiKey;
  },

  async speak(text: string, options?: { voice?: string; speed?: number }): Promise<void> {
    if (!apiKey) throw new Error('ElevenLabs API key not configured');

    const voiceId = options?.voice || '21m00Tcm4TlvDq8ikWAM'; // Default: Rachel
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    speaking = true;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
        },
        body: JSON.stringify({
          text: text.slice(0, 5000),
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });

      if (!response.ok) throw new Error(`ElevenLabs API: ${response.status}`);

      const audioBuffer = await response.arrayBuffer();
      // Save to temp file for playback
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const tmpPath = path.join(os.tmpdir(), `noobclaw-tts-${Date.now()}.mp3`);
      fs.writeFileSync(tmpPath, Buffer.from(audioBuffer));

      // Play via system command
      if (process.platform === 'darwin') {
        const { execSync } = require('child_process');
        execSync(`afplay "${tmpPath}"`, { timeout: 60000 });
      } else if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        execSync(`powershell -NoProfile -Command "(New-Object Media.SoundPlayer '${tmpPath}').PlaySync()"`, { timeout: 60000 });
      }

      // Cleanup
      try { fs.unlinkSync(tmpPath); } catch {}
    } finally {
      speaking = false;
    }
  },

  stop(): void {
    speaking = false;
    // Kill any running playback process
  },

  isSpeaking(): boolean {
    return speaking;
  },
};
