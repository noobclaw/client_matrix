/**
 * Link Understanding — URL metadata extraction and preview.
 * Fetches title, description, og:image, favicon from URLs.
 *
 * Reference: OpenClaw src/link-understanding/
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export interface LinkMetadata {
  url: string;
  title: string;
  description: string;
  siteName: string;
  image: string | null;       // og:image URL
  favicon: string | null;
  type: string;               // og:type (article, website, video, etc.)
  author: string | null;
  publishedDate: string | null;
  contentLength: number | null;
  contentType: string;
  fetchedAt: number;
}

// ── Cache ──

const cache = new Map<string, { data: LinkMetadata; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Main function ──

export async function fetchLinkMetadata(url: string, timeoutMs: number = 10000): Promise<LinkMetadata> {
  // Check cache
  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const metadata: LinkMetadata = {
    url,
    title: '',
    description: '',
    siteName: '',
    image: null,
    favicon: null,
    type: 'website',
    author: null,
    publishedDate: null,
    contentLength: null,
    contentType: '',
    fetchedAt: Date.now(),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'NoobClaw/1.0 (Link Preview)',
        'Accept': 'text/html, application/xhtml+xml',
      },
      redirect: 'follow',
    });

    clearTimeout(timer);

    metadata.contentType = response.headers.get('content-type') || '';
    const cl = response.headers.get('content-length');
    if (cl) metadata.contentLength = parseInt(cl, 10);

    // Only parse HTML for metadata
    if (!metadata.contentType.includes('text/html') && !metadata.contentType.includes('xhtml')) {
      metadata.title = new URL(url).hostname;
      cache.set(url, { data: metadata, expiresAt: Date.now() + CACHE_TTL_MS });
      return metadata;
    }

    // Read first 50KB of HTML (enough for <head>)
    const reader = response.body?.getReader();
    if (!reader) {
      cache.set(url, { data: metadata, expiresAt: Date.now() + CACHE_TTL_MS });
      return metadata;
    }

    let html = '';
    const decoder = new TextDecoder();
    let bytesRead = 0;
    const maxBytes = 50_000;

    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytesRead += value?.length || 0;
      // Stop once we've seen </head>
      if (html.includes('</head>')) break;
    }
    reader.cancel().catch(() => {});

    // Extract metadata from HTML
    metadata.title = extractMeta(html, 'og:title') || extractTag(html, 'title') || '';
    metadata.description = extractMeta(html, 'og:description') || extractMeta(html, 'description') || '';
    metadata.siteName = extractMeta(html, 'og:site_name') || '';
    metadata.image = extractMeta(html, 'og:image') || null;
    metadata.type = extractMeta(html, 'og:type') || 'website';
    metadata.author = extractMeta(html, 'author') || extractMeta(html, 'article:author') || null;
    metadata.publishedDate = extractMeta(html, 'article:published_time') || extractMeta(html, 'date') || null;

    // Extract favicon
    const faviconMatch = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i);
    if (faviconMatch) {
      metadata.favicon = resolveUrl(faviconMatch[1], url);
    } else {
      metadata.favicon = new URL('/favicon.ico', url).href;
    }

    // Resolve relative image URLs
    if (metadata.image && !metadata.image.startsWith('http')) {
      metadata.image = resolveUrl(metadata.image, url);
    }

  } catch (e) {
    coworkLog('WARN', 'linkUnderstanding', `Failed to fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
    metadata.title = new URL(url).hostname;
  }

  cache.set(url, { data: metadata, expiresAt: Date.now() + CACHE_TTL_MS });
  return metadata;
}

/**
 * Extract metadata from multiple URLs in parallel.
 */
export async function fetchMultipleLinkMetadata(urls: string[]): Promise<LinkMetadata[]> {
  return Promise.all(urls.map(url => fetchLinkMetadata(url)));
}

/**
 * Format metadata as a human-readable summary.
 */
export function formatLinkPreview(meta: LinkMetadata): string {
  const parts = [`**${meta.title || meta.url}**`];
  if (meta.siteName) parts.push(`Site: ${meta.siteName}`);
  if (meta.description) parts.push(meta.description.slice(0, 200));
  if (meta.author) parts.push(`By: ${meta.author}`);
  if (meta.publishedDate) parts.push(`Published: ${meta.publishedDate}`);
  if (meta.type !== 'website') parts.push(`Type: ${meta.type}`);
  parts.push(`URL: ${meta.url}`);
  return parts.join('\n');
}

// ── HTML parsing helpers ──

function extractMeta(html: string, name: string): string {
  // Try property="..." first (Open Graph)
  const ogMatch = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegex(name)}["'][^>]+content=["']([^"']*)["']`, 'i'));
  if (ogMatch) return decodeHtmlEntities(ogMatch[1]);
  // Try content="..." property="..." order
  const reverseMatch = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escapeRegex(name)}["']`, 'i'));
  if (reverseMatch) return decodeHtmlEntities(reverseMatch[1]);
  return '';
}

function extractTag(html: string, tag: string): string {
  const match = html.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return match ? decodeHtmlEntities(match[1].trim()) : '';
}

function resolveUrl(relative: string, base: string): string {
  try { return new URL(relative, base).href; } catch { return relative; }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

// ── Cache management ──

export function clearLinkCache(): void {
  cache.clear();
}

export function getLinkCacheSize(): number {
  return cache.size;
}
