/**
 * Media Understanding — image description, audio transcription, video summarization.
 * Uses LLM vision API for images, Whisper/Deepgram for audio.
 *
 * Reference: OpenClaw src/media-understanding/ (8 files)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { coworkLog } from './coworkLogger';
import { getCurrentApiConfig } from './claudeSettings';
import { createMessage, getAnthropicClient } from './anthropicClient';
import { extractVideoFrame, getAudioDuration } from './mediaPipeline';

// ── Image understanding (via Claude vision) ──

export async function describeImage(imagePath: string, prompt?: string): Promise<string> {
  if (!fs.existsSync(imagePath)) return `Image not found: ${imagePath}`;

  const ext = path.extname(imagePath).toLowerCase().slice(1);
  const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const mediaType = mimeMap[ext] || 'image/jpeg';

  const data = fs.readFileSync(imagePath);
  if (data.length > 10 * 1024 * 1024) return 'Image too large (>10MB)';

  const base64 = data.toString('base64');
  const apiConfig = getCurrentApiConfig();
  if (!apiConfig?.apiKey) return 'No API key configured for image understanding';

  try {
    const client = getAnthropicClient({
      apiKey: apiConfig.apiKey,
      baseUrl: apiConfig.baseURL,
      model: apiConfig.model || 'claude-sonnet-4-20250514',
    });

    const response = await createMessage({
      client,
      model: apiConfig.model || 'claude-sonnet-4-20250514',
      systemPrompt: 'Describe the image concisely. Focus on key content, text, and important visual elements.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType as any, data: base64 } },
          { type: 'text', text: prompt || 'Describe this image.' },
        ],
      }],
      tools: [],
      maxTokens: 1024,
    });

    return response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('') || 'No description generated';
  } catch (e) {
    return `Image analysis error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── Audio transcription (via Whisper API or local) ──

export async function transcribeAudio(audioPath: string, language?: string, format: 'text' | 'srt' = 'text'): Promise<string> {
  if (!fs.existsSync(audioPath)) return `Audio not found: ${audioPath}`;

  // Try OpenAI Whisper API first
  const apiConfig = getCurrentApiConfig();
  const providerName = (apiConfig as any)?.providerName || '';

  if (providerName === 'openai' && apiConfig?.apiKey) {
    try {
      return await transcribeViaWhisperAPI(audioPath, apiConfig.apiKey, apiConfig.baseURL, language, format);
    } catch (e) {
      coworkLog('WARN', 'mediaUnderstanding', `Whisper API failed, trying local: ${e}`);
    }
  }

  // Fallback: local whisper CLI
  try {
    return transcribeViaLocalWhisper(audioPath, language, format);
  } catch {
    return 'Transcription not available (no Whisper API key or local whisper)';
  }
}

async function transcribeViaWhisperAPI(audioPath: string, apiKey: string, baseUrl?: string, language?: string, format: 'text' | 'srt' = 'text'): Promise<string> {
  const url = `${baseUrl || 'https://api.openai.com'}/v1/audio/transcriptions`;
  const fileData = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath).slice(1);

  // Build multipart form
  const boundary = '----NoobClawBoundary' + Date.now();
  const parts: Buffer[] = [];

  // File part
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: audio/${ext}\r\n\r\n`));
  parts.push(fileData);
  parts.push(Buffer.from('\r\n'));

  // Model part
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));

  // Language part
  if (language) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`));
  }

  // response_format part — 'srt' makes the API return ready-to-use SubRip text
  // (with timestamps) directly as the body, instead of JSON {text}. Used for the
  // 视频下载「字幕」派生输出。Default (text) keeps the original JSON path.
  if (format === 'srt') {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nsrt\r\n`));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) throw new Error(`Whisper API: ${response.status}`);
  // srt 模式下响应体本身就是 SubRip 文本(非 JSON),直接返回。
  if (format === 'srt') return (await response.text()).trim();
  const data = await response.json();
  return data.text || '';
}

function transcribeViaLocalWhisper(audioPath: string, language?: string, format: 'text' | 'srt' = 'text'): string {
  const langArg = language ? `--language ${language}` : '';
  const ext = format === 'srt' ? 'srt' : 'txt';
  const result = execSync(`whisper "${audioPath}" ${langArg} --output_format ${ext} --output_dir /tmp`, {
    encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  // Read the output file (.srt or .txt)
  const baseName = path.basename(audioPath, path.extname(audioPath));
  const outPath = `/tmp/${baseName}.${ext}`;
  if (fs.existsSync(outPath)) {
    const text = fs.readFileSync(outPath, 'utf8').trim();
    try { fs.unlinkSync(outPath); } catch {}
    return text;
  }
  return result.trim();
}

// ── Video understanding (extract frames + describe) ──

export async function describeVideo(videoPath: string, maxFrames: number = 3): Promise<string> {
  if (!fs.existsSync(videoPath)) return `Video not found: ${videoPath}`;

  const duration = getAudioDuration(videoPath);
  const descriptions: string[] = [];

  // Extract frames at evenly spaced intervals
  const times = duration && duration > 1
    ? Array.from({ length: maxFrames }, (_, i) => (duration * (i + 1)) / (maxFrames + 1))
    : [0];

  for (const time of times) {
    const framePath = extractVideoFrame(videoPath, time);
    if (framePath) {
      const desc = await describeImage(framePath, `Describe this video frame at ${Math.round(time)}s.`);
      descriptions.push(`[${Math.round(time)}s] ${desc}`);
      try { fs.unlinkSync(framePath); } catch {}
    }
  }

  if (descriptions.length === 0) return 'Could not extract video frames (install ffmpeg)';

  return [
    duration ? `Video duration: ${Math.round(duration)}s` : '',
    `Frame descriptions:`,
    ...descriptions,
  ].filter(Boolean).join('\n');
}

// ── Detect media type from file ──

export function detectMediaType(filePath: string): 'image' | 'audio' | 'video' | 'unknown' {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'opus', 'flac', 'aac', 'm4a', 'wma'].includes(ext)) return 'audio';
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'wmv'].includes(ext)) return 'video';
  return 'unknown';
}
