/**
 * Gmail Watcher — OAuth2 + IMAP polling for email-triggered agent sessions.
 *
 * Ported from OpenClaw src/hooks/gmail.ts + gmail-ops.ts + gmail-watcher.ts
 * Simplified: uses Google API REST instead of full Pub/Sub.
 *
 * Flow: OAuth2 login → periodic check for new emails → trigger hook event → start agent session
 */

import { coworkLog } from './coworkLogger';
import { emitHookEvent } from './hookSystem';

// ── Types ──

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: number | null;
  pollIntervalMs: number;     // default: 60000 (1 min)
  labelFilter: string;        // default: 'INBOX'
  enabled: boolean;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  date: number;
  labels: string[];
}

const DEFAULT_CONFIG: GmailConfig = {
  clientId: '',
  clientSecret: '',
  redirectUri: 'http://localhost:18790/oauth/gmail/callback',
  accessToken: null,
  refreshToken: null,
  tokenExpiry: null,
  pollIntervalMs: 60_000,
  labelFilter: 'INBOX',
  enabled: false,
};

// ── State ──

let config: GmailConfig = { ...DEFAULT_CONFIG };
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastHistoryId: string | null = null;
let isPolling = false;

// ── OAuth2 ──

export function getGmailAuthUrl(clientId: string, redirectUri: string): string {
  const scopes = encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send');
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scopes}&access_type=offline&prompt=consent`;
}

export async function exchangeGmailCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gmail OAuth failed: ${err}`);
  }

  const data = await response.json();
  config.accessToken = data.access_token;
  config.refreshToken = data.refresh_token || config.refreshToken;
  config.tokenExpiry = Date.now() + data.expires_in * 1000;

  coworkLog('INFO', 'gmailWatcher', 'Gmail OAuth tokens acquired');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

async function refreshAccessToken(): Promise<void> {
  if (!config.refreshToken || !config.clientId || !config.clientSecret) {
    throw new Error('Gmail refresh token not available');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  config.accessToken = data.access_token;
  config.tokenExpiry = Date.now() + data.expires_in * 1000;
}

async function ensureValidToken(): Promise<string> {
  if (!config.accessToken) throw new Error('No Gmail access token');
  if (config.tokenExpiry && Date.now() > config.tokenExpiry - 60_000) {
    await refreshAccessToken();
  }
  return config.accessToken!;
}

// ── Gmail API ──

async function gmailApiGet(path: string): Promise<any> {
  const token = await ensureValidToken();
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    if (response.status === 401) {
      await refreshAccessToken();
      const retryToken = await ensureValidToken();
      const retry = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
        headers: { Authorization: `Bearer ${retryToken}` },
      });
      if (!retry.ok) throw new Error(`Gmail API ${path}: ${retry.status}`);
      return retry.json();
    }
    throw new Error(`Gmail API ${path}: ${response.status}`);
  }
  return response.json();
}

async function gmailApiPost(path: string, body: any): Promise<any> {
  const token = await ensureValidToken();
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Gmail API POST ${path}: ${response.status}`);
  return response.json();
}

// ── Polling ──

async function pollForNewEmails(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  try {
    // List recent messages
    const query = `label:${config.labelFilter} is:unread`;
    const listResult = await gmailApiGet(`messages?q=${encodeURIComponent(query)}&maxResults=5`);
    const messageIds: string[] = (listResult.messages || []).map((m: any) => m.id);

    if (messageIds.length === 0) {
      isPolling = false;
      return;
    }

    // Check if we've already seen these
    if (lastHistoryId && messageIds[0] === lastHistoryId) {
      isPolling = false;
      return;
    }

    lastHistoryId = messageIds[0];

    // Fetch full message for the newest unread
    const msgData = await gmailApiGet(`messages/${messageIds[0]}?format=full`);
    const headers = msgData.payload?.headers || [];
    const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const gmailMsg: GmailMessage = {
      id: msgData.id,
      threadId: msgData.threadId,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      snippet: msgData.snippet || '',
      body: extractBody(msgData.payload),
      date: parseInt(msgData.internalDate || '0', 10),
      labels: msgData.labelIds || [],
    };

    coworkLog('INFO', 'gmailWatcher', `New email: "${gmailMsg.subject}" from ${gmailMsg.from}`);

    // Emit hook event
    await emitHookEvent({
      type: 'gmail:new_email',
      timestamp: Date.now(),
      data: {
        id: gmailMsg.id,
        from: gmailMsg.from,
        to: gmailMsg.to,
        subject: gmailMsg.subject,
        snippet: gmailMsg.snippet,
        body: gmailMsg.body.slice(0, 2000),
        date: gmailMsg.date,
      },
    });
  } catch (e) {
    coworkLog('ERROR', 'gmailWatcher', `Poll error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    isPolling = false;
  }
}

function extractBody(payload: any): string {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }

  // Multipart — find text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf8');
      }
    }
    // Fallback to text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64url').toString('utf8');
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    // Recurse into nested parts
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

// ── Gmail Send ──

export async function sendGmail(to: string, subject: string, body: string): Promise<string> {
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  const result = await gmailApiPost('messages/send', { raw });
  return result.id;
}

// ── Search ──

export async function searchGmail(query: string, maxResults: number = 10): Promise<GmailMessage[]> {
  const listResult = await gmailApiGet(`messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
  const messageIds: string[] = (listResult.messages || []).map((m: any) => m.id);

  const messages: GmailMessage[] = [];
  for (const id of messageIds.slice(0, maxResults)) {
    try {
      const msgData = await gmailApiGet(`messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`);
      const headers = msgData.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      messages.push({
        id: msgData.id,
        threadId: msgData.threadId,
        from: getHeader('From'),
        to: getHeader('To'),
        subject: getHeader('Subject'),
        snippet: msgData.snippet || '',
        body: '', // metadata only
        date: parseInt(msgData.internalDate || '0', 10),
        labels: msgData.labelIds || [],
      });
    } catch { /* skip failed messages */ }
  }

  return messages;
}

// ── Lifecycle ──

export function startGmailWatcher(customConfig?: Partial<GmailConfig>): void {
  if (customConfig) config = { ...config, ...customConfig };
  if (!config.enabled || !config.accessToken) {
    coworkLog('INFO', 'gmailWatcher', 'Gmail watcher not started (disabled or no token)');
    return;
  }

  if (pollTimer) return;
  pollTimer = setInterval(pollForNewEmails, config.pollIntervalMs);
  coworkLog('INFO', 'gmailWatcher', `Gmail watcher started (poll every ${config.pollIntervalMs / 1000}s)`);

  // Initial poll after 5s
  setTimeout(pollForNewEmails, 5000);
}

export function stopGmailWatcher(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  coworkLog('INFO', 'gmailWatcher', 'Gmail watcher stopped');
}

export function getGmailConfig(): GmailConfig {
  return { ...config, accessToken: config.accessToken ? '***' : null, refreshToken: config.refreshToken ? '***' : null };
}

export function setGmailConfig(updates: Partial<GmailConfig>): void {
  config = { ...config, ...updates };
}

export function isGmailConnected(): boolean {
  return !!config.accessToken;
}
