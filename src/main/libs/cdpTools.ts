/**
 * CDP Browser Tools — tool definitions for Chrome DevTools Protocol mode.
 * Alternative to extension-based browser tools. Both modes coexist.
 *
 * Ported from OpenClaw extensions/browser/ CDP pattern.
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import {
  launchCDPBrowser,
  cdpNavigate,
  cdpScreenshot,
  cdpClick,
  cdpType,
  cdpEvaluate,
  cdpGetPageInfo,
  cdpGetDOM,
  closeCDPBrowser,
  isCDPBrowserRunning,
} from './cdpBrowser';

export function buildCDPTools(): ToolDefinition[] {
  return [
    buildTool({
      name: 'cdp_launch',
      description: 'Launch a managed Chrome browser instance for CDP automation. Call this before other cdp_* tools.',
      inputSchema: z.object({
        headless: z.boolean().optional().describe('Run in headless mode (default: false)'),
        chrome_path: z.string().optional().describe('Custom Chrome/Chromium path'),
      }),
      call: async (input) => {
        try {
          const session = await launchCDPBrowser({
            headless: input.headless,
            chromePath: input.chrome_path,
          });
          return { content: [{ type: 'text', text: `Chrome launched (port ${session.debugPort}). Ready for cdp_* commands.` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Failed to launch Chrome: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    buildTool({
      name: 'cdp_navigate',
      description: 'Navigate the CDP browser to a URL.',
      inputSchema: z.object({ url: z.string().min(1) }),
      call: async (input) => {
        try {
          // SSRF guard: block internal/dangerous addresses
          const { assertNavigationAllowed } = require('./navigationGuard');
          assertNavigationAllowed(input.url);
          if (!isCDPBrowserRunning()) await launchCDPBrowser();
          const result = await cdpNavigate(input.url);
          return { content: [{ type: 'text', text: result }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `cdp_navigate error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    buildTool({
      name: 'cdp_screenshot',
      description: 'Take a screenshot of the current CDP browser page.',
      inputSchema: z.object({}),
      call: async () => {
        try {
          if (!isCDPBrowserRunning()) return { content: [{ type: 'text', text: 'No CDP browser running. Call cdp_launch first.' }], isError: true };
          const { data } = await cdpScreenshot();
          // Save screenshot to temp file
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const tmpPath = path.join(os.tmpdir(), `noobclaw-cdp-screenshot-${Date.now()}.jpg`);
          fs.writeFileSync(tmpPath, Buffer.from(data, 'base64'));
          return { content: [{ type: 'text', text: `Screenshot saved to ${tmpPath}` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `cdp_screenshot error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'cdp_click',
      description: 'Click at coordinates in the CDP browser.',
      inputSchema: z.object({ x: z.number(), y: z.number() }),
      call: async (input) => {
        try {
          const result = await cdpClick(input.x, input.y);
          return { content: [{ type: 'text', text: result }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `cdp_click error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    buildTool({
      name: 'cdp_type',
      description: 'Type text in the CDP browser (into the currently focused element).',
      inputSchema: z.object({ text: z.string().min(1) }),
      call: async (input) => {
        try {
          const result = await cdpType(input.text);
          return { content: [{ type: 'text', text: result }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `cdp_type error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    buildTool({
      name: 'cdp_evaluate',
      description: 'Execute JavaScript in the CDP browser page context. Returns the result.',
      inputSchema: z.object({ expression: z.string().min(1) }),
      call: async (input) => {
        try {
          const result = await cdpEvaluate(input.expression);
          return { content: [{ type: 'text', text: result }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `cdp_evaluate error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    buildTool({
      name: 'cdp_get_page',
      description: 'Get the current CDP browser page URL and title.',
      inputSchema: z.object({}),
      call: async () => {
        try {
          const info = await cdpGetPageInfo();
          return { content: [{ type: 'text', text: `URL: ${info.url}\nTitle: ${info.title}` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `cdp_get_page error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'cdp_read_dom',
      description: 'Read the DOM content. Optionally specify a CSS selector to get a specific element.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector (returns body text if omitted)'),
      }),
      call: async (input) => {
        try {
          const html = await cdpGetDOM(input.selector);
          return { content: [{ type: 'text', text: html.slice(0, 50000) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `cdp_read_dom error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'cdp_close',
      description: 'Close the CDP browser instance.',
      inputSchema: z.object({}),
      call: async () => {
        closeCDPBrowser();
        return { content: [{ type: 'text', text: 'CDP browser closed.' }] };
      },
    }),

    // ── New tools: console, network, snapshot ──

    buildTool({
      name: 'cdp_console',
      description: 'Read browser console messages (log, warn, error). Useful for debugging JS errors.',
      inputSchema: z.object({ limit: z.number().optional() }),
      call: async (input) => {
        const { getConsoleMessages } = require('./cdpBrowser');
        const msgs = getConsoleMessages(input.limit || 50);
        if (msgs.length === 0) return { content: [{ type: 'text', text: 'No console messages.' }] };
        const lines = msgs.map((m: any) => `[${m.level}] ${m.text}`).join('\n');
        return { content: [{ type: 'text', text: lines }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'cdp_network',
      description: 'View recent network requests made by the page. Shows URL, method, status.',
      inputSchema: z.object({ limit: z.number().optional(), filter: z.string().optional().describe('Filter by URL pattern') }),
      call: async (input) => {
        const { getNetworkRequests } = require('./cdpBrowser');
        let reqs = getNetworkRequests(input.limit || 50);
        if (input.filter) {
          const pattern = input.filter.toLowerCase();
          reqs = reqs.filter((r: any) => r.url.toLowerCase().includes(pattern));
        }
        if (reqs.length === 0) return { content: [{ type: 'text', text: 'No matching network requests.' }] };
        const lines = reqs.map((r: any) => `${r.method} ${r.status} ${r.url}`).join('\n');
        return { content: [{ type: 'text', text: lines }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'cdp_snapshot',
      description: 'Get the accessibility tree (aria snapshot) of the current page. Shows the page structure as AI-readable text with roles and labels. Much better than reading raw HTML for understanding page layout.',
      inputSchema: z.object({ max_depth: z.number().optional() }),
      call: async (input) => {
        const { getActivePage, getAriaSnapshot, enablePageTracking } = require('./cdpBrowser');
        const page = await getActivePage();
        await enablePageTracking(page);
        const snapshot = await getAriaSnapshot(page, input.max_depth || 10);
        return { content: [{ type: 'text', text: snapshot }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
  ];
}
