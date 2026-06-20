/**
 * Plugin Manager — loads, activates, and manages NoobClaw plugins.
 *
 * Reference: OpenClaw src/plugins/ (10 files)
 *
 * Plugin discovery:
 * 1. Built-in plugins: bundled with the app
 * 2. User plugins: ~/.noobclaw/plugins/<plugin-id>/
 * 3. Workspace plugins: <cwd>/.noobclaw/plugins/<plugin-id>/
 *
 * Each plugin directory must contain noobclaw.plugin.json manifest.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { coworkLog } from './coworkLogger';
import { registerHook } from './hookSystem';
import { configManager } from './configManager';
import type {
  NoobClawPlugin,
  PluginManifest,
  PluginAPI,
} from './pluginSdk';
import type { ToolDefinition } from './toolSystem';

// ── Types ──

export interface LoadedPlugin {
  manifest: PluginManifest;
  plugin: NoobClawPlugin;
  tools: ToolDefinition[];
  enabled: boolean;
  loadedAt: number;
  error?: string;
}

// ── State ──

const loadedPlugins = new Map<string, LoadedPlugin>();
const MANIFEST_FILENAME = 'noobclaw.plugin.json';

// ── Plugin directories ──

function getUserPluginsDir(): string {
  return path.join(os.homedir(), '.noobclaw', 'plugins');
}

function getWorkspacePluginsDir(cwd: string): string {
  return path.join(cwd, '.noobclaw', 'plugins');
}

// ── Discovery ──

/**
 * Discover all available plugins from user and workspace directories.
 */
export function discoverPlugins(cwd?: string): PluginManifest[] {
  const manifests: PluginManifest[] = [];
  const dirs = [getUserPluginsDir()];
  if (cwd) dirs.push(getWorkspacePluginsDir(cwd));

  for (const baseDir of dirs) {
    if (!fs.existsSync(baseDir)) continue;
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(baseDir, entry.name, MANIFEST_FILENAME);
        if (fs.existsSync(manifestPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            manifests.push({
              id: raw.id || entry.name,
              name: raw.name || entry.name,
              version: raw.version || '0.0.0',
              description: raw.description || '',
              author: raw.author,
              entry: raw.entry || 'index.js',
              permissions: raw.permissions,
            });
          } catch (e) {
            coworkLog('WARN', 'pluginManager', `Invalid manifest: ${manifestPath}`);
          }
        }
      }
    } catch {}
  }

  coworkLog('INFO', 'pluginManager', `Discovered ${manifests.length} plugins`);
  return manifests;
}

// ── Loading ──

/**
 * Load and activate a single plugin.
 */
export async function loadPlugin(manifest: PluginManifest, baseDir: string, cwd: string): Promise<LoadedPlugin> {
  const pluginDir = path.join(baseDir, manifest.id);
  const entryPath = path.join(pluginDir, manifest.entry);

  if (!fs.existsSync(entryPath)) {
    const result: LoadedPlugin = {
      manifest, plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
      tools: [], enabled: false, loadedAt: Date.now(),
      error: `Entry file not found: ${entryPath}`,
    };
    loadedPlugins.set(manifest.id, result);
    return result;
  }

  try {
    // Dynamic require for the plugin entry point
    const mod = require(entryPath);
    const plugin: NoobClawPlugin = mod.default || mod;

    if (!plugin.id) plugin.id = manifest.id;
    if (!plugin.name) plugin.name = manifest.name;
    if (!plugin.version) plugin.version = manifest.version;

    // Build plugin API
    const api = buildPluginAPI(manifest.id, cwd);

    // Activate
    if (plugin.activate) {
      await plugin.activate(api);
    }

    // Register hooks
    if (plugin.hooks) {
      for (const hook of plugin.hooks) {
        registerHook(hook.event, `plugin-${manifest.id}`, hook.handler);
      }
    }

    // Collect tools
    const tools: ToolDefinition[] = plugin.tools || [];

    const result: LoadedPlugin = {
      manifest, plugin, tools, enabled: true, loadedAt: Date.now(),
    };
    loadedPlugins.set(manifest.id, result);

    coworkLog('INFO', 'pluginManager', `Loaded plugin: ${manifest.id} v${manifest.version} (${tools.length} tools)`);
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const result: LoadedPlugin = {
      manifest, plugin: { id: manifest.id, name: manifest.name, version: manifest.version },
      tools: [], enabled: false, loadedAt: Date.now(), error,
    };
    loadedPlugins.set(manifest.id, result);
    coworkLog('ERROR', 'pluginManager', `Failed to load plugin ${manifest.id}: ${error}`);
    return result;
  }
}

/**
 * Load all discovered plugins.
 */
export async function loadAllPlugins(cwd?: string): Promise<ToolDefinition[]> {
  const manifests = discoverPlugins(cwd);
  const allTools: ToolDefinition[] = [];

  for (const manifest of manifests) {
    const baseDir = fs.existsSync(path.join(getUserPluginsDir(), manifest.id))
      ? getUserPluginsDir()
      : cwd ? getWorkspacePluginsDir(cwd) : getUserPluginsDir();

    const loaded = await loadPlugin(manifest, baseDir, cwd || process.cwd());
    if (loaded.enabled) {
      allTools.push(...loaded.tools);
    }
  }

  coworkLog('INFO', 'pluginManager', `Loaded ${loadedPlugins.size} plugins, ${allTools.length} tools`);
  return allTools;
}

// ── Unloading ──

export async function unloadPlugin(pluginId: string): Promise<boolean> {
  const loaded = loadedPlugins.get(pluginId);
  if (!loaded) return false;

  try {
    if (loaded.plugin.deactivate) {
      await loaded.plugin.deactivate();
    }
  } catch (e) {
    coworkLog('WARN', 'pluginManager', `Error deactivating plugin ${pluginId}: ${e}`);
  }

  loadedPlugins.delete(pluginId);
  coworkLog('INFO', 'pluginManager', `Unloaded plugin: ${pluginId}`);
  return true;
}

export async function unloadAllPlugins(): Promise<void> {
  for (const id of Array.from(loadedPlugins.keys())) {
    await unloadPlugin(id);
  }
}

// ── Query ──

export function getLoadedPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values());
}

export function getPlugin(id: string): LoadedPlugin | null {
  return loadedPlugins.get(id) ?? null;
}

export function getPluginTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const loaded of loadedPlugins.values()) {
    if (loaded.enabled) tools.push(...loaded.tools);
  }
  return tools;
}

// ── Plugin API builder ──

function buildPluginAPI(pluginId: string, cwd: string): PluginAPI {
  const registeredTools: ToolDefinition[] = [];

  return {
    registerTool(tool: ToolDefinition): void {
      // Prefix tool name to avoid conflicts
      const prefixed = { ...tool, name: `plugin__${pluginId}__${tool.name}` };
      registeredTools.push(prefixed);
      const loaded = loadedPlugins.get(pluginId);
      if (loaded) loaded.tools.push(prefixed);
    },

    registerHook(event, handler): void {
      registerHook(event, `plugin-${pluginId}-dynamic`, handler);
    },

    log(level, message): void {
      coworkLog(level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO',
        `plugin:${pluginId}`, message);
    },

    getConfig(key: string): unknown {
      return configManager.get(key as any);
    },

    getCwd(): string {
      return cwd;
    },
  };
}
