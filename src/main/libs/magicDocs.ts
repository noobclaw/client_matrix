/**
 * Magic Docs — auto-updating documentation files.
 * Files with `# MAGIC DOC: [title]` header are automatically updated
 * when related code changes are detected.
 *
 * Reference: Claude Code src/services/MagicDocs/magicDocs.ts
 */

import fs from 'fs';
import path from 'path';
import { coworkLog } from './coworkLogger';

// ── Types ──

export interface MagicDocHeader {
  title: string;
  instructions?: string;
}

export interface RegisteredMagicDoc {
  filePath: string;
  title: string;
  instructions?: string;
  registeredAt: number;
  lastUpdatedAt: number;
}

// ── State ──

const registeredDocs = new Map<string, RegisteredMagicDoc>();

// ── Detection ──

const MAGIC_DOC_REGEX = /^#\s*MAGIC\s+DOC:\s*(.+)$/im;
const INSTRUCTIONS_REGEX = /^[_*](.+?)[_*]\s*$/m;

/**
 * Detect magic doc header in file content.
 */
export function detectMagicDocHeader(content: string): MagicDocHeader | null {
  const match = content.match(MAGIC_DOC_REGEX);
  if (!match) return null;

  const title = match[1].trim();
  let instructions: string | undefined;

  // Check next line for italics instructions
  const headerEnd = (match.index ?? 0) + match[0].length;
  const remaining = content.slice(headerEnd).trimStart();
  const instrMatch = remaining.match(INSTRUCTIONS_REGEX);
  if (instrMatch) {
    instructions = instrMatch[1].trim();
  }

  return { title, instructions };
}

/**
 * Register a file as a magic doc (called when Read tool reads a file).
 */
export function registerMagicDoc(filePath: string): boolean {
  if (registeredDocs.has(filePath)) return false;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const header = detectMagicDocHeader(content);
    if (!header) return false;

    registeredDocs.set(filePath, {
      filePath,
      title: header.title,
      instructions: header.instructions,
      registeredAt: Date.now(),
      lastUpdatedAt: 0,
    });

    coworkLog('INFO', 'magicDocs', `Registered: ${header.title} (${filePath})`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file is a registered magic doc.
 */
export function isMagicDoc(filePath: string): boolean {
  return registeredDocs.has(filePath);
}

/**
 * Get all registered magic docs.
 */
export function getRegisteredMagicDocs(): RegisteredMagicDoc[] {
  return Array.from(registeredDocs.values());
}

/**
 * Get magic docs that need updating (not updated since registration or > 1 hour).
 */
export function getMagicDocsNeedingUpdate(): RegisteredMagicDoc[] {
  const now = Date.now();
  return Array.from(registeredDocs.values()).filter(doc => {
    if (doc.lastUpdatedAt === 0) return true; // Never updated
    return now - doc.lastUpdatedAt > 60 * 60 * 1000; // > 1 hour
  });
}

/**
 * Mark a magic doc as updated.
 */
export function markMagicDocUpdated(filePath: string): void {
  const doc = registeredDocs.get(filePath);
  if (doc) doc.lastUpdatedAt = Date.now();
}

/**
 * Build an update prompt for a magic doc.
 * The agent should only use Edit tool on this specific file.
 */
export function buildMagicDocsUpdatePrompt(doc: RegisteredMagicDoc): string {
  const parts = [
    `You are updating a MAGIC DOC file: "${doc.title}"`,
    `File path: ${doc.filePath}`,
  ];

  if (doc.instructions) {
    parts.push(`Instructions: ${doc.instructions}`);
  }

  parts.push(
    '',
    'Rules:',
    '- Only modify this specific file using the Edit tool.',
    '- Keep the # MAGIC DOC: header intact.',
    '- Update content based on recent conversation context.',
    '- Be concise and factual.',
    '- Do not add speculative or unverified information.',
  );

  return parts.join('\n');
}

/**
 * Auto-detect magic docs when Read tool is used.
 * Call this from the Read tool's post-execution hook.
 */
export function onFileRead(filePath: string, content: string): void {
  if (registeredDocs.has(filePath)) return;
  const header = detectMagicDocHeader(content);
  if (header) {
    registerMagicDoc(filePath);
  }
}

/**
 * Clear all registrations.
 */
export function clearMagicDocs(): void {
  registeredDocs.clear();
}
