/**
 * Hook System — event bus for agent lifecycle and external triggers.
 * Ported from OpenClaw src/hooks/ (51 files, simplified to core pattern).
 *
 * Events can trigger: new sessions, tasks, or notifications.
 */

import { coworkLog } from './coworkLogger';

// ── Event types (from OpenClaw hooks/internal-hooks.ts) ──

export type HookEventType =
  | 'message:received'
  | 'message:sent'
  | 'session:start'
  | 'session:end'
  | 'task:complete'
  | 'task:failed'
  | 'webhook:received'
  | 'gmail:new_email'
  | 'cron:fired'
  | 'agent:error';

export interface HookEvent {
  type: HookEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export type HookAction = 'start_session' | 'run_task' | 'notify' | 'custom';

export interface HookHandler {
  id: string;
  event: HookEventType;
  action: HookAction;
  config: Record<string, unknown>;
  enabled: boolean;
}

export type HookCallback = (event: HookEvent) => void | Promise<void>;

// ── Global singleton registry (from OpenClaw pattern) ──

const handlers = new Map<HookEventType, Map<string, HookCallback>>();
const registeredHooks: HookHandler[] = [];

// ── Register / Unregister ──

export function registerHook(
  eventType: HookEventType,
  id: string,
  callback: HookCallback
): void {
  let map = handlers.get(eventType);
  if (!map) {
    map = new Map();
    handlers.set(eventType, map);
  }
  map.set(id, callback);
  coworkLog('INFO', 'hookSystem', `Hook registered: ${id} → ${eventType}`);
}

export function unregisterHook(eventType: HookEventType, id: string): boolean {
  const map = handlers.get(eventType);
  if (!map) return false;
  const deleted = map.delete(id);
  if (deleted) coworkLog('INFO', 'hookSystem', `Hook unregistered: ${id}`);
  return deleted;
}

// ── Emit (sequential, error-isolated) ──

export async function emitHookEvent(event: HookEvent): Promise<void> {
  const map = handlers.get(event.type);
  if (!map || map.size === 0) return;

  coworkLog('INFO', 'hookSystem', `Emitting ${event.type} to ${map.size} handlers`);

  for (const [id, callback] of map) {
    try {
      await callback(event);
    } catch (e) {
      coworkLog('ERROR', 'hookSystem', `Hook ${id} error on ${event.type}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function hasListeners(eventType: HookEventType): boolean {
  const map = handlers.get(eventType);
  return !!map && map.size > 0;
}

export function getRegisteredEventTypes(): HookEventType[] {
  return Array.from(handlers.keys()).filter(k => (handlers.get(k)?.size ?? 0) > 0);
}

// ── Convenience emitters ──

export function emitMessageReceived(data: { sender: string; content: string; channel?: string }): void {
  emitHookEvent({ type: 'message:received', timestamp: Date.now(), data }).catch(() => {});
}

export function emitSessionStart(data: { sessionId: string; prompt?: string }): void {
  emitHookEvent({ type: 'session:start', timestamp: Date.now(), data }).catch(() => {});
}

export function emitSessionEnd(data: { sessionId: string; status: string }): void {
  emitHookEvent({ type: 'session:end', timestamp: Date.now(), data }).catch(() => {});
}

export function emitWebhookReceived(data: { path: string; method: string; body: unknown; headers: Record<string, string> }): void {
  emitHookEvent({ type: 'webhook:received', timestamp: Date.now(), data }).catch(() => {});
}

// ── Clear all ──

export function clearAllHooks(): void {
  handlers.clear();
  coworkLog('INFO', 'hookSystem', 'All hooks cleared');
}
