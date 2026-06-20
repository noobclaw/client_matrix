/**
 * Session Memory — ported from Claude Code services/SessionMemory/
 *
 * Continuously extracts key conversation points into a structured markdown
 * file in the background. This file is used by the compact system as a
 * lightweight alternative to full LLM summarization.
 *
 * Architecture:
 * - After each completed turn, check if extraction thresholds are met
 * - If yes, make a background API call to extract/update session notes
 * - Session notes persist as a file on disk per session
 * - Compact system reads this file instead of re-summarizing the full conversation
 */

import * as fs from 'fs';
import * as path from 'path';
import { getUserDataPath } from './platformAdapter';
import { coworkLog } from './coworkLogger';
import { estimateTokens } from './coworkCompact';

// ── Session Memory Template (from Claude Code SessionMemory/prompts.ts) ──

const SESSION_MEMORY_TEMPLATE = `# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task Specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key Results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

const EXTRACTION_SYSTEM_PROMPT = `You are a session memory extraction agent. Your job is to analyze the recent conversation and produce a concise, structured summary of what happened.

CRITICAL RULES:
- Respond with TEXT ONLY containing the updated session notes.
- Output the FULL document with all sections, not just changed sections.
- Maintain the exact section structure with all headers.
- NEVER remove or rename section headers.
- Keep italic descriptions under each header.
- Write DETAILED, INFO-DENSE content below each section's italic description.
- Keep each section under ~2000 tokens.
- Always update "Current State" to reflect the latest work.
- Be terse but complete — include file names, function names, error messages.`;

// ── Configuration ──

interface SessionMemoryConfig {
  /** Minimum conversation tokens before first extraction (default: 8000) */
  minTokensToInit: number;
  /** Minimum token growth between extractions (default: 4000) */
  minTokensBetweenUpdates: number;
  /** Minimum completed turns between extractions (default: 3) */
  minTurnsBetweenUpdates: number;
}

const DEFAULT_CONFIG: SessionMemoryConfig = {
  minTokensToInit: 8_000,
  minTokensBetweenUpdates: 4_000,
  minTurnsBetweenUpdates: 3,
};

// ── Per-session state ──

interface SessionMemoryState {
  tokensAtLastExtraction: number;
  turnsAtLastExtraction: number;
  isExtracting: boolean;
  consecutiveFailures: number;
  initialized: boolean;
  filePath: string;
}

const sessionStates = new Map<string, SessionMemoryState>();

// ── File paths ──

function getSessionMemoryDir(): string {
  const userDataPath = getUserDataPath();
  return path.join(userDataPath, 'session-memory');
}

function getSessionMemoryPath(sessionId: string): string {
  const dir = getSessionMemoryDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Sanitize session ID for filesystem safety
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safeId}.md`);
}

function getState(sessionId: string): SessionMemoryState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = {
      tokensAtLastExtraction: 0,
      turnsAtLastExtraction: 0,
      isExtracting: false,
      consecutiveFailures: 0,
      initialized: false,
      filePath: getSessionMemoryPath(sessionId),
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

// ── Threshold checks ──

/**
 * Check if session memory extraction should run.
 */
export function shouldExtractSessionMemory(
  sessionId: string,
  messages: Array<{ content?: string; type?: string }>,
  turnCount: number,
  config: Partial<SessionMemoryConfig> = {}
): boolean {
  const state = getState(sessionId);
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Circuit breaker
  if (state.consecutiveFailures >= 3) return false;
  if (state.isExtracting) return false;

  const currentTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);

  // First extraction: need minimum tokens
  if (!state.initialized) {
    return currentTokens >= cfg.minTokensToInit;
  }

  // Subsequent: need both token growth AND turn count
  const tokenGrowth = currentTokens - state.tokensAtLastExtraction;
  const turnGrowth = turnCount - state.turnsAtLastExtraction;

  return tokenGrowth >= cfg.minTokensBetweenUpdates && turnGrowth >= cfg.minTurnsBetweenUpdates;
}

