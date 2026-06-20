/**
 * Navigation Guard — SSRF protection for browser automation.
 * Prevents AI from navigating to internal/dangerous addresses.
 *
 * Reference: OpenClaw src/browser/navigation-guard.ts
 */

import { coworkLog } from './coworkLogger';

// Private/internal IP ranges (RFC 1918 + loopback + link-local)
const BLOCKED_PATTERNS = [
  /^127\./,                    // Loopback
  /^10\./,                     // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./, // Class B private
  /^192\.168\./,               // Class C private
  /^169\.254\./,               // Link-local
  /^0\./,                      // Current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // Shared address space (CGN)
  /^::1$/,                     // IPv6 loopback
  /^fc00:/i,                   // IPv6 unique local
  /^fe80:/i,                   // IPv6 link-local
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',      // GCP metadata
  'metadata.google',
  '169.254.169.254',               // AWS/GCP metadata endpoint
  'fd00::',
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:']);

export interface NavigationCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a URL is safe to navigate to.
 * Blocks internal/private addresses and dangerous protocols.
 */
export function checkNavigationAllowed(url: string): NavigationCheckResult {
  if (!url) return { allowed: false, reason: 'Empty URL' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}` };
  }

  // Allow about:blank
  if (parsed.protocol === 'about:') {
    return { allowed: true };
  }

  // Block dangerous protocols
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { allowed: false, reason: `Blocked protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block known dangerous hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: `Blocked hostname: ${hostname}` };
  }

  // Block private/internal IP ranges
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(hostname)) {
      return { allowed: false, reason: `Blocked internal address: ${hostname}` };
    }
  }

  return { allowed: true };
}

/**
 * Assert navigation is allowed, throwing if blocked.
 */
export function assertNavigationAllowed(url: string): void {
  const check = checkNavigationAllowed(url);
  if (!check.allowed) {
    coworkLog('WARN', 'navigationGuard', `Blocked navigation to ${url}: ${check.reason}`);
    throw new Error(`Navigation blocked: ${check.reason}`);
  }
}
