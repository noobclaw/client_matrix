/**
 * Webhook Server — lightweight HTTP endpoint for inbound webhooks.
 * Creates agent sessions when external services POST to registered paths.
 *
 * Ported from OpenClaw src/hooks/ webhook pattern.
 * Uses raw Node.js http.createServer (no Express, keeps bundle small).
 */

import http from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { coworkLog } from './coworkLogger';
import { emitWebhookReceived } from './hookSystem';

// ── Types ──

export interface WebhookRegistration {
  id: string;
  path: string;          // e.g., "/hook/deploy-notify"
  secret: string;        // HMAC-SHA256 verification secret
  description: string;
  targetAction: 'start_session' | 'run_task';
  targetPrompt: string;  // Prompt template, {{body}} replaced with webhook body
  enabled: boolean;
  createdAt: number;
}

export interface WebhookServerConfig {
  port: number;
  host: string;
}

// ── State ──

const registrations = new Map<string, WebhookRegistration>();
let server: http.Server | null = null;
let serverPort = 0;
let onWebhookTrigger: ((reg: WebhookRegistration, body: string) => void) | null = null;

// ── Server lifecycle ──

export function startWebhookServer(
  config: WebhookServerConfig,
  triggerCallback: (reg: WebhookRegistration, body: string) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(serverPort);
      return;
    }

    onWebhookTrigger = triggerCallback;

    server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Signature',
        });
        res.end();
        return;
      }

      // Health check
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', webhooks: registrations.size }));
        return;
      }

      // List registered webhooks
      if (req.url === '/webhooks' && req.method === 'GET') {
        const list = Array.from(registrations.values()).map(r => ({
          id: r.id,
          path: r.path,
          description: r.description,
          enabled: r.enabled,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }

      // Only accept POST for webhook paths
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      // Find matching registration
      const reg = findRegistration(req.url || '');
      if (!reg || !reg.enabled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Webhook not found' }));
        return;
      }

      // Read body
      const body = await readBody(req);

      // Verify HMAC signature if secret is set
      if (reg.secret) {
        const signature = req.headers['x-webhook-signature'] as string || '';
        const expected = `sha256=${createHmac('sha256', reg.secret).update(body).digest('hex')}`;
        const sigBuf = Buffer.from(signature);
        const expBuf = Buffer.from(expected);
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
          coworkLog('WARN', 'webhookServer', `Invalid signature for ${reg.path}`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid signature' }));
          return;
        }
      }

      coworkLog('INFO', 'webhookServer', `Webhook received: ${reg.path}`, { bodyLength: body.length });

      // Emit hook event
      emitWebhookReceived({
        path: reg.path,
        method: 'POST',
        body,
        headers: req.headers as Record<string, string>,
      });

      // Trigger action
      if (onWebhookTrigger) {
        try {
          onWebhookTrigger(reg, body);
        } catch (e) {
          coworkLog('ERROR', 'webhookServer', `Trigger error: ${e}`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', webhookId: reg.id }));
    });

    server.listen(config.port, config.host, () => {
      serverPort = config.port;
      coworkLog('INFO', 'webhookServer', `Webhook server listening on ${config.host}:${config.port}`);
      resolve(config.port);
    });

    server.on('error', (err) => {
      coworkLog('ERROR', 'webhookServer', `Server error: ${err.message}`);
      reject(err);
    });
  });
}

export function stopWebhookServer(): void {
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
    onWebhookTrigger = null;
    coworkLog('INFO', 'webhookServer', 'Webhook server stopped');
  }
}

export function getWebhookServerPort(): number {
  return serverPort;
}

// ── Registration CRUD ──

export function registerWebhook(params: Omit<WebhookRegistration, 'id' | 'createdAt'>): WebhookRegistration {
  const reg: WebhookRegistration = {
    id: uuidv4(),
    ...params,
    createdAt: Date.now(),
  };
  registrations.set(reg.path, reg);
  coworkLog('INFO', 'webhookServer', `Webhook registered: ${reg.path} → ${reg.targetAction}`);
  return reg;
}

export function unregisterWebhook(path: string): boolean {
  return registrations.delete(path);
}

export function getWebhook(path: string): WebhookRegistration | null {
  return registrations.get(path) ?? null;
}

export function listWebhooks(): WebhookRegistration[] {
  return Array.from(registrations.values());
}

// ── Helpers ──

function findRegistration(url: string): WebhookRegistration | null {
  // Exact match
  const exact = registrations.get(url);
  if (exact) return exact;
  // Try without query string
  const pathOnly = url.split('?')[0];
  return registrations.get(pathOnly) ?? null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxSize = 1024 * 1024; // 1MB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
