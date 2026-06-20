/**
 * Config Manager — hot-reloadable configuration with schema validation.
 * Settings changes take effect without restarting the session.
 *
 * Reference: OpenClaw src/config/ (15 files)
 * Simplified for Electron: uses CoworkStore as source of truth,
 * watches for changes, notifies subscribers.
 */

import { EventEmitter } from 'events';
import { coworkLog } from './coworkLogger';

// ── Types ──

export interface AppConfig {
  // Model & Provider
  model: string;
  provider: string;
  apiKey: string;
  baseURL: string;

  // Agent behavior
  maxTurns: number;
  thinkingBudget: number;
  autoApprove: boolean;

  // Context engine
  contextWindowSize: number;
  toolDeferThreshold: number;

  // Memory
  memoryEnabled: boolean;
  dreamingEnabled: boolean;

  // Voice
  sttProvider: string;
  ttsProvider: string;

  // Search
  searchProvider: string;
  braveApiKey: string;
  tavilyApiKey: string;

  // Webhook
  webhookEnabled: boolean;
  webhookPort: number;

  // Gmail
  gmailEnabled: boolean;
  gmailClientId: string;
  gmailClientSecret: string;

  // Browser
  browserMode: 'extension' | 'cdp';

  // Process
  processMaxConcurrent: number;

  // UI
  language: string;
  theme: string;
}

const DEFAULT_CONFIG: AppConfig = {
  model: 'claude-sonnet-4-20250514',
  provider: 'anthropic',
  apiKey: '',
  baseURL: '',
  maxTurns: 100,
  thinkingBudget: 10000,
  autoApprove: false,
  contextWindowSize: 200000,
  toolDeferThreshold: 30,
  memoryEnabled: true,
  dreamingEnabled: true,
  sttProvider: 'web-speech',
  ttsProvider: 'web-speech',
  searchProvider: 'auto',
  braveApiKey: '',
  tavilyApiKey: '',
  webhookEnabled: false,
  webhookPort: 18790,
  gmailEnabled: false,
  gmailClientId: '',
  gmailClientSecret: '',
  browserMode: 'extension',
  processMaxConcurrent: 10,
  language: 'en',
  theme: 'default',
};

// ── Schema validation ──

interface ValidationError {
  field: string;
  message: string;
}

function validateConfig(config: Partial<AppConfig>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (config.maxTurns !== undefined && (config.maxTurns < 1 || config.maxTurns > 500)) {
    errors.push({ field: 'maxTurns', message: 'Must be 1-500' });
  }
  if (config.thinkingBudget !== undefined && (config.thinkingBudget < 0 || config.thinkingBudget > 100000)) {
    errors.push({ field: 'thinkingBudget', message: 'Must be 0-100000' });
  }
  if (config.contextWindowSize !== undefined && (config.contextWindowSize < 10000 || config.contextWindowSize > 2000000)) {
    errors.push({ field: 'contextWindowSize', message: 'Must be 10000-2000000' });
  }
  if (config.toolDeferThreshold !== undefined && (config.toolDeferThreshold < 5 || config.toolDeferThreshold > 200)) {
    errors.push({ field: 'toolDeferThreshold', message: 'Must be 5-200' });
  }
  if (config.webhookPort !== undefined && (config.webhookPort < 1024 || config.webhookPort > 65535)) {
    errors.push({ field: 'webhookPort', message: 'Must be 1024-65535' });
  }
  if (config.browserMode !== undefined && !['extension', 'cdp'].includes(config.browserMode)) {
    errors.push({ field: 'browserMode', message: 'Must be "extension" or "cdp"' });
  }

  return errors;
}

// ── Config Manager (singleton) ──

class ConfigManager extends EventEmitter {
  private config: AppConfig = { ...DEFAULT_CONFIG };
  private watchers = new Map<string, Array<(value: any) => void>>();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /** Get full config (read-only copy) */
  getAll(): Readonly<AppConfig> {
    return { ...this.config };
  }

  /** Get a single config value */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config[key];
  }

  /**
   * Update config fields. Validates, applies, and notifies watchers.
   * Returns validation errors (empty array = success).
   */
  set(updates: Partial<AppConfig>): ValidationError[] {
    const errors = validateConfig(updates);
    if (errors.length > 0) {
      coworkLog('WARN', 'configManager', `Config validation failed: ${errors.map(e => `${e.field}: ${e.message}`).join(', ')}`);
      return errors;
    }

    const changedKeys: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && (this.config as any)[key] !== value) {
        (this.config as any)[key] = value;
        changedKeys.push(key);
      }
    }

    if (changedKeys.length > 0) {
      coworkLog('INFO', 'configManager', `Config updated: ${changedKeys.join(', ')}`);
      // Notify per-key watchers
      for (const key of changedKeys) {
        const watchers = this.watchers.get(key);
        if (watchers) {
          for (const fn of watchers) {
            try { fn((this.config as any)[key]); } catch {}
          }
        }
      }
      // Emit general change event
      this.emit('change', changedKeys, this.config);
    }

    return [];
  }

  /** Load full config (e.g., from store on startup) */
  load(stored: Partial<AppConfig>): void {
    this.config = { ...DEFAULT_CONFIG, ...stored };
    coworkLog('INFO', 'configManager', 'Config loaded from store');
  }

  /** Watch a specific key for changes */
  watch<K extends keyof AppConfig>(key: K, callback: (value: AppConfig[K]) => void): () => void {
    if (!this.watchers.has(key)) this.watchers.set(key, []);
    this.watchers.get(key)!.push(callback);
    // Return unsubscribe function
    return () => {
      const arr = this.watchers.get(key);
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  /** Reset to defaults */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.emit('change', Object.keys(DEFAULT_CONFIG), this.config);
    coworkLog('INFO', 'configManager', 'Config reset to defaults');
  }

  /** Export for persistence */
  export(): AppConfig {
    return { ...this.config };
  }
}

// ── Singleton ──

export const configManager = new ConfigManager();

// ── Migration helper: upgrade old config formats ──

export function migrateConfig(raw: Record<string, unknown>): Partial<AppConfig> {
  const result: Partial<AppConfig> = {};

  // Map old field names to new ones
  const migrations: Record<string, string> = {
    'executionMode': '', // removed
    'claudeModel': 'model',
    'apiProvider': 'provider',
  };

  for (const [oldKey, newKey] of Object.entries(migrations)) {
    if (raw[oldKey] !== undefined && newKey) {
      (result as any)[newKey] = raw[oldKey];
    }
  }

  // Copy known fields directly
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (raw[key] !== undefined) {
      (result as any)[key] = raw[key];
    }
  }

  return result;
}
