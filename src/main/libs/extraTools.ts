/**
 * Extra Tools — registers media, search, link, and generation tools.
 * These supplement the core tools (task, agent, memory, browser, etc.)
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import { webFetchUrl } from './webFetch';
import { fetchLinkMetadata, formatLinkPreview } from './linkUnderstanding';
import { webSearch, type SearchResult } from './searchProvider';
import { describeImage, transcribeAudio, describeVideo, detectMediaType } from './mediaUnderstanding';
import { generateMedia, listProviders } from './mediaGeneration';
import { convertImage, resizeImage, convertAudio, getMediaInfo, downloadMedia } from './mediaPipeline';
import { startTranscription, stopTranscription, isTranscribing, getCurrentTranscript, feedAudioData } from './realtimeTranscription';

export function buildExtraTools(): ToolDefinition[] {
  return [
    // ── Web fetch with link preview ──
    buildTool({
      name: 'web_fetch',
      description: [
        'Fetch a URL and return its content. For HTML pages, converts to readable text.',
        'Also extracts metadata (title, description, og:image).',
        'Use for: reading articles, checking APIs, downloading data.',
      ].join('\n'),
      inputSchema: z.object({
        url: z.string().min(1).describe('URL to fetch'),
        include_metadata: z.boolean().optional().describe('Include og: metadata (default: true)'),
      }),
      call: async (input) => {
        const result = await webFetchUrl(input.url, { includeMetadata: input.include_metadata });
        const parts = [`Status: ${result.status}`, `Type: ${result.contentType}`, `Size: ${result.byteSize} bytes`];
        if (result.metadata) parts.push('', formatLinkPreview(result.metadata));
        parts.push('', '---', '', result.content.slice(0, 50000));
        return { content: [{ type: 'text', text: parts.join('\n') }], isError: !!result.error };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── Link preview ──
    buildTool({
      name: 'link_preview',
      description: 'Get metadata preview for a URL (title, description, image, favicon) without fetching full content.',
      inputSchema: z.object({
        url: z.string().min(1),
      }),
      call: async (input) => {
        const meta = await fetchLinkMetadata(input.url);
        return { content: [{ type: 'text', text: formatLinkPreview(meta) }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── Web search ──
    buildTool({
      name: 'web_search',
      description: [
        'Search the web using configured search engine (DuckDuckGo/Brave/Tavily/SearXNG).',
        'Returns titles, URLs, and snippets.',
      ].join('\n'),
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query'),
        max_results: z.number().min(1).max(20).optional().describe('Max results (default: 10)'),
      }),
      call: async (input) => {
        const results = await webSearch(input.query, input.max_results ?? 10);
        if (results.length === 0) return { content: [{ type: 'text', text: 'No results found.' }] };
        const lines = results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`);
        return { content: [{ type: 'text', text: `Search results (${results.length}):\n\n${lines.join('\n\n')}` }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── Image description ──
    buildTool({
      name: 'describe_image',
      description: 'Analyze an image file and describe its contents using vision AI.',
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Path to image file'),
        prompt: z.string().optional().describe('Specific question about the image'),
      }),
      call: async (input) => {
        const desc = await describeImage(input.file_path, input.prompt);
        return { content: [{ type: 'text', text: desc }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── Audio transcription ──
    buildTool({
      name: 'transcribe_audio',
      description: 'Transcribe an audio file to text using Whisper or configured STT provider.',
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Path to audio file'),
        language: z.string().optional().describe('Language code (e.g., "en", "zh")'),
      }),
      call: async (input) => {
        const text = await transcribeAudio(input.file_path, input.language);
        return { content: [{ type: 'text', text: text || '(no transcript)' }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── Video description ──
    buildTool({
      name: 'describe_video',
      description: 'Analyze a video file by extracting key frames and describing them.',
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Path to video file'),
        max_frames: z.number().min(1).max(10).optional().describe('Frames to analyze (default: 3)'),
      }),
      call: async (input) => {
        const desc = await describeVideo(input.file_path, input.max_frames);
        return { content: [{ type: 'text', text: desc }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── Media conversion ──
    buildTool({
      name: 'convert_media',
      description: 'Convert image/audio format or resize an image.',
      inputSchema: z.object({
        file_path: z.string().min(1),
        action: z.enum(['convert_image', 'resize_image', 'convert_audio', 'get_info']),
        format: z.string().optional().describe('Target format (e.g., "jpeg", "png", "mp3", "wav")'),
        max_width: z.number().optional().describe('Max width for resize'),
        max_height: z.number().optional().describe('Max height for resize'),
      }),
      call: async (input) => {
        if (input.action === 'get_info') {
          const info = getMediaInfo(input.file_path);
          return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
        }
        if (input.action === 'convert_image') {
          const out = convertImage(input.file_path, (input.format || 'jpeg') as any);
          return { content: [{ type: 'text', text: out ? `Converted: ${out}` : 'Conversion failed' }], isError: !out };
        }
        if (input.action === 'resize_image') {
          const out = resizeImage(input.file_path, input.max_width || 1024, input.max_height || 1024);
          return { content: [{ type: 'text', text: out ? `Resized: ${out}` : 'Resize failed' }], isError: !out };
        }
        if (input.action === 'convert_audio') {
          const out = convertAudio(input.file_path, (input.format || 'mp3') as any);
          return { content: [{ type: 'text', text: out ? `Converted: ${out}` : 'Conversion failed (install ffmpeg)' }], isError: !out };
        }
        return { content: [{ type: 'text', text: 'Unknown action' }], isError: true };
      },
    }),

    // ── Media download ──
    buildTool({
      name: 'download_media',
      description: 'Download a media file from a URL to a local temp path.',
      inputSchema: z.object({
        url: z.string().min(1),
        extension: z.string().optional().describe('File extension hint (e.g., "jpg", "mp3")'),
      }),
      call: async (input) => {
        const path = await downloadMedia(input.url, input.extension);
        return {
          content: [{ type: 'text', text: path ? `Downloaded: ${path}` : 'Download failed' }],
          isError: !path,
        };
      },
    }),

    // ── Image/music generation ──
    buildTool({
      name: 'generate_media',
      description: [
        'Generate an image or audio using AI (DALL-E, etc.).',
        'Configure providers in settings. Use list_providers to see available options.',
      ].join('\n'),
      inputSchema: z.object({
        type: z.enum(['image', 'video', 'music']),
        prompt: z.string().min(1).describe('Generation prompt'),
        provider: z.string().optional().describe('Provider name (auto-selects if omitted)'),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
      call: async (input) => {
        const result = await generateMedia(input.type, {
          prompt: input.prompt,
          width: input.width,
          height: input.height,
        }, input.provider);
        if (result.success) {
          return { content: [{ type: 'text', text: `Generated: ${result.filePath || result.url} (${result.durationMs}ms)` }] };
        }
        return { content: [{ type: 'text', text: `Generation failed: ${result.error}` }], isError: true };
      },
    }),

    // ── Realtime transcription control ──
    buildTool({
      name: 'realtime_transcribe',
      description: 'Start or stop real-time audio transcription (Deepgram WebSocket).',
      inputSchema: z.object({
        action: z.enum(['start', 'stop', 'status']),
        provider: z.string().optional().describe('STT provider (default: deepgram)'),
        language: z.string().optional(),
      }),
      call: async (input) => {
        if (input.action === 'status') {
          return {
            content: [{
              type: 'text',
              text: isTranscribing()
                ? `Transcribing... Current: "${getCurrentTranscript().slice(-200)}"`
                : 'Not transcribing.',
            }],
          };
        }
        if (input.action === 'start') {
          const ok = await startTranscription({
            provider: (input.provider as any) || 'deepgram',
            language: input.language,
          }, (result) => {
            // Results handled internally
          });
          return { content: [{ type: 'text', text: ok ? 'Transcription started.' : 'Failed to start.' }], isError: !ok };
        }
        if (input.action === 'stop') {
          const transcript = await stopTranscription();
          return { content: [{ type: 'text', text: transcript || '(no transcript)' }] };
        }
        return { content: [{ type: 'text', text: 'Unknown action' }], isError: true };
      },
    }),
  ];
}
