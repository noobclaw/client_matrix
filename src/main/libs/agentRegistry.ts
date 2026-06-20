/**
 * Agent Registry — manages named agent definitions.
 * Each agent has its own system prompt, tool whitelist, and model config.
 *
 * Ported from OpenClaw src/routing/ + src/agents/agent-scope.ts
 * Simplified: no guild/team/account tiers, single-user Electron.
 */

import { v4 as uuidv4 } from 'uuid';
import { coworkLog } from './coworkLogger';

// ── Constants ──

export const DEFAULT_AGENT_ID = 'main';
export const DEFAULT_MAIN_KEY = 'main';

// Agent ID validation (from OpenClaw routing/session-key.ts)
const VALID_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const INVALID_CHARS_RE = /[^a-z0-9-]/g;

// ── Types ──

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string | null;       // null = use default system prompt
  toolWhitelist: string[] | null;    // null = all tools available
  toolBlacklist: string[];           // tools to exclude
  model: string | null;              // null = use default model
  maxTurns: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAgentParams {
  id?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  toolWhitelist?: string[];
  toolBlacklist?: string[];
  model?: string;
  maxTurns?: number;
}

// ── In-memory registry ──

const agents = new Map<string, AgentDefinition>();

// Initialize with default "main" agent
agents.set(DEFAULT_AGENT_ID, {
  id: DEFAULT_AGENT_ID,
  name: 'Main Agent',
  description: 'The primary agent that handles user requests directly.',
  systemPrompt: null,
  toolWhitelist: null,
  toolBlacklist: [],
  model: null,
  maxTurns: 100,
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// ── Agent ID utilities (from OpenClaw routing/session-key.ts) ──

export function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase().replace(INVALID_CHARS_RE, '-').replace(/^-+|-+$/g, '');
}

export function isValidAgentId(value: string): boolean {
  return VALID_ID_RE.test(value) && value.length > 0 && value.length <= 64;
}

// ── Session key management (from OpenClaw routing/session-key.ts) ──

export function buildAgentSessionKey(agentId: string, sessionId: string): string {
  return `agent:${normalizeAgentId(agentId)}:${sessionId}`;
}

export function buildAgentMainSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:${DEFAULT_MAIN_KEY}`;
}

export function resolveAgentIdFromSessionKey(key: string): string | null {
  const match = key.match(/^agent:([^:]+):/);
  return match ? match[1] : null;
}

// ── CRUD operations ──

export function registerAgent(params: CreateAgentParams): AgentDefinition {
  const id = params.id ? normalizeAgentId(params.id) : normalizeAgentId(params.name);

  if (!isValidAgentId(id)) {
    throw new Error(`Invalid agent ID: "${id}". Must be lowercase alphanumeric with dashes.`);
  }

  const now = Date.now();
  const agent: AgentDefinition = {
    id,
    name: params.name,
    description: params.description || '',
    systemPrompt: params.systemPrompt ?? null,
    toolWhitelist: params.toolWhitelist ?? null,
    toolBlacklist: params.toolBlacklist ?? [],
    model: params.model ?? null,
    maxTurns: params.maxTurns ?? 100,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  agents.set(id, agent);
  coworkLog('INFO', 'agentRegistry', `Agent registered: ${id} (${agent.name})`);
  return agent;
}

export function updateAgent(id: string, updates: Partial<Omit<AgentDefinition, 'id' | 'createdAt'>>): AgentDefinition | null {
  const agent = agents.get(id);
  if (!agent) return null;

  Object.assign(agent, updates, { updatedAt: Date.now() });
  coworkLog('INFO', 'agentRegistry', `Agent updated: ${id}`);
  return agent;
}

export function deleteAgent(id: string): boolean {
  if (id === DEFAULT_AGENT_ID) {
    coworkLog('WARN', 'agentRegistry', 'Cannot delete the default main agent');
    return false;
  }
  const deleted = agents.delete(id);
  if (deleted) {
    coworkLog('INFO', 'agentRegistry', `Agent deleted: ${id}`);
  }
  return deleted;
}

export function getAgent(id: string): AgentDefinition | null {
  return agents.get(id) ?? null;
}

export function getDefaultAgent(): AgentDefinition {
  return agents.get(DEFAULT_AGENT_ID)!;
}

export function listAgents(): AgentDefinition[] {
  return Array.from(agents.values()).filter(a => a.enabled);
}

export function listAllAgents(): AgentDefinition[] {
  return Array.from(agents.values());
}

// ── Agent resolution ──

/**
 * Resolve which agent should handle a request.
 * Simplified 3-tier routing (from OpenClaw's 8-tier):
 * 1. Explicit agent ID match
 * 2. Default agent
 */
export function resolveAgent(agentId?: string): AgentDefinition {
  if (agentId) {
    const normalized = normalizeAgentId(agentId);
    const agent = agents.get(normalized);
    if (agent && agent.enabled) return agent;
    coworkLog('WARN', 'agentRegistry', `Agent "${agentId}" not found or disabled, using default`);
  }
  return getDefaultAgent();
}

// ── Tool filtering ──

/**
 * Filter tools based on agent's whitelist/blacklist.
 */
export function filterToolsForAgent(
  agent: AgentDefinition,
  allTools: Array<{ name: string }>
): Array<{ name: string }> {
  let filtered = [...allTools];

  // Apply whitelist (if specified, only include these tools)
  if (agent.toolWhitelist && agent.toolWhitelist.length > 0) {
    const whitelist = new Set(agent.toolWhitelist);
    filtered = filtered.filter(t => whitelist.has(t.name));
  }

  // Apply blacklist
  if (agent.toolBlacklist.length > 0) {
    const blacklist = new Set(agent.toolBlacklist);
    filtered = filtered.filter(t => !blacklist.has(t.name));
  }

  return filtered;
}

// ── Bulk load (for persistence restoration) ──

export function loadAgents(defs: AgentDefinition[]): void {
  for (const def of defs) {
    if (def.id !== DEFAULT_AGENT_ID) {
      agents.set(def.id, def);
    }
  }
  coworkLog('INFO', 'agentRegistry', `Loaded ${defs.length} agents from storage`);
}
