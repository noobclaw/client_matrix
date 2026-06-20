/**
 * CDP Browser Profile Manager — manages multiple Chrome user data directories
 * for login state isolation.
 *
 * Ported from OpenClaw extensions/browser/browser-profiles.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { coworkLog } from './coworkLogger';

// ── Types ──

export interface BrowserProfile {
  id: string;
  name: string;
  description: string;
  userDataDir: string;
  createdAt: number;
  lastUsedAt: number;
}

// ── State ──

const profiles = new Map<string, BrowserProfile>();
const DEFAULT_PROFILES_DIR = path.join(os.homedir(), '.noobclaw', 'browser-profiles');

// ── Init ──

export function initProfileManager(): void {
  if (!fs.existsSync(DEFAULT_PROFILES_DIR)) {
    fs.mkdirSync(DEFAULT_PROFILES_DIR, { recursive: true });
  }

  // Create default profile
  if (!profiles.has('default')) {
    profiles.set('default', {
      id: 'default',
      name: 'Default',
      description: 'Default browser profile',
      userDataDir: path.join(DEFAULT_PROFILES_DIR, 'default'),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
  }

  // Scan existing profile directories
  try {
    const dirs = fs.readdirSync(DEFAULT_PROFILES_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (dir.isDirectory() && !profiles.has(dir.name)) {
        profiles.set(dir.name, {
          id: dir.name,
          name: dir.name,
          description: '',
          userDataDir: path.join(DEFAULT_PROFILES_DIR, dir.name),
          createdAt: Date.now(),
          lastUsedAt: 0,
        });
      }
    }
  } catch { /* ignore scan errors */ }

  coworkLog('INFO', 'cdpProfileManager', `Loaded ${profiles.size} browser profiles`);
}

// ── CRUD ──

export function createProfile(name: string, description?: string): BrowserProfile {
  const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  if (profiles.has(id)) throw new Error(`Profile "${id}" already exists`);

  const userDataDir = path.join(DEFAULT_PROFILES_DIR, id);
  fs.mkdirSync(userDataDir, { recursive: true });

  const profile: BrowserProfile = {
    id,
    name,
    description: description || '',
    userDataDir,
    createdAt: Date.now(),
    lastUsedAt: 0,
  };

  profiles.set(id, profile);
  coworkLog('INFO', 'cdpProfileManager', `Created profile: ${id}`);
  return profile;
}

export function deleteProfile(id: string): boolean {
  if (id === 'default') return false;
  const profile = profiles.get(id);
  if (!profile) return false;

  profiles.delete(id);
  // Don't delete the directory — user might have important data
  coworkLog('INFO', 'cdpProfileManager', `Deleted profile: ${id} (directory preserved)`);
  return true;
}

export function getProfile(id: string): BrowserProfile | null {
  return profiles.get(id) ?? null;
}

export function listProfiles(): BrowserProfile[] {
  return Array.from(profiles.values());
}

export function markProfileUsed(id: string): void {
  const p = profiles.get(id);
  if (p) p.lastUsedAt = Date.now();
}

export function getProfileDir(id: string): string {
  const p = profiles.get(id);
  if (!p) return path.join(DEFAULT_PROFILES_DIR, 'default');
  markProfileUsed(id);
  return p.userDataDir;
}
