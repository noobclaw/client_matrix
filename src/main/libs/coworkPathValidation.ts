/**
 * Path validation — ported from Claude Code utils/permissions/pathValidation.ts
 *
 * Validates file paths before allowing read/write/delete operations.
 * Prevents: UNC credential leaks, path traversal, symlink escapes,
 * shell expansion TOCTOU, dangerous removal targets.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { coworkLog } from './coworkLogger';

// ── UNC path detection (from readOnlyCommandValidation.ts) ──

const UNC_BACKSLASH_RE = /\\\\[^\s\\]+(?:@(?:\d+|ssl))?(?:[/\\]|$|\s)/i;
const UNC_FORWARD_RE = /(?<!:)\/\/[^\s/\\]+(?:@(?:\d+|ssl))?(?:[/\\]|$|\s)/i;
const UNC_MIXED_FWD_BACK_RE = /\/\\{2,}[^\s/\\]/;
const UNC_MIXED_BACK_FWD_RE = /\\{2,}\/[^\s/\\]/;
const UNC_WEBDAV_SSL_RE = /@SSL@\d+/i;
const UNC_DAVWWWROOT_RE = /DavWWWRoot/i;
const UNC_IPV4_RE = /^(?:\\\\|\/\/)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})[/\\]/;
const UNC_IPV6_RE = /^(?:\\\\|\/\/)\[[\da-fA-F:]+\][/\\]/;

export function containsVulnerableUncPath(pathOrCommand: string): boolean {
  if (process.platform !== 'win32') return false;
  return UNC_BACKSLASH_RE.test(pathOrCommand)
    || UNC_FORWARD_RE.test(pathOrCommand)
    || UNC_MIXED_FWD_BACK_RE.test(pathOrCommand)
    || UNC_MIXED_BACK_FWD_RE.test(pathOrCommand)
    || UNC_WEBDAV_SSL_RE.test(pathOrCommand)
    || UNC_DAVWWWROOT_RE.test(pathOrCommand)
    || UNC_IPV4_RE.test(pathOrCommand)
    || UNC_IPV6_RE.test(pathOrCommand);
}

// ── Windows suspicious path patterns (from filesystem.ts) ──

const NTFS_ADS_RE = /:.+/; // colon after position 2
const SHORT_NAME_83_RE = /~\d/;
const LONG_PATH_PREFIX_RE = /^(\\\\[?.]\\|\/\/[?.]\/)/;
const TRAILING_DOT_SPACE_RE = /[.\s]+$/;
const DOS_DEVICE_RE = /\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const TRIPLE_DOT_RE = /(^|[/\\])\.{3,}([/\\]|$)/;

export function hasSuspiciousWindowsPathPattern(p: string): boolean {
  // Most checks are Windows-specific — skip on other platforms
  if (process.platform === 'win32') {
    if (SHORT_NAME_83_RE.test(p)) return true;
    if (LONG_PATH_PREFIX_RE.test(p)) return true;
    if (TRAILING_DOT_SPACE_RE.test(p)) return true;
    if (DOS_DEVICE_RE.test(p)) return true;
    if (p.length > 2 && NTFS_ADS_RE.test(p.slice(2))) return true;
  }
  // Cross-platform checks
  if (TRIPLE_DOT_RE.test(p)) return true;
  if (containsVulnerableUncPath(p)) return true;
  return false;
}

// ── Dangerous removal path detection (from pathValidation.ts) ──

const GLOB_PATTERN_RE = /[*?[\]{}]/;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/?$/;
const WINDOWS_DRIVE_CHILD_RE = /^[A-Za-z]:\/[^/]+$/;

export function isDangerousRemovalPath(resolvedPath: string): boolean {
  const normalized = resolvedPath.replace(/[\\/]+/g, '/');
  if (normalized === '*' || normalized.endsWith('/*')) return true;
  if (normalized === '/') return true;
  if (WINDOWS_DRIVE_ROOT_RE.test(normalized)) return true;
  const home = os.homedir().replace(/[\\/]+/g, '/');
  if (normalized === home) return true;
  // Direct children of root (/usr, /tmp, /etc, etc.)
  const parent = path.posix.dirname(normalized);
  if (parent === '/') return true;
  if (WINDOWS_DRIVE_CHILD_RE.test(normalized)) return true;
  return false;
}

// ── Dangerous file paths for auto-edit ──

const DANGEROUS_DIRECTORIES = new Set(['.git', '.vscode', '.idea', '.claude']);
const DANGEROUS_FILES = new Set([
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile',
  '.zshrc', '.zprofile', '.profile', '.ripgreprc',
  '.mcp.json', '.claude.json',
]);

export function isDangerousFilePathToAutoEdit(filePath: string): boolean {
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) return true;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (DANGEROUS_DIRECTORIES.has(parts[i])) {
      // Exception: .claude/worktrees/ is allowed
      if (parts[i] === '.claude' && parts[i + 1] === 'worktrees') continue;
      return true;
    }
  }
  const filename = path.basename(normalized);
  if (DANGEROUS_FILES.has(filename)) return true;
  return false;
}

// ── Shell expansion detection ──

export function containsShellExpansion(p: string): boolean {
  return p.includes('$') || p.includes('%') || p.startsWith('=');
}

// ── Glob detection ──

export function containsGlobPattern(p: string): boolean {
  return GLOB_PATTERN_RE.test(p);
}

// ── Path traversal detection ──

export function containsPathTraversal(p: string): boolean {
  const normalized = p.replace(/\\/g, '/');
  return normalized.includes('../') || normalized.includes('/..') || normalized === '..';
}

// ── Main validation function ──

export type PathValidationResult = {
  allowed: boolean;
  reason?: string;
};

/**
 * Validate a file path before allowing operations.
 * Returns { allowed: true } or { allowed: false, reason: "..." }.
 */
