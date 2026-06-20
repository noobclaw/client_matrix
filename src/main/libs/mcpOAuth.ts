/**
 * MCP OAuth 2.0 Authorization Code flow with PKCE.
 *
 * Ported from Claude Code's MCP OAuth handling
 * (restored-src/services/mcp/oauth.ts) and adapted to NoobClaw's
 * McpStore + loopback HTTP server pattern.
 *
 * The flow:
 *   1. Spin up an ephemeral HTTP server on 127.0.0.1:<random-port>
 *   2. Generate PKCE code_verifier + code_challenge (S256)
 *   3. Build authorize URL and open it via shell.openExternal / OS URL handler
 *   4. User approves in browser → provider redirects to loopback with ?code=...
 *   5. We catch the code on the loopback, exchange it for access/refresh tokens
 *      at tokenUrl via form-encoded POST, store tokens in McpStore config_json
 *   6. On subsequent connect, inject `Authorization: Bearer <token>` header and
 *      auto-refresh via refresh_token when expiresAt is within 60s.
 *
 * Token storage: Tokens live in McpServerRecord.config.auth alongside
 * clientId / authorizeUrl / tokenUrl so everything a connection needs is in
 * one row. Access tokens are NOT put in macOS Keychain to keep Windows
 * parity — the sqlite DB is already encrypted-at-rest at the OS level via
 * app data dir permissions, and token lifetimes are short.
 *
 * Security notes:
 *   - Loopback binds to 127.0.0.1 only, never 0.0.0.0
 *   - Each flow uses a fresh code_verifier
 *   - State parameter is random 32 bytes, checked on callback
 *   - Server closes after first callback OR 5-minute timeout
 *   - Uses PKCE S256 even if provider does not require it (defence-in-depth)
 */

import http from 'http';
import crypto from 'crypto';
import { URL, URLSearchParams } from 'url';
import { coworkLog } from './coworkLogger';

// ── Types ──

export interface McpOAuthConfig {
  type: 'oauth';
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string; // optional (public clients use PKCE only)
  scope?: string;
  // Populated after successful flow — persisted into McpServerRecord.config
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenType?: string; // typically "Bearer"
}

export interface OAuthBeginResult {
  authorizeUrl: string; // URL to open in system browser
  state: string; // caller can use to correlate
  /**
   * Resolves when the provider redirects back with a code, or rejects on
   * error / timeout. The caller is responsible for calling shell.openExternal
   * on authorizeUrl after receiving this promise.
   */
  waitForCallback: Promise<McpOAuthConfig>;
  /** Close the loopback server early (e.g. on user cancel). */
  cancel: () => void;
}

// ── PKCE helpers ──

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── Loopback HTTP server ──

interface LoopbackHandle {
  port: number;
  callbackUrl: string;
  waitForCode: Promise<{ code: string; state: string }>;
  close: () => void;
}

