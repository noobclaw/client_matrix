/**
 * Local semantic search over user memories — uses Apple's Natural
 * Language framework (NLEmbedding) via the `.mm` native addon.
 *
 * Why this exists: `coworkStore.listUserMemories` sorts by updated_at
 * and returns the first N. That's fine for "show me my memories" but
 * terrible for "inject the most RELEVANT memories into the current
 * turn's prompt prefix". Relevance here is semantic, not temporal:
 * if the user is asking about their NPM workflow we want to surface
 * their NPM-related memories even if they're a month old, not their
 * most recent unrelated memory.
 *
 * Without this module the only option is round-tripping memories
 * through an LLM for relevance scoring — expensive and slow. With
 * NLEmbedding (Mac only, on-device, <10ms per text), we get 300-d
 * vectors for every memory + query and rank by cosine similarity.
 *
 * Fallbacks:
 *  - non-macOS: module returns null from all paths, caller falls
 *    through to the existing `updated_at DESC` ordering.
 *  - native addon not loaded: same.
 *  - empty query or empty memories: null.
 *
 * Cache: embeddings are memoized in-process by memory id so the
 * first search is O(N) embed calls (~5 s for 500 memories) and
 * subsequent searches within the same sidecar process are O(N)
 * dot products (~5 ms for 500 memories).
 */

import { coworkLog } from './coworkLogger';
import { nativeSentenceEmbedding, nativeDetectLanguage } from './nativeDesktopMac';

export interface ScoredMemory<T> {
  memory: T;
  score: number;
}

// Module-level embedding cache keyed by memory id. Cleared on sidecar
// restart — that's fine because recomputing on cold start is cheap
// compared to a single LLM call.
const embeddingCache = new Map<string, Float64Array>();

// Single-shot cache of query embeddings (latest N queries) so repeated
// "select memories for current prompt" calls within one turn don't
// re-embed the same query.
const QUERY_CACHE_SIZE = 32;
const queryEmbeddingCache = new Map<string, Float64Array>();

function pruneQueryCache(): void {
  if (queryEmbeddingCache.size <= QUERY_CACHE_SIZE) return;
  const toDelete = queryEmbeddingCache.size - QUERY_CACHE_SIZE;
  const keys = queryEmbeddingCache.keys();
  for (let i = 0; i < toDelete; i++) {
    const k = keys.next().value;
    if (k !== undefined) queryEmbeddingCache.delete(k);
  }
}

function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function detectLanguageForEmbedding(text: string): string {
  if (!text) return 'en';
  try {
    const lang = nativeDetectLanguage(text);
    // Apple NLEmbedding supports a specific list of languages. The
    // common ones (en, zh, zh-Hans, zh-Hant, ja, ko, de, fr, es, ...)
    // all work. Unknown → fall through to English which is the most
    // complete model.
    if (typeof lang === 'string' && lang.length > 0) {
      return lang === 'zh-Hant' ? 'zh' : lang.split('-')[0]; // NLEmbedding keys by short code
    }
  } catch { /* ignore */ }
  return 'en';
}

function embedMemory(id: string, text: string): Float64Array | null {
  const cached = embeddingCache.get(id);
  if (cached) return cached;
  const lang = detectLanguageForEmbedding(text);
  const vec = nativeSentenceEmbedding(text, lang);
  if (!vec || vec.length === 0) return null;
  embeddingCache.set(id, vec);
  return vec;
}

function embedQuery(text: string): Float64Array | null {
  const key = text.slice(0, 500); // cap for cache key sanity
  const cached = queryEmbeddingCache.get(key);
  if (cached) return cached;
  const lang = detectLanguageForEmbedding(text);
  const vec = nativeSentenceEmbedding(text, lang);
  if (!vec || vec.length === 0) return null;
  queryEmbeddingCache.set(key, vec);
  pruneQueryCache();
  return vec;
}

/**
 * Rank an array of memory-like objects against a query string by
 * cosine similarity of their NLEmbedding vectors.
 *
 * Returns `null` when semantic search isn't possible (non-Mac, addon
 * not loaded, query or pool empty, embedding failed). Caller should
 * fall through to whatever default ordering they already have.
 *
 * Memories that can't be embedded (empty text, unsupported language)
 * are silently dropped from the scored result — callers that want the
 * "unscored remainder" should take the top-K from this return AND
 * merge in any remaining non-overlapping items themselves.
 */
export function rankMemoriesSemantic<T extends { id: string; text: string }>(
  query: string,
  memories: T[],
  topK: number = 10,
): ScoredMemory<T>[] | null {
  if (!query || query.trim().length === 0) return null;
  if (!memories || memories.length === 0) return null;

  const queryVec = embedQuery(query);
  if (!queryVec) return null;

  const scored: ScoredMemory<T>[] = [];
  for (const m of memories) {
    if (!m || typeof m.text !== 'string' || m.text.length === 0) continue;
    const vec = embedMemory(m.id, m.text);
    if (!vec) continue;
    const score = cosineSimilarity(queryVec, vec);
    scored.push({ memory: m, score });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const capped = topK > 0 ? scored.slice(0, topK) : scored;
  coworkLog('INFO', 'memorySemanticSearch', 'Ranked memories', {
    poolSize: memories.length,
    scoredSize: scored.length,
    returned: capped.length,
    topScore: capped[0]?.score?.toFixed(3),
    queryLen: query.length,
  });
  return capped;
}

/**
 * Evict a memory's cached embedding — call this when a memory is
 * updated or deleted so the next search re-embeds the new text.
 */
export function invalidateMemoryEmbedding(id: string): void {
  embeddingCache.delete(id);
}
