/**
 * Model Capabilities — detect and cache model features.
 * Auto-adapts behavior based on what the model supports.
 *
 * Reference: Claude Code src/utils/model/modelCapabilities.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { coworkLog } from './coworkLogger';

// ── Types ──

export interface ModelCapability {
  id: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsAdaptiveThinking: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsEffort: boolean;
  supportsStreaming: boolean;
}

// ── Known model configs (fallback when API detection unavailable) ──

const KNOWN_MODELS: Record<string, Partial<ModelCapability>> = {
  // Anthropic Claude
  'claude-opus-4-6': { maxInputTokens: 200000, maxOutputTokens: 32768, supportsThinking: true, supportsAdaptiveThinking: true, supportsTools: true, supportsVision: true, supportsEffort: true },
  'claude-sonnet-4-6': { maxInputTokens: 200000, maxOutputTokens: 16384, supportsThinking: true, supportsAdaptiveThinking: true, supportsTools: true, supportsVision: true, supportsEffort: true },
  'claude-sonnet-4-20250514': { maxInputTokens: 200000, maxOutputTokens: 16384, supportsThinking: true, supportsAdaptiveThinking: false, supportsTools: true, supportsVision: true, supportsEffort: false },
  'claude-haiku-4-5-20251001': { maxInputTokens: 200000, maxOutputTokens: 8192, supportsThinking: true, supportsAdaptiveThinking: false, supportsTools: true, supportsVision: true, supportsEffort: false },
  'claude-3-5-sonnet-20241022': { maxInputTokens: 200000, maxOutputTokens: 8192, supportsThinking: false, supportsAdaptiveThinking: false, supportsTools: true, supportsVision: true, supportsEffort: false },

  // OpenAI
  'gpt-4o': { maxInputTokens: 128000, maxOutputTokens: 16384, supportsThinking: false, supportsTools: true, supportsVision: true, supportsEffort: false },
  'gpt-4o-mini': { maxInputTokens: 128000, maxOutputTokens: 16384, supportsThinking: false, supportsTools: true, supportsVision: true, supportsEffort: false },
  'gpt-4-turbo': { maxInputTokens: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsTools: true, supportsVision: true, supportsEffort: false },
  'o1': { maxInputTokens: 200000, maxOutputTokens: 100000, supportsThinking: true, supportsTools: true, supportsVision: true, supportsEffort: false },
  'o3-mini': { maxInputTokens: 200000, maxOutputTokens: 100000, supportsThinking: true, supportsTools: true, supportsVision: false, supportsEffort: false },

  // Qwen
  'qwen-max': { maxInputTokens: 32000, maxOutputTokens: 8192, supportsThinking: false, supportsTools: true, supportsVision: false, supportsEffort: false },
  'qwen-plus': { maxInputTokens: 131072, maxOutputTokens: 8192, supportsThinking: false, supportsTools: true, supportsVision: false, supportsEffort: false },
  'qwen-turbo': { maxInputTokens: 131072, maxOutputTokens: 8192, supportsThinking: false, supportsTools: true, supportsVision: false, supportsEffort: false },
  'qwen3.5-plus': { maxInputTokens: 131072, maxOutputTokens: 16384, supportsThinking: true, supportsTools: true, supportsVision: false, supportsEffort: false },

  // DeepSeek
  'deepseek-chat': { maxInputTokens: 64000, maxOutputTokens: 8192, supportsThinking: false, supportsTools: true, supportsVision: false, supportsEffort: false },
  'deepseek-coder': { maxInputTokens: 64000, maxOutputTokens: 8192, supportsThinking: false, supportsTools: true, supportsVision: false, supportsEffort: false },
  'deepseek-reasoner': { maxInputTokens: 64000, maxOutputTokens: 8192, supportsThinking: true, supportsTools: false, supportsVision: false, supportsEffort: false },

  // Gemini
  'gemini-2.0-flash': { maxInputTokens: 1000000, maxOutputTokens: 8192, supportsThinking: false, supportsTools: true, supportsVision: true, supportsEffort: false },
  'gemini-2.5-pro': { maxInputTokens: 1000000, maxOutputTokens: 65536, supportsThinking: true, supportsTools: true, supportsVision: true, supportsEffort: false },

  // Zhipu
  'glm-4-plus': { maxInputTokens: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsTools: true, supportsVision: false, supportsEffort: false },

  // Moonshot
  'moonshot-v1-128k': { maxInputTokens: 128000, maxOutputTokens: 4096, supportsThinking: false, supportsTools: true, supportsVision: false, supportsEffort: false },

  // Ollama local
  'llama3': { maxInputTokens: 8192, maxOutputTokens: 4096, supportsThinking: false, supportsTools: false, supportsVision: false, supportsEffort: false },
  'codellama': { maxInputTokens: 16384, maxOutputTokens: 4096, supportsThinking: false, supportsTools: false, supportsVision: false, supportsEffort: false },
};

const DEFAULT_CAPABILITY: ModelCapability = {
  id: 'unknown',
  maxInputTokens: 32000,
  maxOutputTokens: 4096,
  supportsThinking: false,
  supportsAdaptiveThinking: false,
  supportsTools: true,
  supportsVision: false,
  supportsEffort: false,
  supportsStreaming: true,
};

// ── Cache ──

const CACHE_PATH = path.join(os.homedir(), '.noobclaw', 'cache', 'model-capabilities.json');
let cachedModels: Map<string, ModelCapability> | null = null;

// ── Lookup ──

/**
 * Get capabilities for a model. Uses: exact match → substring match → defaults.
 */
export function getModelCapability(modelId: string): ModelCapability {
  // Try cached first
  if (cachedModels?.has(modelId)) return cachedModels.get(modelId)!;

  // Try known models — exact match
  const lower = modelId.toLowerCase();
  for (const [key, caps] of Object.entries(KNOWN_MODELS)) {
    if (lower === key.toLowerCase() || lower.includes(key.toLowerCase())) {
      return { ...DEFAULT_CAPABILITY, ...caps, id: modelId };
    }
  }

  // Substring match (e.g., "noobclawai-reasoner" matches nothing but might contain "qwen")
  for (const [key, caps] of Object.entries(KNOWN_MODELS)) {
    if (lower.includes(key.toLowerCase().split('-')[0])) {
      return { ...DEFAULT_CAPABILITY, ...caps, id: modelId };
    }
  }

  coworkLog('INFO', 'modelCapabilities', `Unknown model "${modelId}", using defaults`);
  return { ...DEFAULT_CAPABILITY, id: modelId };
}

/**
 * Check if model supports a specific feature.
 */
export function modelSupports(modelId: string, feature: keyof Omit<ModelCapability, 'id' | 'maxInputTokens' | 'maxOutputTokens'>): boolean {
  return getModelCapability(modelId)[feature] as boolean;
}

// ── Cache persistence ──

export function saveCapabilityCache(models: ModelCapability[]): void {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ models, timestamp: Date.now() }, null, 2), { mode: 0o600 });
    cachedModels = new Map(models.map(m => [m.id, m]));
    coworkLog('INFO', 'modelCapabilities', `Cached ${models.length} models`);
  } catch (e) {
    coworkLog('WARN', 'modelCapabilities', `Cache save failed: ${e}`);
  }
}

export function loadCapabilityCache(): ModelCapability[] {
  try {
    if (!fs.existsSync(CACHE_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (data.models) {
      cachedModels = new Map(data.models.map((m: ModelCapability) => [m.id, m]));
      return data.models;
    }
  } catch {}
  return [];
}