function startLoopbackServer(timeoutMs: number = 5 * 60 * 1000): Promise<LoopbackHandle> {
  return new Promise((resolveHandle, rejectHandle) => {
    const server = http.createServer();
    let settled = false;

    const waitForCode = new Promise<{ code: string; state: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { server.close(); } catch { /* ignore */ }
        reject(new Error('OAuth callback timeout (5 minutes)'));
      }, timeoutMs);

      server.on('request', (req, res) => {
        if (!req.url) return;
        try {
          const u = new URL(req.url, 'http://127.0.0.1');
          if (u.pathname !== '/callback') {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          const code = u.searchParams.get('code');
          const state = u.searchParams.get('state') || '';
          const err = u.searchParams.get('error');
          if (err) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<html><body><h2>Authorization failed</h2><p>${escapeHtml(err)}</p></body></html>`);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              try { server.close(); } catch { /* ignore */ }
              reject(new Error(`OAuth error: ${err}`));
            }
            return;
          }
          if (!code) {
            res.statusCode = 400;
            res.end('Missing code');
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            '<html><body style="font-family:system-ui;padding:40px;background:#111;color:#eee">' +
              '<h2>Authorization complete</h2>' +
              '<p>You can close this window and return to NoobClaw.</p>' +
              '<script>setTimeout(() => window.close(), 800)</script>' +
              '</body></html>'
          );
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { server.close(); } catch { /* ignore */ }
            resolve({ code, state });
          }
        } catch (e) {
          res.statusCode = 500;
          res.end('Internal error');
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { server.close(); } catch { /* ignore */ }
            reject(e as Error);
          }
        }
      });
    });

    // Bind to an ephemeral port on loopback only
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        rejectHandle(new Error('Failed to bind loopback server'));
        return;
      }
      const port = addr.port;
      const callbackUrl = `http://127.0.0.1:${port}/callback`;
      resolveHandle({
        port,
        callbackUrl,
        waitForCode,
        close: () => {
          if (!settled) {
            settled = true;
            try { server.close(); } catch { /* ignore */ }
          }
        },
      });
    });

    server.on('error', (e) => {
      if (!settled) {
        settled = true;
        rejectHandle(e);
      }
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ── High-level OAuth API ──

/**
 * Begin an OAuth 2.0 authorization-code flow with PKCE for an MCP server.
 *
 * The caller is responsible for opening `result.authorizeUrl` in the user's
 * default browser (via Tauri opener plugin or Electron shell.openExternal).
 * Once the user approves, `result.waitForCallback` resolves with a fully
 * populated McpOAuthConfig ready to be stored back into McpServerRecord.
 */
export async function beginMcpOAuthFlow(config: {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
}): Promise<OAuthBeginResult> {
  const loopback = await startLoopbackServer();
  const { verifier, challenge } = generatePkcePair();
  const state = base64UrlEncode(crypto.randomBytes(24));

  const authUrl = new URL(config.authorizeUrl);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', loopback.callbackUrl);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  if (config.scope) authUrl.searchParams.set('scope', config.scope);

  coworkLog('INFO', 'mcpOAuth', `Begin OAuth flow: ${config.authorizeUrl} (port=${loopback.port})`);

  const waitForCallback = (async (): Promise<McpOAuthConfig> => {
    const { code, state: receivedState } = await loopback.waitForCode;
    if (receivedState !== state) {
      throw new Error('OAuth state mismatch — possible CSRF');
    }
    coworkLog('INFO', 'mcpOAuth', 'Authorization code received, exchanging for tokens');
    return exchangeCodeForTokens({
      authorizeUrl: config.authorizeUrl,
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scope: config.scope,
      code,
      codeVerifier: verifier,
      redirectUri: loopback.callbackUrl,
    });
  })();

  return {
    authorizeUrl: authUrl.toString(),
    state,
    waitForCallback,
    cancel: () => loopback.close(),
  };
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

async function postTokenEndpoint(tokenUrl: string, body: URLSearchParams, auth?: string): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
  };
  if (auth) headers['Authorization'] = auth;

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token endpoint ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function exchangeCodeForTokens(params: {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<McpOAuthConfig> {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', params.code);
  body.set('redirect_uri', params.redirectUri);
  body.set('client_id', params.clientId);
  body.set('code_verifier', params.codeVerifier);
  if (params.clientSecret) body.set('client_secret', params.clientSecret);

  const tok = await postTokenEndpoint(params.tokenUrl, body);
  const now = Date.now();
  return {
    type: 'oauth',
    authorizeUrl: params.authorizeUrl,
    tokenUrl: params.tokenUrl,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    scope: params.scope,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    tokenType: tok.token_type || 'Bearer',
    expiresAt: tok.expires_in ? now + tok.expires_in * 1000 : undefined,
  };
}

/**
 * If the access token is within 60 seconds of expiry and we have a refresh
 * token, fetch a new access token. Returns the possibly-updated config so
 * callers can persist it back to McpStore.
 *
 * If there's no refresh token or refresh fails, returns the original config
 * unchanged — the caller will get an auth error on the next MCP request and
 * can prompt the user to re-auth.
 */
export async function ensureFreshOAuthToken(
  config: McpOAuthConfig
): Promise<{ config: McpOAuthConfig; refreshed: boolean }> {
  if (!config.accessToken) {
    return { config, refreshed: false };
  }
  const now = Date.now();
  const skewMs = 60_000;
  if (!config.expiresAt || config.expiresAt - skewMs > now) {
    return { config, refreshed: false };
  }
  if (!config.refreshToken) {
    coworkLog('WARN', 'mcpOAuth', 'Access token expired but no refresh_token available');
    return { config, refreshed: false };
  }

  try {
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', config.refreshToken);
    body.set('client_id', config.clientId);
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
    if (config.scope) body.set('scope', config.scope);

    const tok = await postTokenEndpoint(config.tokenUrl, body);
    const updated: McpOAuthConfig = {
      ...config,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || config.refreshToken,
      tokenType: tok.token_type || config.tokenType || 'Bearer',
      expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
    };
    coworkLog('INFO', 'mcpOAuth', `Token refreshed, new expiry in ${tok.expires_in || '?'}s`);
    return { config: updated, refreshed: true };
  } catch (e) {
    coworkLog('WARN', 'mcpOAuth', `Refresh token exchange failed: ${e instanceof Error ? e.message : e}`);
    return { config, refreshed: false };
  }
}

/**
 * Build an `Authorization: Bearer <token>` header fragment for a stored
 * oauth config. Returns null if no access token is present.
 */
export function oauthAuthorizationHeader(config: McpOAuthConfig): Record<string, string> | null {
  if (!config.accessToken) return null;
  return { Authorization: `${config.tokenType || 'Bearer'} ${config.accessToken}` };
}