/**
 * Build the extraction prompt from current conversation messages.
 */
export function buildExtractionPrompt(
  messages: Array<{ content?: string; type?: string }>,
  sessionId: string
): { systemPrompt: string; userMessage: string } {
  const state = getState(sessionId);

  // Read existing notes or use template
  let currentNotes = SESSION_MEMORY_TEMPLATE;
  try {
    if (fs.existsSync(state.filePath)) {
      currentNotes = fs.readFileSync(state.filePath, 'utf8');
    }
  } catch {}

  // Build conversation excerpt (last ~20 messages or 30K chars)
  const MAX_CHARS = 30_000;
  let excerpt = '';
  for (let i = messages.length - 1; i >= 0 && excerpt.length < MAX_CHARS; i--) {
    const msg = messages[i];
    const prefix = msg.type === 'user' ? 'User' : msg.type === 'assistant' ? 'Assistant' : 'System';
    const content = msg.content?.trim();
    if (content) {
      excerpt = `[${prefix}]: ${content.slice(0, 3000)}\n\n` + excerpt;
    }
  }

  const userMessage = `Here are the current session notes:

<current_notes>
${currentNotes}
</current_notes>

Here is the recent conversation to analyze:

<conversation>
${excerpt}
</conversation>

Update the session notes based on the conversation above. Output the COMPLETE updated document with all sections. Keep the exact structure — all headers, all italic descriptions. Only update content below the italic descriptions.`;

  return { systemPrompt: EXTRACTION_SYSTEM_PROMPT, userMessage };
}

/**
 * Execute session memory extraction via API call.
 * Writes the result to the session memory file.
 */
export async function extractSessionMemory(
  sessionId: string,
  messages: Array<{ content?: string; type?: string }>,
  turnCount: number,
  apiConfig: { apiKey: string; model: string; baseURL?: string }
): Promise<boolean> {
  const state = getState(sessionId);

  if (state.isExtracting) {
    coworkLog('WARN', 'extractSessionMemory', 'Already extracting, skipping');
    return false;
  }

  state.isExtracting = true;

  try {
    const { systemPrompt, userMessage } = buildExtractionPrompt(messages, sessionId);

    coworkLog('INFO', 'extractSessionMemory', `Extracting session memory for ${sessionId}`);

    const url = `${apiConfig.baseURL || 'https://api.anthropic.com'}/v1/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiConfig.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: apiConfig.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      coworkLog('ERROR', 'extractSessionMemory', `API error: ${response.status} ${errorText.slice(0, 300)}`);
      state.consecutiveFailures++;
      return false;
    }

    const data = await response.json();
    const rawText = data?.content?.[0]?.text;
    if (!rawText || rawText.trim().length < 50) {
      coworkLog('ERROR', 'extractSessionMemory', 'Empty or too-short extraction result');
      state.consecutiveFailures++;
      return false;
    }

    // Write to file
    fs.writeFileSync(state.filePath, rawText, 'utf8');

    // Update state
    const currentTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
    state.tokensAtLastExtraction = currentTokens;
    state.turnsAtLastExtraction = turnCount;
    state.consecutiveFailures = 0;
    state.initialized = true;

    coworkLog('INFO', 'extractSessionMemory', `Session memory written to ${state.filePath} (${rawText.length} chars)`);
    return true;
  } catch (error) {
    coworkLog('ERROR', 'extractSessionMemory', `Extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    state.consecutiveFailures++;
    return false;
  } finally {
    state.isExtracting = false;
  }
}

/**
 * Read the session memory content for a given session.
 * Returns null if no memory file exists.
 */
export function getSessionMemoryContent(sessionId: string): string | null {
  const state = getState(sessionId);
  try {
    if (fs.existsSync(state.filePath)) {
      return fs.readFileSync(state.filePath, 'utf8');
    }
  } catch {}
  return null;
}

/**
 * Clean up session memory state for a session.
 */
export function clearSessionMemoryState(sessionId: string): void {
  sessionStates.delete(sessionId);
}
