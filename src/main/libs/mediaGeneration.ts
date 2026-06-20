/**
 * Media Generation — unified pipeline for image/video/music generation.
 * Dispatches to configured providers (DALL-E, Stable Diffusion, Runway, etc.)
 *
 * Reference: OpenClaw src/image-generation/ + video-generation/ + music-generation/ + media-generation/
 */

import fs from 'fs';
import path from 'path';
import { coworkLog } from './coworkLogger';
import { createTempPath } from './mediaPipeline';

// ── Types ──

export type MediaGenType = 'image' | 'video' | 'music';

export interface MediaGenProvider {
  name: string;
  type: MediaGenType;
  isAvailable(): boolean;
  generate(params: MediaGenParams): Promise<MediaGenResult>;
}

export interface MediaGenParams {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;   // For video/music
  style?: string;
  seed?: number;
  model?: string;
}

export interface MediaGenResult {
  success: boolean;
  filePath?: string;
  url?: string;
  error?: string;
  provider: string;
  durationMs: number;
}

// ── Provider registry ──

const providers = new Map<string, MediaGenProvider>();

export function registerMediaGenProvider(provider: MediaGenProvider): void {
  providers.set(`${provider.type}:${provider.name}`, provider);
  coworkLog('INFO', 'mediaGeneration', `Registered ${provider.type} provider: ${provider.name}`);
}

export function getProvider(type: MediaGenType, name?: string): MediaGenProvider | null {
  if (name) return providers.get(`${type}:${name}`) ?? null;
  // Find first available provider for this type
  for (const [key, p] of providers) {
    if (key.startsWith(`${type}:`) && p.isAvailable()) return p;
  }
  return null;
}

export function listProviders(type?: MediaGenType): MediaGenProvider[] {
  const result: MediaGenProvider[] = [];
  for (const [key, p] of providers) {
    if (!type || key.startsWith(`${type}:`)) result.push(p);
  }
  return result;
}

// ── Main generation function ──

export async function generateMedia(type: MediaGenType, params: MediaGenParams, providerName?: string): Promise<MediaGenResult> {
  const provider = getProvider(type, providerName);
  if (!provider) {
    return { success: false, error: `No ${type} generation provider available`, provider: 'none', durationMs: 0 };
  }

  const start = Date.now();
  coworkLog('INFO', 'mediaGeneration', `Generating ${type} with ${provider.name}: "${params.prompt.slice(0, 100)}"`);

  try {
    const result = await provider.generate(params);
    result.durationMs = Date.now() - start;
    coworkLog('INFO', 'mediaGeneration', `${type} generated in ${result.durationMs}ms: ${result.filePath || result.url || '(no output)'}`);
    return result;
  } catch (e) {
    return {
      success: false,
      error: `Generation failed: ${e instanceof Error ? e.message : String(e)}`,
      provider: provider.name,
      durationMs: Date.now() - start,
    };
  }
}

// ── Built-in provider: OpenAI DALL-E (image) ──

export function createDalleProvider(apiKey: string, baseUrl?: string): MediaGenProvider {
  return {
    name: 'dall-e',
    type: 'image',
    isAvailable: () => !!apiKey,
    generate: async (params) => {
      const url = `${baseUrl || 'https://api.openai.com'}/v1/images/generations`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: params.model || 'dall-e-3',
          prompt: params.prompt,
          n: 1,
          size: `${params.width || 1024}x${params.height || 1024}`,
          response_format: 'b64_json',
        }),
      });

      if (!response.ok) throw new Error(`DALL-E API: ${response.status}`);
      const data = await response.json();
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error('No image data in response');

      const outPath = createTempPath('png');
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
      return { success: true, filePath: outPath, provider: 'dall-e', durationMs: 0 };
    },
  };
}

// ── Built-in provider: OpenAI TTS (could be used for music-like audio) ──

export function createOpenAIAudioProvider(apiKey: string, baseUrl?: string): MediaGenProvider {
  return {
    name: 'openai-audio',
    type: 'music',
    isAvailable: () => !!apiKey,
    generate: async (params) => {
      const url = `${baseUrl || 'https://api.openai.com'}/v1/audio/speech`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'tts-1',
          input: params.prompt,
          voice: params.style || 'alloy',
          response_format: 'mp3',
        }),
      });

      if (!response.ok) throw new Error(`OpenAI Audio API: ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const outPath = createTempPath('mp3');
      fs.writeFileSync(outPath, buffer);
      return { success: true, filePath: outPath, provider: 'openai-audio', durationMs: 0 };
    },
  };
}
