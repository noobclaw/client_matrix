/**
 * Plugin SDK — interface for third-party NoobClaw plugins.
 * Plugins can register tools, hooks, and skills.
 *
 * Reference: OpenClaw packages/plugin-sdk/ + src/plugins/
 *
 * Plugin format: npm package with a manifest (noobclaw.plugin.json)
 * and an entry point that exports a plugin definition.
 */

import type { ToolDefinition } from './toolSystem';
import type { HookEventType, HookCallback } from './hookSystem';

// ── Plugin manifest (noobclaw.plugin.json) ──

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  entry: string;          // Relative path to entry file (e.g., "dist/index.js")
  permissions?: string[]; // Required permissions (e.g., ["filesystem", "network"])
}

// ── Plugin definition (exported by entry point) ──

export interface NoobClawPlugin {
  id: string;
  name: string;
  version: string;

  /** Called once when plugin is loaded */
  activate?(api: PluginAPI): void | Promise<void>;

  /** Called when plugin is unloaded */
  deactivate?(): void | Promise<void>;

  /** Tools provided by this plugin */
  tools?: ToolDefinition[];

  /** Hooks this plugin registers */
  hooks?: Array<{
    event: HookEventType;
    handler: HookCallback;
  }>;

  /** Skills (SKILL.md content) provided by this plugin */
  skills?: Array<{
    name: string;
    content: string;
  }>;
}

// ── API exposed to plugins ──

export interface PluginAPI {
  /** Register a tool dynamically */
  registerTool(tool: ToolDefinition): void;

  /** Register a hook */
  registerHook(event: HookEventType, handler: HookCallback): void;

  /** Log a message */
  log(level: 'info' | 'warn' | 'error', message: string): void;

  /** Get a config value */
  getConfig(key: string): unknown;

  /** Get the current working directory */
  getCwd(): string;
}

// ── Helper to define a plugin (for plugin authors) ──

export function defineNoobClawPlugin(plugin: NoobClawPlugin): NoobClawPlugin {
  return plugin;
}

// ── Tool visibility control ──

export type ToolVisibility = 'always' | 'on-demand' | 'hidden';

export interface PluginToolDefinition extends ToolDefinition {
  visibility?: ToolVisibility;
}
