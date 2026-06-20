/**
 * Engagement history de-dup store (local, per-wallet).
 *
 * Wraps SqliteStore.{isEngaged,markEngaged} and exposes them to phaseRunner
 * for the orchestrator ctx surface. Used by:
 *   • auto_engage scenarios (bilibili/douyin/kuaishou) — skip videos this
 *     wallet already commented on in past runs (default 30-day window
 *     reasoning lives in the caller — store itself keeps everything).
 *   • reply_fans_comment scenarios (bili/dy/ks/shipinhao/toutiao) — skip
 *     fan-comment targets already replied to. Especially critical on B站:
 *     the creator-center comment list ALSO renders the UP主's OWN past
 *     replies as fresh rows, so the in-memory `seen` (resets per run) used
 *     to let the AI reply-to-self on the next run. Persistent dedup +
 *     improved DOM isAuthor filter fixes this.
 *
 * Mirrors the newsUsageStore wiring pattern (setStoreGetter at startup,
 * getCurrentWallet() from JWT) so we stay consistent.
 */
import type { SqliteStore } from '../../sqliteStore';
import { coworkLog } from '../coworkLogger';
import { getNoobClawAuthToken } from '../claudeSettings';

// Decode the wallet address out of the current NoobClaw JWT. Same logic
// as newsUsageStore — keep them duplicated rather than abstracting since
// the two stores have independent lifecycles and we don't want one's
// helper to drag in the other's imports.
function getCurrentWallet(): string {
  try {
    const tok = getNoobClawAuthToken();
    if (!tok || typeof tok !== 'string') return '';
    const parts = tok.split('.');
    if (parts.length !== 3) return '';
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    const wallet = String(
      payload.walletAddress || payload.wallet_address || payload.sub || ''
    ).toLowerCase();
    return wallet;
  } catch {
    return '';
  }
}

let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

function getStore(): SqliteStore | null {
  if (!storeGetter) return null;
  try { return storeGetter(); }
  catch { return null; }
}

/** Returns true if THIS wallet has already performed THIS action on THIS
 *  target on THIS platform. Fails open (returns false) on any error — a
 *  duplicate engagement is annoying but better than blocking the whole
 *  run when the store hiccups. */
export function isEngaged(platform: string, action: string, targetId: string): boolean {
  const wallet = getCurrentWallet();
  if (!wallet) return false;
  if (!platform || !action || !targetId) return false;
  const store = getStore();
  if (!store) return false;
  try {
    return store.isEngaged(wallet, platform, action, targetId);
  } catch (err: any) {
    coworkLog('WARN', 'engageHistoryStore',
      'isEngaged failed (failing open): ' + (err?.message || String(err)));
    return false;
  }
}

/** Idempotent. No-ops on any error — a missing mark just means we may
 *  re-engage the same target later, which is the failure mode this whole
 *  module exists to reduce but is acceptable in the rare error path. */
export function markEngaged(platform: string, action: string, targetId: string): void {
  const wallet = getCurrentWallet();
  if (!wallet) return;
  if (!platform || !action || !targetId) return;
  const store = getStore();
  if (!store) return;
  try {
    store.markEngaged(wallet, platform, action, targetId);
  } catch (err: any) {
    coworkLog('WARN', 'engageHistoryStore',
      'markEngaged failed: ' + (err?.message || String(err)));
  }
}
