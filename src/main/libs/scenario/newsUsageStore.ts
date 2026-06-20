/**
 * News usage de-dup store (local, per-wallet).
 *
 * Wraps SqliteStore.{isNewsUsed,markNewsUsed} and exposes them to phaseRunner
 * for the orchestrator ctx surface. Why a tiny wrapper file instead of
 * importing SqliteStore directly into phaseRunner: SqliteStore is constructed
 * asynchronously at main-process startup; phaseRunner needs to call the
 * methods later from inside orchestrator runs. Mirror the existing
 * setStoreGetter pattern in libs/claudeSettings.ts so wiring stays
 * consistent.
 *
 * Hash convention: md5 of the source article TITLE (caller computes), so the
 * dedup key is content-based and survives upstream id churn (web3_news may
 * re-ingest the same headline under a different id after a refresh).
 */
import crypto from 'crypto';
import type { SqliteStore } from '../../sqliteStore';
import { coworkLog } from '../coworkLogger';
import { getNoobClawAuthToken } from '../claudeSettings';

// Decode the wallet address out of the current NoobClaw JWT. We don't
// verify the signature here — local main process only reads its own
// already-trusted token to scope dedup state. Returns '' on any error
// (caller treats empty wallet as "skip the dedup check" — fail open).
function getCurrentWallet(): string {
  try {
    const tok = getNoobClawAuthToken();
    if (!tok || typeof tok !== 'string') return '';
    const parts = tok.split('.');
    if (parts.length !== 3) return '';
    // base64url -> base64
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    const wallet = String(
      payload.walletAddress || payload.wallet_address || payload.sub || ''
    ).toLowerCase();
    // wallet addresses are stored case-insensitive across the system
    // (see memory: project_wallet_case_insensitive.md)
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

/** md5(title.trim().toLowerCase()) — case-insensitive, whitespace-trim. */
export function hashTitle(title: string): string {
  const norm = String(title || '').trim().toLowerCase();
  if (!norm) return '';
  return crypto.createHash('md5').update(norm).digest('hex');
}

/** Returns true if the CURRENT logged-in wallet has already used this title
 *  for this scenario. Returns false on any error (fail open — letting
 *  through a repeat is better than blocking writes when the store is briefly
 *  down). Wallet is auto-derived from the JWT — orchestrators don't need
 *  to know it. */
export function isNewsUsed(scenarioId: string, title: string): boolean {
  const wallet = getCurrentWallet();
  if (!wallet) return false; // no wallet = no scoping anchor, fail open
  const titleHash = hashTitle(title);
  if (!titleHash) return false;
  const store = getStore();
  if (!store) return false;
  try {
    return store.isNewsUsed(wallet, scenarioId, titleHash);
  } catch (err: any) {
    coworkLog('WARN', 'newsUsageStore',
      'isNewsUsed failed (failing open): ' + (err?.message || String(err)));
    return false;
  }
}

/** Idempotent. No-ops on any error (we'd rather skip the mark than crash
 *  the orchestrator post-publish — a stale-mark just means we may post the
 *  same article twice in the unlikely error case). */
export function markNewsUsed(scenarioId: string, title: string): void {
  const wallet = getCurrentWallet();
  if (!wallet) return;
  const titleHash = hashTitle(title);
  if (!titleHash) return;
  const store = getStore();
  if (!store) return;
  try {
    store.markNewsUsed(wallet, scenarioId, titleHash);
  } catch (err: any) {
    coworkLog('WARN', 'newsUsageStore',
      'markNewsUsed failed: ' + (err?.message || String(err)));
  }
}