export function validatePath(
  filePath: string,
  workspaceRoot: string,
  operationType: 'read' | 'write' | 'create' | 'delete' = 'read'
): PathValidationResult {
  // Strip quotes
  let cleanPath = filePath.replace(/^['"]|['"]$/g, '');

  // Expand tilde
  if (cleanPath === '~' || cleanPath.startsWith('~/') || cleanPath.startsWith('~\\')) {
    cleanPath = path.join(os.homedir(), cleanPath.slice(1));
  } else if (cleanPath.startsWith('~')) {
    // ~username or ~+ or ~- — block
    return { allowed: false, reason: 'Tilde variants (~username, ~+, ~-) require manual approval.' };
  }

  // UNC path check
  if (containsVulnerableUncPath(cleanPath)) {
    return { allowed: false, reason: 'UNC paths are blocked to prevent NTLM credential leaks.' };
  }

  // Shell expansion check
  if (containsShellExpansion(cleanPath)) {
    return { allowed: false, reason: 'Paths with shell expansion ($, %, =) are blocked (TOCTOU risk).' };
  }

  // Windows suspicious patterns
  if (hasSuspiciousWindowsPathPattern(cleanPath)) {
    return { allowed: false, reason: 'Suspicious Windows path pattern detected (NTFS ADS, 8.3 name, DOS device).' };
  }

  // Glob patterns — block for write/create/delete
  if (containsGlobPattern(cleanPath) && operationType !== 'read') {
    return { allowed: false, reason: 'Glob patterns are not allowed in write/delete operations.' };
  }

  // Dangerous removal targets
  if (operationType === 'delete') {
    const resolved = path.resolve(cleanPath);
    if (isDangerousRemovalPath(resolved)) {
      return { allowed: false, reason: `Dangerous removal target: ${resolved}` };
    }
  }

  // Dangerous files for auto-edit
  if (operationType === 'write' || operationType === 'create') {
    if (isDangerousFilePathToAutoEdit(cleanPath)) {
      return { allowed: false, reason: `Dangerous path for auto-edit: ${cleanPath}` };
    }
  }

  // Resolve and check if within workspace
  const resolved = path.resolve(cleanPath);
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const isInWorkspace = resolved.startsWith(normalizedWorkspace + path.sep) || resolved === normalizedWorkspace;

  if (!isInWorkspace && operationType !== 'read') {
    coworkLog('WARN', 'validatePath', `Path outside workspace: ${resolved} (workspace: ${normalizedWorkspace})`);
    return { allowed: false, reason: `Path is outside the workspace root: ${resolved}` };
  }

  return { allowed: true };
}
