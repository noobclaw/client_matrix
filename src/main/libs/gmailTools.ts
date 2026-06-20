/**
 * Gmail Tools — tool definitions for Gmail integration.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import { searchGmail, sendGmail, isGmailConnected, getGmailConfig } from './gmailWatcher';

export function buildGmailTools(): ToolDefinition[] {
  return [
    buildTool({
      name: 'gmail_search',
      description: 'Search Gmail messages. Requires Gmail OAuth connection. Uses Gmail search syntax.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Gmail search query (e.g., "from:user@example.com subject:deploy")'),
        max_results: z.number().min(1).max(20).optional().describe('Max results (default: 10)'),
      }),
      call: async (input) => {
        if (!isGmailConnected()) {
          return { content: [{ type: 'text', text: 'Gmail not connected. Configure OAuth in settings.' }], isError: true };
        }
        try {
          const messages = await searchGmail(input.query, input.max_results ?? 10);
          if (messages.length === 0) {
            return { content: [{ type: 'text', text: 'No messages found.' }] };
          }
          const lines = messages.map(m =>
            `[${new Date(m.date).toISOString().slice(0, 16)}] From: ${m.from}\n  Subject: ${m.subject}\n  ${m.snippet.slice(0, 100)}`
          );
          return { content: [{ type: 'text', text: `Found ${messages.length} messages:\n\n${lines.join('\n\n')}` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Gmail search error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'gmail_send',
      description: 'Send an email via Gmail. Requires Gmail OAuth connection.',
      inputSchema: z.object({
        to: z.string().min(1).describe('Recipient email address'),
        subject: z.string().min(1).describe('Email subject'),
        body: z.string().min(1).describe('Email body (plain text)'),
      }),
      call: async (input) => {
        if (!isGmailConnected()) {
          return { content: [{ type: 'text', text: 'Gmail not connected. Configure OAuth in settings.' }], isError: true };
        }
        try {
          const msgId = await sendGmail(input.to, input.subject, input.body);
          return { content: [{ type: 'text', text: `Email sent to ${input.to} (ID: ${msgId})` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Gmail send error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    buildTool({
      name: 'gmail_status',
      description: 'Check Gmail connection status and watcher configuration.',
      inputSchema: z.object({}),
      call: async () => {
        const connected = isGmailConnected();
        const cfg = getGmailConfig();
        return {
          content: [{
            type: 'text',
            text: [
              `Gmail: ${connected ? 'CONNECTED' : 'NOT CONNECTED'}`,
              `Watcher: ${cfg.enabled ? 'ENABLED' : 'DISABLED'}`,
              `Poll interval: ${cfg.pollIntervalMs / 1000}s`,
              `Label filter: ${cfg.labelFilter}`,
            ].join('\n'),
          }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
  ];
}
