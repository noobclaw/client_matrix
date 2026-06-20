/**
 * Embedding Provider — vector embedding for semantic memory search.
 * Supports OpenAI, local, and fallback keyword-based embeddings.
 *
 * Reference: OpenClaw src/memory-host-sdk/engine-embeddings.ts
 */

import { coworkLog } from './coworkLogger';
import { getCurrentApiConfig } from './claudeSettings';

// ── Types ──

export type EmbeddingProviderType = 'openai' | 'local' | 'none';

export interface EmbeddingResult {
  vector: Float32Array;
  model: string;
  dimensions: number;
}

// ── State ──

let providerType: EmbeddingProviderType = 'none';
let openaiApiKey: string | null = null;
let openaiBaseUrl: string | null = null;
let embeddingModel = 'text-embedding-3-small';
let embeddingDimensions = 1536;

// ── Configuration ──

export function configureEmbeddings(config: {
  provider?: EmbeddingProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}): void {
  if (config.provider) providerType = config.provider;
  if (config.apiKey) openaiApiKey = config.apiKey;
  if (config.baseUrl) openaiBaseUrl = config.baseUrl;
  if (config.model) embeddingModel = config.model;
  if (config.dimensions) embeddingDimensions = config.dimensions;
  coworkLog('INFO', 'embeddingProvider', `Configured: ${providerType}, model=${embeddingModel}, dim=${embeddingDimensions}`);
}

export function autoConfigureEmbeddings(): void {
  // Try to auto-detect from existing API config
  const apiConfig = getCurrentApiConfig();
  if (!apiConfig) return;

  // If user has OpenAI-compatible provider, use it for embeddings
  const providerName = (apiConfig as any).providerName || '';
  if (providerName === 'openai' || providerName === 'gemini') {
    openaiApiKey = apiConfig.apiKey;
    openaiBaseUrl = apiConfig.baseURL || 'https://api.openai.com';
    providerType = 'openai';
    coworkLog('INFO', 'embeddingProvider', `Auto-configured OpenAI embeddings from ${providerName}`);
  }
}

export function isEmbeddingAvailable(): boolean {
  return providerType !== 'none';
}

// ── Embedding computation ──

export async function embed(text: string): Promise<EmbeddingResult | null> {
  if (providerType === 'none') return null;

  try {
    switch (providerType) {
      case 'openai':
        return await embedViaOpenAI(text);
      case 'local':
        return embedLocal(text);
      default:
        return null;
    }
  } catch (e) {
    coworkLog('WARN', 'embeddingProvider', `Embedding failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
  if (providerType === 'none') return texts.map((): null => null);

  if (providerType === 'openai') {
    return embedBatchViaOpenAI(texts);
  }

  return Promise.all(texts.map(t => embed(t)));
}

// ── OpenAI Embedding API ──

async function embedViaOpenAI(text: string): Promise<EmbeddingResult> {
  if (!openaiApiKey) throw new Error('OpenAI API key not configured for embeddings');

  const baseUrl = openaiBaseUrl || 'https://api.openai.com';
  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: text.slice(0, 8000), // Truncate to model limit
      dimensions: embeddingDimensions,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI embedding API error: ${response.status}`);
  }

  const data = await response.json();
  const vector = new Float32Array(data.data[0].embedding);

  return {
    vector,
    model: embeddingModel,
    dimensions: vector.length,
  };
}

async function embedBatchViaOpenAI(texts: string[]): Promise<(EmbeddingResult | null)[]> {
  if (!openaiApiKey) return texts.map((): null => null);

  const baseUrl = openaiBaseUrl || 'https://api.openai.com';
  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: texts.map(t => t.slice(0, 8000)),
      dimensions: embeddingDimensions,
    }),
  });

  if (!response.ok) {
    coworkLog('WARN', 'embeddingProvider', `Batch embedding failed: ${response.status}`);
    return texts.map((): null => null);
  }

  const data = await response.json();
  return data.data.map((d: any) => ({
    vector: new Float32Array(d.embedding),
    model: embeddingModel,
    dimensions: d.embedding.length,
  }));
}

// ── Local (keyword-based pseudo-embedding for offline use) ──

function embedLocal(text: string): EmbeddingResult {
  // Simple bag-of-words hashing to a fixed-size vector
  // Not a real embedding, but allows cosine similarity to work
  const dim = 128;
  const vector = new Float32Array(dim);
  const words = text.toLowerCase().split(/\s+/);
  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % dim;
    vector[idx] += 1;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vector[i] /= norm;

  return { vector, model: 'local-bow', dimensions: dim };
}

// ── Cosine similarity ──

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
