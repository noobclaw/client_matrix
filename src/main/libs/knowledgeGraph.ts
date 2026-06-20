/**
 * Knowledge Graph — Extracts entities and relationships from conversations,
 * stores them in SQLite, and provides contextual retrieval for prompt injection.
 *
 * Uses sql.js (same as CoworkStore) instead of better-sqlite3 for sidecar compatibility.
 * The Database instance is passed in from the caller to avoid native module dependencies.
 */

import path from 'path';
import fs from 'fs';
import { getUserDataPath } from './platformAdapter';

const DB_NAME = 'knowledge-graph.db';
const MAX_CONTEXT_TOKENS = 800;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * APPROX_CHARS_PER_TOKEN;

// sql.js database instance (compatible with both Electron and sidecar)
let db: any = null;
let dbPath: string = '';
let sqlJsModule: any = null;

// --- Database Setup ---

export function initKnowledgeGraph(): void {
  try {
    dbPath = path.join(getUserDataPath(), DB_NAME);

    // Try to get sql.js — it should already be loaded by SqliteStore
    try {
      sqlJsModule = require('sql.js');
    } catch {
      console.warn('[KnowledgeGraph] sql.js not available, skipping');
      return;
    }

    // Initialize async (sql.js needs async init for WASM)
    initAsync().catch(err => {
      console.error('[KnowledgeGraph] Async init failed:', err);
      db = null;
    });
  } catch (err) {
    console.error('[KnowledgeGraph] Failed to initialize:', err);
    db = null;
  }
}

async function initAsync(): Promise<void> {
  const SQL = await sqlJsModule();

  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  createTables();
  saveDb();
  console.log('[KnowledgeGraph] Initialized:', dbPath);
}

function saveDb(): void {
  if (!db || !dbPath) return;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch {}
}

function execQuery(sql: string, params: any[] = []): any[] {
  if (!db) return [];
  try {
    return db.exec(sql, params);
  } catch {
    return [];
  }
}

function runSql(sql: string, params: any[] = []): void {
  if (!db) return;
  try {
    db.run(sql, params);
  } catch {}
}

function createTables(): void {
  if (!db) return;

  runSql(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 1
    );
  `);

  runSql(`
    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      confidence REAL NOT NULL DEFAULT 0.8,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE
    );
  `);

  runSql(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      source_session TEXT,
      created_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      decay_factor REAL NOT NULL DEFAULT 1.0
    );
  `);

  runSql('CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);');
  runSql('CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);');
  runSql('CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);');
  runSql('CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);');
  runSql('CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);');
  runSql('CREATE INDEX IF NOT EXISTS idx_memories_last_used ON memories(last_used DESC);');
}

// --- Public API ---

export interface ExtractionResult {
  entities: Array<{ name: string; type: string; description?: string }>;
  relations: Array<{ source: string; target: string; type: string; description?: string }>;
  memories: Array<{ type: string; content: string; confidence?: number }>;
}

export function getExtractionPrompt(userMessage: string, assistantMessage: string): string {
  return `Extract structured knowledge from this conversation turn.

User: ${userMessage.slice(0, 500)}
Assistant: ${assistantMessage.slice(0, 500)}

Return JSON with:
- entities: [{name, type, description}] (types: person, tech, project, concept, location)
- relations: [{source, target, type, description}] (types: uses, knows, works_on, prefers, located_in)
- memories: [{type, content, confidence}] (types: semantic, episodic, procedural)

Only extract clear, factual information. Skip vague or uncertain items.
Return ONLY valid JSON, no markdown.`;
}

export function storeExtractionResult(result: ExtractionResult, sessionId?: string): void {
  if (!db) return;
  const now = Date.now();

  try {
    // Store entities
    for (const entity of (result.entities || [])) {
      if (!entity.name || !entity.type) continue;
      const id = `${entity.type}:${entity.name}`.toLowerCase();
      const existing = execQuery('SELECT id, mention_count FROM entities WHERE id = ?', [id]);
      if (existing[0]?.values?.[0]) {
        const count = (existing[0].values[0][1] as number) + 1;
        runSql('UPDATE entities SET last_seen = ?, mention_count = ?, description = COALESCE(?, description) WHERE id = ?',
          [now, count, entity.description || null, id]);
      } else {
        runSql('INSERT INTO entities (id, name, type, description, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
          [id, entity.name, entity.type, entity.description || null, now, now]);
      }
    }

    // Store relations
    for (const rel of (result.relations || [])) {
      if (!rel.source || !rel.target || !rel.type) continue;
      const sourceId = `${rel.source}`.toLowerCase();
      const targetId = `${rel.target}`.toLowerCase();
      const id = `${sourceId}-${rel.type}-${targetId}`;
      const existing = execQuery('SELECT id FROM relations WHERE id = ?', [id]);
      if (existing[0]?.values?.[0]) {
        runSql('UPDATE relations SET last_seen = ?, mention_count = mention_count + 1 WHERE id = ?', [now, id]);
      } else {
        runSql('INSERT INTO relations (id, source_id, target_id, type, description, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, sourceId, targetId, rel.type, rel.description || null, now, now]);
      }
    }

    // Store memories
    for (const mem of (result.memories || [])) {
      if (!mem.content || !mem.type) continue;
      const id = require('crypto').randomUUID();
      runSql('INSERT INTO memories (id, type, content, confidence, source_session, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, mem.type, mem.content, mem.confidence || 0.8, sessionId || null, now, now]);
    }

    saveDb();
  } catch (err) {
    console.error('[KnowledgeGraph] Store extraction error:', err);
  }
}

export function queryRelevantContext(userMessage: string): string {
  if (!db) return '';

  try {
    const terms = userMessage
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
      .slice(0, 10);

    if (terms.length === 0) return '';

    const parts: string[] = [];

    // Query recent memories
    const memories = execQuery(
      'SELECT type, content FROM memories ORDER BY last_used DESC, confidence DESC LIMIT 10'
    );
    if (memories[0]?.values) {
      for (const row of memories[0].values) {
        const content = String(row[1]);
        if (terms.some(t => content.toLowerCase().includes(t))) {
          parts.push(`[${row[0]}] ${content}`);
        }
      }
    }

    // Query matching entities
    for (const term of terms.slice(0, 5)) {
      const entities = execQuery(
        "SELECT name, type, description FROM entities WHERE LOWER(name) LIKE ? ORDER BY mention_count DESC LIMIT 3",
        [`%${term}%`]
      );
      if (entities[0]?.values) {
        for (const row of entities[0].values) {
          const desc = row[2] ? ` — ${row[2]}` : '';
          parts.push(`[${row[1]}] ${row[0]}${desc}`);
        }
      }
    }

    const context = [...new Set(parts)].join('\n').slice(0, MAX_CONTEXT_CHARS);
    return context ? `\n## Relevant Context\n${context}` : '';
  } catch {
    return '';
  }
}
