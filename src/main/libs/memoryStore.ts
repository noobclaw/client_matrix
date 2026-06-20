/**
 * Memory Store — SQLite-backed persistent memory with decay model.
 * Replaces knowledgeGraph.ts with OpenClaw's Dreaming-compatible schema.
 *
 * Features:
 * - 4 memory types: semantic, episodic, procedural, behavioral
 * - 14-day half-life decay for recency weighting
 * - Recall tracking (count + unique queries)
 * - Deduplication support (similarity scoring)
 * - Storage modes: inline, separate, both
 *
 * Ported from OpenClaw src/memory-host-sdk/
 * Enhanced with vector embeddings for semantic search.
 */

import { coworkLog } from './coworkLogger';
import { embed, cosineSimilarity, isEmbeddingAvailable, type EmbeddingResult } from './embeddingProvider';

// ── Types ──

// 4-tier memory taxonomy (from Claude Code src/memdir/memoryTypes.ts):
// user: role/goals/preferences (always private)
// feedback: corrections + confirmations (private or team)
// project: ongoing work/goals/decisions (time-sensitive)
// reference: pointers to external systems
// Plus original types for backward compat:
export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'behavioral' | 'user' | 'feedback' | 'project' | 'reference';
export type StorageMode = 'inline' | 'separate' | 'both';

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  score: number;              // 0-1, importance
  recallCount: number;
  uniqueQueries: number;
  storageMode: StorageMode;
  sourceSessionIds: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  mergedFromIds: string[];    // IDs this memory was merged from (dedup)
  mediaType?: 'text' | 'image' | 'audio' | 'video';  // Multimodal memory support
  mediaPath?: string;         // Original media file path (if applicable)
}

export interface BehavioralPattern {
  id: string;
  description: string;
  strength: number;           // 0-1
  supportingMemoryIds: string[];
  detectedAt: number;
}

export interface MemoryStats {
  total: number;
  byType: Record<MemoryType, number>;
  averageScore: number;
  averageRecalls: number;
  oldestMemory: number | null;
  newestMemory: number | null;
}

// ── Constants ──

const HALF_LIFE_DAYS = 14;
const MAX_MEMORIES_PER_TYPE = 200;
const RECALL_BUDGET_TOKENS = 800;
const CHARS_PER_TOKEN = 4;
const MAX_RECALL_CHARS = RECALL_BUDGET_TOKENS * CHARS_PER_TOKEN;

// ── Database handle (set by init) ──

let db: any = null;

// ── Initialize ──

