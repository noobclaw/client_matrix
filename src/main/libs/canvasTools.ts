/**
 * Canvas Tools — A2UI (Agent-driven UI) tool definitions.
 * Allows the agent to render interactive HTML, capture user interactions,
 * and build visual interfaces dynamically.
 *
 * Ported from OpenClaw src/canvas-host/a2ui.ts pattern.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import {
  createCanvasWindow,
  updateCanvas,
  waitForCanvasAction,
  closeCanvas,
  getCanvasSession,
  getCanvasSessionsByParent,
} from './canvasHost';

export function buildCanvasTools(): ToolDefinition[] {
  return [
    buildTool({
      name: 'canvas_render',
      description: [
        'Render interactive HTML in a canvas window. The user sees and interacts with it.',
        'Use this to create visual interfaces, forms, dashboards, or interactive demos.',
        '',
        'The HTML can include CSS, JavaScript, and interactive elements.',
        'User interactions (clicks, form submissions) are captured automatically.',
        'Use canvas_read_action to receive user interactions.',
        '',
        'Example uses:',
        '- Interactive forms for data input',
        '- Visual dashboards with charts',
        '- Approval/rejection workflows',
        '- HTML previews before saving to file',
      ].join('\n'),
      inputSchema: z.object({
        html: z.string().min(1).describe('Complete HTML content to render'),
        title: z.string().optional().describe('Window title'),
        width: z.number().min(200).max(3840).optional().describe('Window width in pixels (default: 800)'),
        height: z.number().min(200).max(2160).optional().describe('Window height in pixels (default: 600)'),
      }),
      call: async (input, context) => {
        const session = createCanvasWindow(context.sessionId, input.html, {
          title: input.title,
          width: input.width,
          height: input.height,
        });

        return {
          content: [{
            type: 'text',
            text: `Canvas opened (ID: ${session.id}). The user can now see and interact with it.\nUse canvas_read_action to capture user interactions.`,
          }],
        };
      },
    }),

    buildTool({
      name: 'canvas_update',
      description: [
        'Update an existing canvas window. Can replace specific elements, inject JavaScript, or reload entirely.',
        '',
        'Three update modes:',
        '1. selector + html: Update a specific DOM element by CSS selector',
        '2. js: Execute JavaScript in the canvas context',
        '3. html (without selector): Replace the entire page content',
      ].join('\n'),
      inputSchema: z.object({
        canvas_id: z.string().min(1).describe('Canvas session ID'),
        html: z.string().optional().describe('HTML content (full page or element inner HTML)'),
        selector: z.string().optional().describe('CSS selector for targeted update'),
        js: z.string().optional().describe('JavaScript to execute in canvas context'),
      }),
      call: async (input) => {
        const success = updateCanvas(input.canvas_id, {
          html: input.html,
          selector: input.selector,
          js: input.js,
        });

        return {
          content: [{
            type: 'text',
            text: success ? 'Canvas updated.' : 'Canvas not found or closed.',
          }],
          isError: !success,
        };
      },
    }),

    buildTool({
      name: 'canvas_read_action',
      description: [
        'Wait for and read the next user interaction in a canvas window.',
        'Blocks until the user clicks, submits a form, or the timeout expires.',
        '',
        'Returns: { type, target, value, data }',
        '- type: "click", "submit", "input", "custom", or "closed"',
        '- target: CSS selector or element identifier',
        '- value: button text, form data, or custom data',
      ].join('\n'),
      inputSchema: z.object({
        canvas_id: z.string().min(1).describe('Canvas session ID'),
        timeout_seconds: z.number().min(1).max(300).optional().describe('Wait timeout in seconds (default: 60)'),
      }),
      call: async (input) => {
        const action = await waitForCanvasAction(
          input.canvas_id,
          (input.timeout_seconds ?? 60) * 1000
        );

        if (!action) {
          return {
            content: [{ type: 'text', text: 'No user action within timeout.' }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              type: action.type,
              target: action.target,
              value: action.value,
              data: action.data,
            }, null, 2),
          }],
        };
      },
    }),

    buildTool({
      name: 'canvas_close',
      description: 'Close a canvas window.',
      inputSchema: z.object({
        canvas_id: z.string().min(1).describe('Canvas session ID'),
      }),
      call: async (input) => {
        const success = closeCanvas(input.canvas_id);
        return {
          content: [{
            type: 'text',
            text: success ? 'Canvas closed.' : 'Canvas not found.',
          }],
          isError: !success,
        };
      },
    }),

    buildTool({
      name: 'canvas_list',
      description: 'List all open canvas windows for the current session.',
      inputSchema: z.object({}),
      call: async (_, context) => {
        const sessions = getCanvasSessionsByParent(context.sessionId);
        if (sessions.length === 0) {
          return { content: [{ type: 'text', text: 'No open canvases.' }] };
        }

        const lines = sessions.map(s =>
          `${s.id} — opened ${new Date(s.createdAt).toLocaleTimeString()}, ${s.pendingActions.length} pending actions`
        );

        return {
          content: [{ type: 'text', text: `Open canvases (${sessions.length}):\n${lines.join('\n')}` }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
    // ── New tools: snapshot, push_data, get_html ──

    buildTool({
      name: 'canvas_snapshot',
      description: 'Take a screenshot/snapshot of a canvas window. Returns PNG image (Electron) or HTML text (Tauri). Use this to verify what the canvas looks like.',
      inputSchema: z.object({ canvas_id: z.string() }),
      call: async (input) => {
        const { captureCanvasSnapshot } = require('./canvasHost');
        const snapshot = await captureCanvasSnapshot(input.canvas_id);
        if (!snapshot) {
          return { content: [{ type: 'text', text: 'Canvas not found or snapshot failed.' }], isError: true };
        }
        if (snapshot.type === 'image') {
          return { content: [{ type: 'image', data: snapshot.data, mimeType: 'image/png' }] } as any;
        }
        // HTML text snapshot
        return { content: [{ type: 'text', text: `Canvas HTML snapshot (${snapshot.data.length} chars):\n${snapshot.data.slice(0, 5000)}` }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'canvas_push_data',
      description: 'Push structured data (JSONL format) to a canvas without replacing the entire HTML. The canvas receives a "noobclaw:data" event with the parsed data array. Use for updating tables, charts, lists dynamically.',
      inputSchema: z.object({ canvas_id: z.string(), data: z.string().describe('JSONL data — one JSON object per line') }),
      call: async (input) => {
        const { pushCanvasData } = require('./canvasHost');
        const success = pushCanvasData(input.canvas_id, input.data);
        return {
          content: [{ type: 'text', text: success ? 'Data pushed to canvas.' : 'Canvas not found or push failed.' }],
          isError: !success,
        };
      },
    }),

    buildTool({
      name: 'canvas_get_html',
      description: 'Get the current HTML source of a canvas window.',
      inputSchema: z.object({ canvas_id: z.string() }),
      call: async (input) => {
        const { getCanvasHTML } = require('./canvasHost');
        const html = getCanvasHTML(input.canvas_id);
        if (!html) return { content: [{ type: 'text', text: 'Canvas not found.' }], isError: true };
        return { content: [{ type: 'text', text: html.length > 10000 ? html.slice(0, 10000) + '\n[Truncated]' : html }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
  ];
}
