/**
 * Search Provider — multi-engine web search abstraction.
 * Reference: OpenClaw extensions/ (brave, duckduckgo, exa, tavily, searxng)
 *
 * Supports: DuckDuckGo (free, no API key), Brave, Tavily, SearXNG
 * Falls back gracefully: configured provider → DuckDuckGo → error
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export type SearchProviderType = 'duckduckgo' | 'brave' | 'tavily' | 'searxng' | 'auto';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchConfig {
  provider: SearchProviderType;
  braveApiKey?: string;
  tavilyApiKey?: string;
  searxngUrl?: string;    // e.g., "https://searx.example.com"
}

let config: SearchConfig = { provider: 'auto' };

// ── Configure ──

export function configureSearch(cfg: Partial<SearchConfig>): void {
  config = { ...config, ...cfg };
  coworkLog('INFO', 'searchProvider', `Configured: ${config.provider}`);
}

// ── Main search function ──

export async function webSearch(query: string, maxResults: number = 10): Promise<SearchResult[]> {
  const provider = resolveProvider();

  try {
    switch (provider) {
      case 'brave': return await searchBrave(query, maxResults);
      case 'tavily': return await searchTavily(query, maxResults);
      case 'searxng': return await searchSearXNG(query, maxResults);
      case 'duckduckgo':
      default: return await searchDuckDuckGo(query, maxResults);
    }
  } catch (e) {
    coworkLog('WARN', 'searchProvider', `${provider} failed: ${e}, trying fallback`);
    // Fallback to DuckDuckGo
    if (provider !== 'duckduckgo') {
      try { return await searchDuckDuckGo(query, maxResults); } catch {}
    }
    return [];
  }
}

function resolveProvider(): SearchProviderType {
  if (config.provider !== 'auto') return config.provider;
  if (config.braveApiKey) return 'brave';
  if (config.tavilyApiKey) return 'tavily';
  if (config.searxngUrl) return 'searxng';
  return 'duckduckgo';
}

// ── DuckDuckGo (free, no API key) ──

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  // Use DuckDuckGo instant answer API + HTML search
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'NoobClaw/1.0 (AI Assistant)' },
  });

  if (!response.ok) throw new Error(`DDG: ${response.status}`);

  const html = await response.text();
  const results: SearchResult[] = [];

  // Parse result links from HTML
  const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let linkMatch;
  const links: Array<{ url: string; title: string }> = [];
  while ((linkMatch = linkRegex.exec(html)) && links.length < maxResults) {
    let href = linkMatch[1];
    // DDG wraps URLs in redirect
    const uddg = href.match(/uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    links.push({ url: href, title: linkMatch[2].replace(/<[^>]+>/g, '').trim() });
  }

  let snippetMatch;
  const snippets: string[] = [];
  while ((snippetMatch = snippetRegex.exec(html))) {
    snippets.push(snippetMatch[1].replace(/<[^>]+>/g, '').trim());
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || '',
      source: 'duckduckgo',
    });
  }

  return results;
}

// ── Brave Search API ──

async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  if (!config.braveApiKey) throw new Error('Brave API key not configured');

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const response = await fetch(url, {
    headers: {
      'X-Subscription-Token': config.braveApiKey,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) throw new Error(`Brave: ${response.status}`);
  const data = await response.json();

  return (data.web?.results || []).slice(0, maxResults).map((r: any) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.description || '',
    source: 'brave',
  }));
}

// ── Tavily Search API ──

async function searchTavily(query: string, maxResults: number): Promise<SearchResult[]> {
  if (!config.tavilyApiKey) throw new Error('Tavily API key not configured');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
  });

  if (!response.ok) throw new Error(`Tavily: ${response.status}`);
  const data = await response.json();

  return (data.results || []).slice(0, maxResults).map((r: any) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
    source: 'tavily',
  }));
}

// ── SearXNG (self-hosted) ──

async function searchSearXNG(query: string, maxResults: number): Promise<SearchResult[]> {
  if (!config.searxngUrl) throw new Error('SearXNG URL not configured');

  const url = `${config.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
  const response = await fetch(url);

  if (!response.ok) throw new Error(`SearXNG: ${response.status}`);
  const data = await response.json();

  return (data.results || []).slice(0, maxResults).map((r: any) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
    source: 'searxng',
  }));
}