export function initMemoryStore(database: any): void {
  db = database;

  db.run(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0.5,
    recall_count INTEGER NOT NULL DEFAULT 0,
    unique_queries INTEGER NOT NULL DEFAULT 0,
    storage_mode TEXT NOT NULL DEFAULT 'inline',
    source_session_ids TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL,
    merged_from_ids TEXT DEFAULT '[]',
    embedding BLOB,
    media_type TEXT DEFAULT 'text',
    media_path TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS behavioral_patterns (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    strength REAL NOT NULL,
    supporting_memory_ids TEXT DEFAULT '[]',
    detected_at INTEGER NOT NULL
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_score ON memories(score DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at DESC)`);

  coworkLog('INFO', 'memoryStore', 'Memory store initialized');
}

// ── sql.js query helper (db.exec doesn't support bind params) ──

function queryAll(sql: string, params: any[] = []): Array<Record<string, any>> {
  if (!db) return [];
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results: Array<Record<string, any>> = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  } catch (e) {
    coworkLog('WARN', 'memoryStore', `Query error: ${e}`, { sql: sql.slice(0, 100) });
    return [];
  }
}

function queryOne(sql: string, params: any[] = []): Record<string, any> | null {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

// ── Decay model ──

/**
 * Calculate decayed score based on 14-day half-life.
 * Reference: OpenClaw dreaming.ts — recency weighting
 */
export function decayedScore(record: MemoryRecord): number {
  const daysSinceAccess = (Date.now() - record.lastAccessedAt) / (1000 * 60 * 60 * 24);
  return record.score * Math.pow(0.5, daysSinceAccess / HALF_LIFE_DAYS);
}

// ── CRUD ──

export function storeMemory(params: {
  type: MemoryType;
  content: string;
  score?: number;
  sourceSessionId?: string;
  tags?: string[];
  storageMode?: StorageMode;
}): MemoryRecord {
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  const record: MemoryRecord = {
    id,
    type: params.type,
    content: params.content,
    score: params.score ?? 0.5,
    recallCount: 0,
    uniqueQueries: 0,
    storageMode: params.storageMode ?? 'inline',
    sourceSessionIds: params.sourceSessionId ? [params.sourceSessionId] : [],
    tags: params.tags ?? [],
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    mergedFromIds: [],
  };

  if (db) {
    db.run(
      `INSERT INTO memories (id, type, content, score, recall_count, unique_queries, storage_mode, source_session_ids, tags, created_at, updated_at, last_accessed_at, merged_from_ids, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.type, record.content, record.score, record.recallCount, record.uniqueQueries,
       record.storageMode, JSON.stringify(record.sourceSessionIds), JSON.stringify(record.tags),
       record.createdAt, record.updatedAt, record.lastAccessedAt, JSON.stringify(record.mergedFromIds), null]
    );

    // Generate embedding async (fire-and-forget, don't block store)
    if (isEmbeddingAvailable()) {
      embed(record.content).then(result => {
        if (result && db) {
          const buf = Buffer.from(result.vector.buffer);
          db.run(`UPDATE memories SET embedding = ? WHERE id = ?`, [buf, record.id]);
        }
      }).catch(() => {});
    }
  }

  // Enforce per-type limit
  enforceTypeLimit(params.type);

  return record;
}

export async function recallMemories(query: string, limit: number = 15): Promise<MemoryRecord[]> {
  if (!db) return [];

  // Hybrid search: run vector + keyword in parallel, merge with MMR diversity re-ranking
  const VECTOR_WEIGHT = 0.7;
  const TEXT_WEIGHT = 0.3;

  let vectorResults: Array<{ record: MemoryRecord; score: number }> = [];
  let keywordResults: Array<{ record: MemoryRecord; score: number }> = [];

  // Run searches in parallel
  const vectorPromise = (async () => {
    if (!isEmbeddingAvailable()) return;
    try {
      const queryEmbedding = await embed(query);
      if (!queryEmbedding) return;
      const rows = queryAll(`SELECT * FROM memories WHERE embedding IS NOT NULL LIMIT 500`);
      vectorResults = rows.map(row => {
        const record = objToRecord(row);
        let similarity = 0;
        if (row.embedding) {
          const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
          similarity = cosineSimilarity(queryEmbedding.vector, stored);
        }
        return { record, score: similarity };
      }).filter(r => r.score > 0.1);
    } catch {}
  })();

  // Keyword search (always available)
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);
  const allRows = queryAll(`SELECT * FROM memories ORDER BY score DESC, last_accessed_at DESC LIMIT 200`);
  keywordResults = allRows.map(row => {
    const record = objToRecord(row);
    const contentLower = record.content.toLowerCase();
    const tagStr = record.tags.join(' ').toLowerCase();
    let matchScore = 0;
    for (const kw of keywords) {
      if (contentLower.includes(kw)) matchScore += 1;
      if (tagStr.includes(kw)) matchScore += 0.5;
    }
    return { record, score: matchScore > 0 ? matchScore / keywords.length : 0 };
  }).filter(r => r.score > 0);

  await vectorPromise;

  // Merge: combine vector and keyword scores by memory ID
  const mergedMap = new Map<string, { record: MemoryRecord; vectorScore: number; textScore: number }>();
  for (const v of vectorResults) {
    mergedMap.set(v.record.id, { record: v.record, vectorScore: v.score, textScore: 0 });
  }
  for (const k of keywordResults) {
    const existing = mergedMap.get(k.record.id);
    if (existing) {
      existing.textScore = k.score;
    } else {
      mergedMap.set(k.record.id, { record: k.record, vectorScore: 0, textScore: k.score });
    }
  }

  // Compute hybrid score with temporal decay
  const candidates = Array.from(mergedMap.values()).map(m => {
    const hybridScore = VECTOR_WEIGHT * m.vectorScore + TEXT_WEIGHT * m.textScore;
    const decayed = hybridScore * decayedScore(m.record);
    return { id: m.record.id, text: m.record.content, score: decayed, record: m.record };
  });

  candidates.sort((a, b) => b.score - a.score);

  // Apply MMR diversity re-ranking (fetch 4x candidates for MMR to choose from)
  const topCandidates = candidates.slice(0, limit * 4);
  let results: MemoryRecord[];
  try {
    const { applyMMR } = require('./memoryMMR');
    const mmrResults = applyMMR(topCandidates, limit, 0.7);
    results = mmrResults.map((m: any) => candidates.find(c => c.id === m.id)!.record);
  } catch {
    // Fallback: no MMR, just top-N
    results = topCandidates.slice(0, limit).map(c => c.record);
  }

  updateRecallCounts(results, query);
  return results;
}

