/**
 * Voice Init — registers all voice providers at startup.
 * Call once from bootstrap or main.ts.
 */

import { registerSTTProvider, registerTTSProvider } from './voiceProviderRegistry';
import { webSpeechSTTProvider, webSpeechTTSProvider } from './voiceProviders/webSpeechProvider';
import { systemTtsProvider } from './voiceProviders/systemTtsProvider';
import { elevenLabsProvider, configureElevenLabs } from './voiceProviders/elevenLabsProvider';
import { deepgramProvider, configureDeepgram } from './voiceProviders/deepgramProvider';
import { configManager } from './configManager';
import { coworkLog } from './coworkLogger';

export function initVoiceProviders(): void {
  // Always-available providers
  registerSTTProvider(webSpeechSTTProvider);
  registerTTSProvider(webSpeechTTSProvider);
  registerTTSProvider(systemTtsProvider);

  // Conditional providers (need API keys)
  // ElevenLabs TTS
  const elevenLabsKey = configManager.get('apiKey'); // Could use a dedicated config key
  if (elevenLabsKey) {
    // Only configure if user has explicitly set up ElevenLabs
    // For now, register as available but unconfigured
    registerTTSProvider(elevenLabsProvider);
  }

  // Deepgram STT
  registerSTTProvider(deepgramProvider);

  // Watch for config changes to reconfigure providers
  configManager.watch('sttProvider', (value) => {
    coworkLog('INFO', 'voiceInit', `STT provider changed to: ${value}`);
  });

  configManager.watch('ttsProvider', (value) => {
    coworkLog('INFO', 'voiceInit', `TTS provider changed to: ${value}`);
  });

  coworkLog('INFO', 'voiceInit', 'Voice providers initialized (2 STT, 3 TTS)');
}
