/**
 * Webhook Tools — tool definitions for webhook management.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import {
  registerWebhook,
  unregisterWebhook,
  listWebhooks,
  getWebhookServerPort,
} from './webhookServer';
import { randomBytes } from 'crypto';

export function buildWebhookTools(): ToolDefinition[] {
  return [
    buildTool({
      name: 'webhook_register',
      description: [
        'Register a new inbound webhook endpoint.',
        'When an external service POSTs to this URL, it triggers a new agent session or task.',
        '',
        'Example: Register a deploy notification webhook',
        '  path: "/hook/deploy"',
        '  prompt_template: "A deploy event occurred: {{body}}. Check the status and report."',
      ].join('\n'),
      inputSchema: z.object({
        path: z.string().min(1).describe('URL path, e.g., "/hook/deploy-notify"'),
        description: z.string().optional().describe('What this webhook does'),
        prompt_template: z.string().min(1).describe('Prompt template. Use {{body}} for the webhook body.'),
        action: z.enum(['start_session', 'run_task']).optional().describe('What to do (default: start_session)'),
        generate_secret: z.boolean().optional().describe('Generate HMAC secret for verification (default: true)'),
      }),
      call: async (input) => {
        const secret = input.generate_secret !== false
          ? randomBytes(32).toString('hex')
          : '';

        const reg = registerWebhook({
          path: input.path,
          secret,
          description: input.description || '',
          targetAction: input.action || 'start_session',
          targetPrompt: input.prompt_template,
          enabled: true,
        });

        const port = getWebhookServerPort();
        const url = port > 0 ? `http://localhost:${port}${reg.path}` : `(server not running) ${reg.path}`;

        return {
          content: [{
            type: 'text',
            text: [
              `Webhook registered:`,
              `  URL: ${url}`,
              `  Action: ${reg.targetAction}`,
              secret ? `  Secret: ${secret}` : '  Secret: (none)',
              secret ? `  Header: X-Webhook-Signature: sha256=HMAC(secret, body)` : '',
              `  ID: ${reg.id}`,
            ].filter(Boolean).join('\n'),
          }],
        };
      },
    }),

    buildTool({
      name: 'webhook_list',
      description: 'List all registered webhooks.',
      inputSchema: z.object({}),
      call: async () => {
        const webhooks = listWebhooks();
        if (webhooks.length === 0) {
          return { content: [{ type: 'text', text: 'No webhooks registered.' }] };
        }

        const port = getWebhookServerPort();
        const lines = webhooks.map(w =>
          `[${w.enabled ? 'ON' : 'OFF'}] ${w.path} → ${w.targetAction} (${w.description || 'no description'})`
        );

        return {
          content: [{
            type: 'text',
            text: `Webhooks (${webhooks.length}), server port: ${port || 'not running'}:\n${lines.join('\n')}`,
          }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'webhook_delete',
      description: 'Delete a registered webhook by its path.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Webhook path to delete'),
      }),
      call: async (input) => {
        const success = unregisterWebhook(input.path);
        return {
          content: [{
            type: 'text',
            text: success ? `Webhook ${input.path} deleted.` : `Webhook ${input.path} not found.`,
          }],
          isError: !success,
        };
      },
    }),
  ];
}