function recallMemoriesSemantic(queryEmbedding: EmbeddingResult, limit: number, queryText: string): MemoryRecord[] {
  const rows = queryAll(`SELECT * FROM memories WHERE embedding IS NOT NULL ORDER BY score DESC LIMIT 500`);
  if (rows.length === 0) return recallMemoriesKeyword(queryText, limit);

  const scored = rows.map(row => {
    const record = objToRecord(row);
    let similarity = 0;
    if (row.embedding) {
      const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
      similarity = cosineSimilarity(queryEmbedding.vector, stored);
    }
    const effective = similarity * 0.7 + decayedScore(record) * 0.3;
    return { record, effective };
  });

  scored.sort((a, b) => b.effective - a.effective);
  const results = scored.slice(0, limit).filter(s => s.effective > 0.1).map(s => s.record);
  updateRecallCounts(results, queryText);
  return results;
}

function recallMemoriesKeyword(query: string, limit: number): MemoryRecord[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);
  const rows = queryAll(`SELECT * FROM memories ORDER BY score DESC, last_accessed_at DESC LIMIT 200`);

  if (rows.length === 0) return [];

  const allRecords = rows.map(objToRecord);

  // Score by keyword matches + decay
  const scored = allRecords.map((rec: MemoryRecord) => {
    const contentLower = rec.content.toLowerCase();
    const tagStr = rec.tags.join(' ').toLowerCase();
    let matchScore = 0;
    for (const kw of keywords) {
      if (contentLower.includes(kw)) matchScore += 1;
      if (tagStr.includes(kw)) matchScore += 0.5;
    }
    const effective = matchScore > 0 ? decayedScore(rec) + matchScore * 0.1 : decayedScore(rec) * 0.1;
    return { record: rec, effective };
  }).filter((s: any) => s.effective > 0.01);

  scored.sort((a: any, b: any) => b.effective - a.effective);
  const results = scored.slice(0, limit).map((s: any) => s.record);

  updateRecallCounts(results, query);
  return results;
}

function updateRecallCounts(results: MemoryRecord[], query: string): void {
  if (!db || results.length === 0) return;
  const queryHash = simpleHash(query);
  const now = Date.now();
  for (const rec of results) {
    const seenHashes = rec.tags.filter((t: string) => t.startsWith('qh:'));
    const isNewQuery = !seenHashes.includes(`qh:${queryHash}`);
    if (isNewQuery) {
      const updatedTags = [...rec.tags, `qh:${queryHash}`];
      const trimmedTags = updatedTags.filter((t: string) => !t.startsWith('qh:')).concat(
        updatedTags.filter((t: string) => t.startsWith('qh:')).slice(-50)
      );
      db.run(`UPDATE memories SET recall_count = recall_count + 1, unique_queries = unique_queries + 1, tags = ?, last_accessed_at = ? WHERE id = ?`,
        [JSON.stringify(trimmedTags), now, rec.id]);
    } else {
      db.run(`UPDATE memories SET recall_count = recall_count + 1, last_accessed_at = ? WHERE id = ?`, [now, rec.id]);
    }
  }
}

