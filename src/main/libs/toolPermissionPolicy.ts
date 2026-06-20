/**
 * User-facing tool permission policy.
 *
 * Extends the shell-hooks settings.json file with an optional
 * `toolPermissions` key that lets the user pre-decide per-tool
 * "always allow", "always deny", or "ask" behavior without touching
 * code. Example:
 *
 *     {
 *       "toolPermissions": {
 *         "defaultMode": "allow",
 *         "rules": [
 *           { "pattern": "Bash",  "mode": "ask"  },
 *           { "pattern": "Edit",  "mode": "allow" },
 *           { "pattern": "mcp__.*", "mode": "deny" },
 *           { "pattern": "Bash", "bashCommandContains": "rm -rf", "mode": "deny" }
 *         ]
 *       }
 *     }
 *
 * Evaluation: rules are checked in order; the first matching rule
 * wins. A rule matches when the tool name matches `pattern` (regex)
 * AND — if present — the Bash command body contains
 * `bashCommandContains` as a substring. If no rule matches, the
 * defaultMode is returned.
 *
 * `allow` short-circuits the normal flow (no AskUserQuestion / no
 * permission dialog).
 * `deny` short-circuits with a deny message that gets fed back to
 * the model as a tool result.
 * `ask` falls through to the existing permission machinery — the
 * coworkRunner is configured for full auto-approve, so this is
 * equivalent to `allow` today, but we keep it distinct so a future
 * "interactive-mode" build can branch on it.
 *
 * Settings are re-read from disk (with mtime cache) so the settings
 * UI can write without restarting the sidecar.
 */

import fs from 'fs';
import path from 'path';
import { getUserDataPath } from './platformAdapter';
import { coworkLog } from './coworkLogger';

export type ToolPermissionMode = 'allow' | 'deny' | 'ask';

export interface ToolPermissionRule {
  pattern: string;
  mode: ToolPermissionMode;
  bashCommandContains?: string;
  reason?: string;
}

interface ToolPermissionConfig {
  defaultMode?: ToolPermissionMode;
  rules?: ToolPermissionRule[];
}

interface SettingsFile {
  toolPermissions?: ToolPermissionConfig;
}

// ── Config cache ──

let cache: SettingsFile | null = null;
let cacheMtime = 0;

function configPath(): string {
  return path.join(getUserDataPath(), 'settings.json');
}

function loadConfig(): SettingsFile {
  const file = configPath();
  try {
    const stat = fs.statSync(file);
    if (cache && stat.mtimeMs === cacheMtime) return cache;
    const raw = fs.readFileSync(file, 'utf8');
    cache = JSON.parse(raw) as SettingsFile;
    cacheMtime = stat.mtimeMs;
    return cache;
  } catch {
    cache = {};
    cacheMtime = 0;
    return cache;
  }
}

// ── Rule evaluation ──

export interface PolicyDecision {
  mode: ToolPermissionMode;
  reason?: string;
}

/**
 * Return the user-configured verdict for a tool invocation. If the
 * user hasn't configured any policy, returns `{ mode: 'ask' }` which
 * is the "let the existing pipeline decide" signal.
 */
export function evaluateToolPolicy(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): PolicyDecision {
  const cfg = loadConfig().toolPermissions;
  if (!cfg) return { mode: 'allow' };

  const rules = cfg.rules ?? [];
  for (const rule of rules) {
    let nameOk = false;
    try {
      nameOk = new RegExp(`^${rule.pattern}$`).test(toolName);
    } catch {
      // Malformed regex — fall back to substring match so the user
      // isn't silently ignored because of a typo.
      nameOk = toolName.includes(rule.pattern);
    }
    if (!nameOk) continue;

    if (rule.bashCommandContains) {
      const cmd = String(toolInput?.command ?? '').toLowerCase();
      if (!cmd.includes(rule.bashCommandContains.toLowerCase())) continue;
    }

    return { mode: rule.mode, reason: rule.reason };
  }

  return { mode: cfg.defaultMode ?? 'allow' };
}

/**
 * Force a reload of the settings file on the next call. Use after
 * the settings UI saves changes so the new policy takes effect
 * without waiting for the mtime check to trigger.
 */
export function invalidateToolPolicyCache(): void {
  cache = null;
  cacheMtime = 0;
  coworkLog('INFO', 'toolPermissionPolicy', 'Cache invalidated');
}

/**
 * Return the full policy so the settings UI can show current rules.
 */
export function getToolPermissionPolicy(): ToolPermissionConfig {
  return loadConfig().toolPermissions ?? { defaultMode: 'allow', rules: [] };
}
