/**
 * Viral Pool Client — thin HTTP wrapper to backend /api/viral/*.
 *
 * Purpose: let scenario runs skip local AI extraction when another user
 * has already submitted a result for the same post.
 */

import crypto from 'crypto';
import { coworkLog } from '../coworkLogger';
import type { DiscoveredNote, ExtractionResult, Platform, ScenarioManifest } from './types';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';

function baseUrl(): string {
  return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL;
}

// Stable per-install device hash — generated once per Electron installation
// and kept in memory. Used as an opaque submitter id on the backend for
// rate-limiting only; no PII.
let cachedDeviceHash: string | null = null;
export function getDeviceHash(): string {
  if (cachedDeviceHash) return cachedDeviceHash;
  const seed = `${process.platform}:${process.arch}:${process.env.USERNAME || process.env.USER || 'unknown'}`;
  cachedDeviceHash = crypto.createHash('sha256').update(seed).digest('hex');
  return cachedDeviceHash;
}

export interface LookupResult {
  exists: boolean;
  post?: {
    id: string;
    external_url: string;
    raw_content: { body?: string; image_urls?: string[]; hashtags?: string[] };
    metrics: Record<string, unknown>;
    author_name?: string;
    author_followers?: number;
    title?: string;
  };
  extraction?: {
    result: ExtractionResult;
    ai_model?: string;
    extracted_at: string;
  } | null;
}

export async function lookup(
  platform: Platform,
  external_post_id: string,
  extractor_version: string
): Promise<LookupResult | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/viral/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, external_post_id, extractor_version }),
    });
    if (!res.ok) return null;
    return (await res.json()) as LookupResult;
  } catch (err) {
    coworkLog('WARN', 'viralPoolClient', 'lookup failed', { err: String(err) });
    return null;
  }
}

export interface SubmitParams {
  manifest: ScenarioManifest;
  note: DiscoveredNote;
  extraction: ExtractionResult;
  ai_model: string;
}

export async function submit(params: SubmitParams): Promise<{ ok: boolean; post_id?: string }> {
  const { manifest, note, extraction, ai_model } = params;
  try {
    const res = await fetch(`${baseUrl()}/api/viral/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: manifest.platform,
        scenario_id: manifest.id,
        external_url: note.external_url,
        external_post_id: note.external_post_id,
        author_name: note.author_name,
        author_followers: note.author_followers,
        title: note.title,
        raw_content: {
          body: note.body,
          image_urls: note.images,
          hashtags: note.hashtags,
        },
        metrics: note.metrics,
        extraction: {
          result: extraction,
          extractor_version: manifest.version,
          ai_model,
        },
        submitter_device_hash: getDeviceHash(),
      }),
    });
    if (!res.ok) {
      coworkLog('WARN', 'viralPoolClient', 'submit non-200', { status: res.status });
      return { ok: false };
    }
    return (await res.json()) as { ok: boolean; post_id?: string };
  } catch (err) {
    coworkLog('WARN', 'viralPoolClient', 'submit failed', { err: String(err) });
    return { ok: false };
  }
}

/** Always fetch the scenario pack from the server — no caching.
 *  Pack size is ~100KB and we want server-side hot-updates to take effect
 *  immediately. Last-resort fallback to a stale value if the network call
 *  fails (so an offline manual run still works). */
let lastGood = new Map<string, any>();

export async function fetchScenarioPack(id: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/viral/scenarios/${encodeURIComponent(id)}`);
    if (!res.ok) {
      coworkLog('WARN', 'viralPoolClient', 'fetchScenarioPack non-2xx', { id, status: res.status });
      return lastGood.get(id) || null;
    }
    const json = await res.json();
    lastGood.set(id, json);
    return json;
  } catch (err) {
    coworkLog('WARN', 'viralPoolClient', 'fetchScenarioPack failed', { id, err: String(err) });
    return lastGood.get(id) || null;
  }
}

/** No-op kept for backward compatibility — cache is gone. */
export function clearScenarioPackCache(): void {
  lastGood.clear();
}