export function getMemoriesByType(type: MemoryType, limit: number = 50): MemoryRecord[] {
  if (!db) return [];
  return queryAll(`SELECT * FROM memories WHERE type = ? ORDER BY score DESC, last_accessed_at DESC LIMIT ?`, [type, limit]).map(objToRecord);
}

export function getRecentMemories(lookbackMs: number, limit: number = 100): MemoryRecord[] {
  if (!db) return [];
  const cutoff = Date.now() - lookbackMs;
  return queryAll(`SELECT * FROM memories WHERE created_at > ? ORDER BY created_at DESC LIMIT ?`, [cutoff, limit]).map(objToRecord);
}

export function getHighFrequencyMemories(minRecalls: number = 3, minUniqueQueries: number = 3, limit: number = 10): MemoryRecord[] {
  if (!db) return [];
  return queryAll(`SELECT * FROM memories WHERE recall_count >= ? AND unique_queries >= ? AND score >= 0.8 ORDER BY recall_count DESC LIMIT ?`, [minRecalls, minUniqueQueries, limit]).map(objToRecord);
}

export function updateMemory(id: string, updates: Partial<Pick<MemoryRecord, 'content' | 'score' | 'tags' | 'type'>>): boolean {
  if (!db) return false;
  const sets: string[] = [];
  const values: any[] = [];

  if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content); }
  if (updates.score !== undefined) { sets.push('score = ?'); values.push(updates.score); }
  if (updates.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(updates.tags)); }
  if (updates.type !== undefined) { sets.push('type = ?'); values.push(updates.type); }

  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);

  db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, values);
  return true;
}

export function deleteMemory(id: string): boolean {
  if (!db) return false;
  db.run(`DELETE FROM memories WHERE id = ?`, [id]);
  return true;
}

export function mergeMemories(keepId: string, mergeIds: string[], mergedContent: string): boolean {
  if (!db) return false;
  const now = Date.now();

  // Update the kept memory
  db.run(
    `UPDATE memories SET content = ?, merged_from_ids = ?, updated_at = ? WHERE id = ?`,
    [mergedContent, JSON.stringify(mergeIds), now, keepId]
  );

  // Delete merged memories
  for (const id of mergeIds) {
    if (id !== keepId) db.run(`DELETE FROM memories WHERE id = ?`, [id]);
  }

  return true;
}

// ── Multimodal memory (image/audio/video → description → store) ──
// Reference: OpenClaw src/memory-host-sdk/multimodal.ts

/**
 * Store a memory from a media file. Automatically generates a text description
 * using vision/transcription APIs, then stores both the description and media reference.
 */
