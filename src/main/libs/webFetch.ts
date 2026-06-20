/**
 * Web Fetch — enhanced HTTP fetch with link understanding integration.
 * Provides URL fetching with automatic metadata extraction,
 * content type detection, and Markdown conversion for HTML pages.
 *
 * Reference: OpenClaw src/web-fetch/runtime.ts
 */

import { coworkLog } from './coworkLogger';
import { fetchLinkMetadata, formatLinkPreview, type LinkMetadata } from './linkUnderstanding';

// ── Types ──

export interface WebFetchResult {
  url: string;
  status: number;
  contentType: string;
  content: string;          // Body text or Markdown conversion
  metadata?: LinkMetadata;  // Link preview metadata
  byteSize: number;
  fetchedAt: number;
  error?: string;
}

export interface WebFetchOptions {
  maxSizeBytes?: number;      // Default: 5MB
  timeoutMs?: number;         // Default: 30s
  includeMetadata?: boolean;  // Also fetch og: metadata (default: true)
  convertToMarkdown?: boolean;// Convert HTML to Markdown-ish text (default: true)
  userAgent?: string;
  headers?: Record<string, string>;
}

const DEFAULT_OPTIONS: Required<WebFetchOptions> = {
  maxSizeBytes: 5 * 1024 * 1024,
  timeoutMs: 30_000,
  includeMetadata: true,
  convertToMarkdown: true,
  userAgent: 'NoobClaw/1.0 (AI Assistant)',
  headers: {},
};

// ── Main fetch ──

export async function webFetchUrl(url: string, options?: WebFetchOptions): Promise<WebFetchResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const fetchedAt = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    // Fetch metadata in parallel if requested
    const metadataPromise = opts.includeMetadata
      ? fetchLinkMetadata(url, 5000).catch((): null => null)
      : Promise.resolve(null);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': opts.userAgent,
        'Accept': 'text/html, application/json, text/plain, */*',
        ...opts.headers,
      },
      redirect: 'follow',
    });

    clearTimeout(timer);

    const contentType = response.headers.get('content-type') || '';
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

    // Size check
    if (contentLength > opts.maxSizeBytes) {
      return {
        url, status: response.status, contentType,
        content: `Response too large: ${contentLength} bytes (max: ${opts.maxSizeBytes})`,
        byteSize: contentLength, fetchedAt, error: 'too_large',
      };
    }

    // Read body
    const buffer = await response.arrayBuffer();
    const byteSize = buffer.byteLength;

    if (byteSize > opts.maxSizeBytes) {
      return {
        url, status: response.status, contentType,
        content: `Response too large: ${byteSize} bytes`,
        byteSize, fetchedAt, error: 'too_large',
      };
    }

    const rawText = new TextDecoder().decode(buffer);
    let content = rawText;

    // Convert HTML to readable text
    if (opts.convertToMarkdown && contentType.includes('text/html')) {
      content = htmlToReadableText(rawText);
    }

    // Truncate if still too long
    if (content.length > 100_000) {
      content = content.slice(0, 100_000) + '\n\n[Content truncated at 100KB]';
    }

    const metadata = await metadataPromise;

    return {
      url, status: response.status, contentType, content,
      metadata: metadata || undefined,
      byteSize, fetchedAt,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return {
      url, status: 0, contentType: '', content: `Fetch error: ${errMsg}`,
      byteSize: 0, fetchedAt, error: errMsg,
    };
  }
}

// ── Batch fetch ──

export async function webFetchMultiple(
  urls: string[],
  options?: WebFetchOptions
): Promise<WebFetchResult[]> {
  return Promise.all(urls.map(url => webFetchUrl(url, options)));
}

// ── HTML to readable text conversion ──

function htmlToReadableText(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Convert common elements to Markdown-ish format
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
