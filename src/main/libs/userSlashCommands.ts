/**
 * User-defined slash commands.
 *
 * Scans {UserDataPath}/commands/*.md at startup (and on-demand refresh)
 * and exposes each markdown file as a slash command. Typing "/foo" in
 * the composer expands to the contents of `commands/foo.md` before it
 * hits the LLM. Optional YAML front matter lets the user set a short
 * description that surfaces in the autocomplete popup:
 *
 *     ---
 *     description: Lint and test the current directory
 *     ---
 *     Run `npm run lint` then `npm test`, report any failures.
 *
 * `$ARGUMENTS` in the body is replaced with anything the user typed
 * after the command name — so `/foo bar baz` renders the body with
 * `bar baz` inserted wherever `$ARGUMENTS` appears. This mirrors
 * Claude Code's `.claude/commands/*.md` convention so users familiar
 * with that tool feel at home.
 *
 * The commands directory is NoobClaw-specific (under getUserDataPath)
 * rather than ~/.claude so we don't collide with a user who also runs
 * Claude Code side-by-side.
 */

import fs from 'fs';
import path from 'path';
import { getUserDataPath } from './platformAdapter';
import { coworkLog } from './coworkLogger';

export interface SlashCommand {
  /** Command name without the leading slash. Derived from the filename. */
  name: string;
  /** Short one-liner shown in the autocomplete popup. */
  description: string;
  /** Absolute path on disk. */
  file: string;
  /** Raw markdown body (post-frontmatter strip). Contains $ARGUMENTS. */
  body: string;
}

// ── Paths ──

function commandsDir(): string {
  return path.join(getUserDataPath(), 'commands');
}

// ── Front-matter helper ──

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontMatter(raw: string): { data: Record<string, string>; body: string } {
  const m = raw.match(FRONT_MATTER_RE);
  if (!m) return { data: {}, body: raw };
  const yaml = m[1];
  const body = raw.slice(m[0].length);
  const data: Record<string, string> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    data[key] = val;
  }
  return { data, body };
}

// ── Load all commands ──

/**
 * Read the commands directory and return every markdown file as a
 * SlashCommand. Silent on missing dir (empty array). Ignores files
 * that don't end in .md, non-files, and hidden files.
 *
 * The first non-empty line of the body (after stripping markdown
 * headers) is used as the description when the front matter doesn't
 * provide one — so a user can just drop a plain markdown file without
 * any YAML and still get a sensible label.
 */
export function loadUserSlashCommands(): SlashCommand[] {
  const dir = commandsDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const result: SlashCommand[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || !entry.toLowerCase().endsWith('.md')) continue;
    const abs = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile()) continue;

    let raw = '';
    try { raw = fs.readFileSync(abs, 'utf8'); } catch { continue; }

    const { data, body } = parseFrontMatter(raw);
    const name = entry.replace(/\.md$/i, '');

    let description = data.description || '';
    if (!description) {
      const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
      description = firstLine.replace(/^#+\s*/, '').slice(0, 120);
    }

    result.push({ name, description, file: abs, body });
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  coworkLog('INFO', 'userSlashCommands', `Loaded ${result.length} user command(s) from ${dir}`);
  return result;
}

// ── Expansion ──

/**
 * Expand a slash command invocation into its final prompt text. Returns
 * null if the command name is unknown. `args` is whatever the user
 * typed after the command name, or an empty string if they typed
 * nothing. `$ARGUMENTS` placeholders in the body are replaced globally.
 */
export function expandSlashCommand(
  name: string,
  args: string,
): string | null {
  const all = loadUserSlashCommands();
  const cmd = all.find((c) => c.name === name);
  if (!cmd) return null;
  return cmd.body.replace(/\$ARGUMENTS\b/g, args);
}

/**
 * Ensure the commands directory exists so the user can drop files
 * into it without having to mkdir first. No-op if it already exists.
 * Called at startup from main.ts / sidecar-server.ts.
 */
export function ensureUserSlashCommandsDir(): void {
  const dir = commandsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

/**
 * Return the directory containing user slash commands so the settings
 * UI can offer an "Open folder" button.
 */
export function getUserSlashCommandsDir(): string {
  return commandsDir();
}