export async function storeMultimodalMemory(params: {
  mediaPath: string;
  mediaType: 'image' | 'audio' | 'video';
  context?: string;          // Additional context about when/where this media appeared
  sourceSessionId?: string;
  score?: number;
}): Promise<MemoryRecord | null> {
  try {
    let description = '';

    // Lazy import to avoid circular dependency
    const { describeImage, transcribeAudio, describeVideo } = await import('./mediaUnderstanding');

    switch (params.mediaType) {
      case 'image':
        description = await describeImage(params.mediaPath, params.context || 'Describe this image for memory storage.');
        break;
      case 'audio':
        description = await transcribeAudio(params.mediaPath);
        break;
      case 'video':
        description = await describeVideo(params.mediaPath, 2);
        break;
    }

    if (!description || description.startsWith('Error') || description.includes('not found')) {
      return null;
    }

    const content = params.context
      ? `[${params.mediaType}] ${params.context}: ${description}`
      : `[${params.mediaType}] ${description}`;

    const record = storeMemory({
      type: 'episodic',
      content,
      score: params.score ?? 0.6,
      sourceSessionId: params.sourceSessionId,
      tags: [`media:${params.mediaType}`],
    });

    // Update media fields
    if (db) {
      db.run(`UPDATE memories SET media_type = ?, media_path = ? WHERE id = ?`,
        [params.mediaType, params.mediaPath, record.id]);
    }

    coworkLog('INFO', 'memoryStore', `Stored ${params.mediaType} memory: ${record.id} — ${description.slice(0, 80)}`);
    return record;
  } catch (e) {
    coworkLog('WARN', 'memoryStore', `Multimodal store failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── Behavioral patterns ──

export function storeBehavioralPattern(pattern: Omit<BehavioralPattern, 'id'>): BehavioralPattern {
  const id = `pat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full: BehavioralPattern = { id, ...pattern };

  if (db) {
    db.run(
      `INSERT INTO behavioral_patterns (id, description, strength, supporting_memory_ids, detected_at) VALUES (?, ?, ?, ?, ?)`,
      [full.id, full.description, full.strength, JSON.stringify(full.supportingMemoryIds), full.detectedAt]
    );
  }

  return full;
}

export function getBehavioralPatterns(minStrength: number = 0.5): BehavioralPattern[] {
  if (!db) return [];
  return queryAll(`SELECT * FROM behavioral_patterns WHERE strength >= ? ORDER BY strength DESC`, [minStrength]).map(row => ({
    id: row.id as string,
    description: row.description as string,
    strength: row.strength as number,
    supportingMemoryIds: JSON.parse(row.supporting_memory_ids as string || '[]'),
    detectedAt: row.detected_at as number,
  }));
}

// ── Stats ──

export function getMemoryStats(): MemoryStats {
  if (!db) return { total: 0, byType: { semantic: 0, episodic: 0, procedural: 0, behavioral: 0, user: 0, feedback: 0, project: 0, reference: 0 }, averageScore: 0, averageRecalls: 0, oldestMemory: null, newestMemory: null };

  const countRows = queryAll(`SELECT type, COUNT(*) as cnt FROM memories GROUP BY type`);
  const byType: Record<MemoryType, number> = { semantic: 0, episodic: 0, procedural: 0, behavioral: 0, user: 0, feedback: 0, project: 0, reference: 0 };
  let total = 0;
  for (const row of countRows) {
    byType[row.type as MemoryType] = row.cnt as number;
    total += row.cnt as number;
  }

  const avg = queryOne(`SELECT AVG(score) as avg_score, AVG(recall_count) as avg_recalls, MIN(created_at) as oldest, MAX(created_at) as newest FROM memories`) || {};

  return {
    total,
    byType,
    averageScore: (avg.avg_score as number) || 0,
    averageRecalls: (avg.avg_recalls as number) || 0,
    oldestMemory: (avg.oldest as number) ?? null,
    newestMemory: (avg.newest as number) ?? null,
  };
}

// ── Format for prompt injection ──

export function formatMemoriesForPrompt(memories: MemoryRecord[]): string {
  if (memories.length === 0) return '';

  let totalChars = 0;
  const lines: string[] = ['<memories>'];

  for (const mem of memories) {
    const line = `- [${mem.type}] ${mem.content}`;
    if (totalChars + line.length > MAX_RECALL_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }

  lines.push('</memories>');
  return lines.join('\n');
}

// ── Helpers ──

function objToRecord(obj: Record<string, any>): MemoryRecord {
  return {
    id: obj.id,
    type: obj.type,
    content: obj.content,
    score: obj.score,
    recallCount: obj.recall_count,
    uniqueQueries: obj.unique_queries,
    storageMode: obj.storage_mode,
    sourceSessionIds: JSON.parse(obj.source_session_ids || '[]'),
    tags: JSON.parse(obj.tags || '[]'),
    createdAt: obj.created_at,
    updatedAt: obj.updated_at,
    lastAccessedAt: obj.last_accessed_at,
    mergedFromIds: JSON.parse(obj.merged_from_ids || '[]'),
  };
}

function enforceTypeLimit(type: MemoryType): void {
  if (!db) return;
  const row = queryOne(`SELECT COUNT(*) as cnt FROM memories WHERE type = ?`, [type]);
  const count = (row?.cnt as number) || 0;

  if (count > MAX_MEMORIES_PER_TYPE) {
    const excess = count - MAX_MEMORIES_PER_TYPE;
    db.run(
      `DELETE FROM memories WHERE id IN (SELECT id FROM memories WHERE type = ? ORDER BY score ASC, last_accessed_at ASC LIMIT ?)`,
      [type, excess]
    );
    coworkLog('INFO', 'memoryStore', `Evicted ${excess} low-score ${type} memories (LRU)`);
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

// ── QMD Format Export/Import ──
// Reference: OpenClaw src/memory-host-sdk/engine-qmd.ts
// QMD = Quick Memory Document, a compact text format for memory interchange

export function exportToQMD(): string {
  const lines: string[] = ['# NoobClaw Memory Export (QMD Format)', `# Exported: ${new Date().toISOString()}`, ''];

  const allMemories = queryAll(`SELECT * FROM memories ORDER BY type, score DESC`).map(objToRecord);

  let currentType = '';
  for (const mem of allMemories) {
    if (mem.type !== currentType) {
      currentType = mem.type;
      lines.push(`## ${currentType.toUpperCase()}`, '');
    }
    lines.push(`- [${mem.score.toFixed(2)}] ${mem.content}`);
    if (mem.tags.filter((t: string) => !t.startsWith('qh:')).length > 0) {
      lines.push(`  tags: ${mem.tags.filter((t: string) => !t.startsWith('qh:')).join(', ')}`);
    }
    lines.push('');
  }

  const patterns = getBehavioralPatterns(0);
  if (patterns.length > 0) {
    lines.push('## PATTERNS', '');
    for (const p of patterns) {
      lines.push(`- [${p.strength.toFixed(2)}] ${p.description}`, '');
    }
  }

  return lines.join('\n');
}

export function importFromQMD(qmd: string): number {
  let imported = 0;
  let currentType: MemoryType = 'semantic';

  for (const line of qmd.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## SEMANTIC')) { currentType = 'semantic'; continue; }
    if (trimmed.startsWith('## EPISODIC')) { currentType = 'episodic'; continue; }
    if (trimmed.startsWith('## PROCEDURAL')) { currentType = 'procedural'; continue; }
    if (trimmed.startsWith('## BEHAVIORAL')) { currentType = 'behavioral'; continue; }

    const match = trimmed.match(/^- \[(\d+\.\d+)\] (.+)$/);
    if (match) {
      storeMemory({ type: currentType, content: match[2], score: parseFloat(match[1]) });
      imported++;
    }
  }

  coworkLog('INFO', 'memoryStore', `QMD import: ${imported} memories`);
  return imported;
}

// ── Memory Runtime Interface ──
// Reference: OpenClaw src/memory-host-sdk/runtime.ts

export interface MemoryRuntime {
  store(params: { type: MemoryType; content: string; score?: number; tags?: string[] }): MemoryRecord;
  recall(query: string, limit?: number): Promise<MemoryRecord[]>;
  search(type?: MemoryType, limit?: number): MemoryRecord[];
  update(id: string, updates: Partial<Pick<MemoryRecord, 'content' | 'score' | 'tags'>>): boolean;
  remove(id: string): boolean;
  stats(): MemoryStats;
  exportQMD(): string;
  importQMD(qmd: string): number;
}

export function createMemoryRuntime(): MemoryRuntime {
  return {
    store: storeMemory,
    recall: recallMemories,
    search: (type, limit) => type ? getMemoriesByType(type, limit) : queryAll('SELECT * FROM memories ORDER BY score DESC LIMIT ?', [limit || 50]).map(objToRecord),
    update: updateMemory,
    remove: deleteMemory,
    stats: getMemoryStats,
    exportQMD: exportToQMD,
    importQMD: importFromQMD,
  };
}
