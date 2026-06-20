/**
 * LSP Client — Language Server Protocol for semantic code navigation.
 * Provides: go-to-definition, find-references, hover, symbols.
 *
 * Reference: Claude Code src/tools/LSPTool/LSPTool.ts
 */

import { spawn, type ChildProcess } from 'child_process';
import { coworkLog } from './coworkLogger';
import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';

// ── Types ──

interface LSPPosition { line: number; character: number; }
interface LSPRange { start: LSPPosition; end: LSPPosition; }
interface LSPLocation { uri: string; range: LSPRange; }

interface LSPServer {
  process: ChildProcess;
  language: string;
  initialized: boolean;
  requestId: number;
  pendingRequests: Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>;
  buffer: string;
}

// ── State ──

const servers = new Map<string, LSPServer>();

// ── Known LSP servers ──

const LSP_COMMANDS: Record<string, { command: string; args: string[] }> = {
  typescript: { command: 'typescript-language-server', args: ['--stdio'] },
  python: { command: 'pylsp', args: [] },
  rust: { command: 'rust-analyzer', args: [] },
  go: { command: 'gopls', args: ['serve'] },
  java: { command: 'jdtls', args: [] },
};

// ── Server lifecycle ──

async function getOrStartServer(language: string, cwd: string): Promise<LSPServer | null> {
  if (servers.has(language)) return servers.get(language)!;

  const config = LSP_COMMANDS[language];
  if (!config) {
    coworkLog('WARN', 'lspClient', `No LSP server known for language: ${language}`);
    return null;
  }

  try {
    const proc = spawn(config.command, config.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const server: LSPServer = {
      process: proc,
      language,
      initialized: false,
      requestId: 0,
      pendingRequests: new Map(),
      buffer: '',
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      server.buffer += chunk.toString();
      processMessages(server);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      coworkLog('WARN', 'lspClient', `${language} LSP stderr: ${chunk.toString().slice(0, 200)}`);
    });

    proc.on('exit', () => {
      servers.delete(language);
    });

    servers.set(language, server);

    // Initialize
    await sendRequest(server, 'initialize', {
      processId: process.pid,
      rootUri: `file://${cwd.replace(/\\/g, '/')}`,
      capabilities: {},
    });
    await sendNotification(server, 'initialized', {});
    server.initialized = true;

    coworkLog('INFO', 'lspClient', `${language} LSP server started`);
    return server;
  } catch (e) {
    coworkLog('WARN', 'lspClient', `Failed to start ${language} LSP: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── JSON-RPC communication ──

function sendRequest(server: LSPServer, method: string, params: any): Promise<any> {
  const id = ++server.requestId;
  const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

  return new Promise((resolve, reject) => {
    server.pendingRequests.set(id, { resolve, reject });
    server.process.stdin?.write(header + message);
    setTimeout(() => {
      if (server.pendingRequests.has(id)) {
        server.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }
    }, 10000);
  });
}

function sendNotification(server: LSPServer, method: string, params: any): Promise<void> {
  const message = JSON.stringify({ jsonrpc: '2.0', method, params });
  const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
  server.process.stdin?.write(header + message);
  return Promise.resolve();
}

function processMessages(server: LSPServer): void {
  while (true) {
    const headerEnd = server.buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) break;
    const headerStr = server.buffer.slice(0, headerEnd);
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) { server.buffer = server.buffer.slice(headerEnd + 4); continue; }
    const contentLength = parseInt(match[1], 10);
    const contentStart = headerEnd + 4;
    if (server.buffer.length < contentStart + contentLength) break;
    const body = server.buffer.slice(contentStart, contentStart + contentLength);
    server.buffer = server.buffer.slice(contentStart + contentLength);
    try {
      const msg = JSON.parse(body);
      if (msg.id && server.pendingRequests.has(msg.id)) {
        const handler = server.pendingRequests.get(msg.id)!;
        server.pendingRequests.delete(msg.id);
        if (msg.error) handler.reject(new Error(msg.error.message));
        else handler.resolve(msg.result);
      }
    } catch {}
  }
}

// ── High-level operations ──

function fileUri(filePath: string): string {
  return `file://${filePath.replace(/\\/g, '/')}`;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'typescript', jsx: 'typescript',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
  };
  return map[ext] || 'typescript';
}

// ── Tool definitions ──

export function buildLSPTools(): ToolDefinition[] {
  return [
    buildTool({
      name: 'lsp_definition',
      description: 'Go to the definition of a symbol at a specific position in a file. Returns the file and line where the symbol is defined.',
      inputSchema: z.object({
        file_path: z.string().min(1),
        line: z.number().int().min(1),
        character: z.number().int().min(0),
      }),
      call: async (input, context) => {
        const lang = detectLanguage(input.file_path);
        const server = await getOrStartServer(lang, context.cwd);
        if (!server) return { content: [{ type: 'text', text: `LSP server not available for ${lang}. Install ${LSP_COMMANDS[lang]?.command || 'a language server'}.` }], isError: true };
        try {
          const result = await sendRequest(server, 'textDocument/definition', {
            textDocument: { uri: fileUri(input.file_path) },
            position: { line: input.line - 1, character: input.character },
          });
          if (!result) return { content: [{ type: 'text', text: 'No definition found.' }] };
          const locs = Array.isArray(result) ? result : [result];
          const formatted = locs.map((l: any) => `${(l.uri || l.targetUri || '').replace('file://', '')}:${(l.range?.start?.line ?? l.targetRange?.start?.line ?? 0) + 1}`);
          return { content: [{ type: 'text', text: `Definition(s):\n${formatted.join('\n')}` }] };
        } catch (e) { return { content: [{ type: 'text', text: `LSP error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }; }
      },
      isConcurrencySafe: true, isReadOnly: true,
    }),

    buildTool({
      name: 'lsp_references',
      description: 'Find all references to a symbol at a specific position.',
      inputSchema: z.object({
        file_path: z.string().min(1),
        line: z.number().int().min(1),
        character: z.number().int().min(0),
      }),
      call: async (input, context) => {
        const lang = detectLanguage(input.file_path);
        const server = await getOrStartServer(lang, context.cwd);
        if (!server) return { content: [{ type: 'text', text: `LSP not available for ${lang}.` }], isError: true };
        try {
          const result = await sendRequest(server, 'textDocument/references', {
            textDocument: { uri: fileUri(input.file_path) },
            position: { line: input.line - 1, character: input.character },
            context: { includeDeclaration: true },
          });
          if (!result || !result.length) return { content: [{ type: 'text', text: 'No references found.' }] };
          const formatted = result.slice(0, 30).map((l: LSPLocation) => `${l.uri.replace('file://', '')}:${l.range.start.line + 1}`);
          return { content: [{ type: 'text', text: `References (${result.length}):\n${formatted.join('\n')}` }] };
        } catch (e) { return { content: [{ type: 'text', text: `LSP error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }; }
      },
      isConcurrencySafe: true, isReadOnly: true,
    }),

    buildTool({
      name: 'lsp_hover',
      description: 'Get type information and documentation for a symbol at a position.',
      inputSchema: z.object({
        file_path: z.string().min(1),
        line: z.number().int().min(1),
        character: z.number().int().min(0),
      }),
      call: async (input, context) => {
        const lang = detectLanguage(input.file_path);
        const server = await getOrStartServer(lang, context.cwd);
        if (!server) return { content: [{ type: 'text', text: `LSP not available for ${lang}.` }], isError: true };
        try {
          const result = await sendRequest(server, 'textDocument/hover', {
            textDocument: { uri: fileUri(input.file_path) },
            position: { line: input.line - 1, character: input.character },
          });
          if (!result?.contents) return { content: [{ type: 'text', text: 'No hover info.' }] };
          const text = typeof result.contents === 'string' ? result.contents
            : result.contents.value || JSON.stringify(result.contents);
          return { content: [{ type: 'text', text: text.slice(0, 5000) }] };
        } catch (e) { return { content: [{ type: 'text', text: `LSP error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }; }
      },
      isConcurrencySafe: true, isReadOnly: true,
    }),

    buildTool({
      name: 'lsp_symbols',
      description: 'List all symbols (functions, classes, variables) in a file or search workspace symbols.',
      inputSchema: z.object({
        file_path: z.string().optional().describe('File to list symbols from'),
        query: z.string().optional().describe('Search query for workspace symbols'),
      }),
      call: async (input, context) => {
        const filePath = input.file_path || '';
        const lang = detectLanguage(filePath || 'file.ts');
        const server = await getOrStartServer(lang, context.cwd);
        if (!server) return { content: [{ type: 'text', text: `LSP not available for ${lang}.` }], isError: true };
        try {
          let result;
          if (input.query) {
            result = await sendRequest(server, 'workspace/symbol', { query: input.query });
          } else if (filePath) {
            result = await sendRequest(server, 'textDocument/documentSymbol', {
              textDocument: { uri: fileUri(filePath) },
            });
          } else {
            return { content: [{ type: 'text', text: 'Provide file_path or query.' }], isError: true };
          }
          if (!result || !result.length) return { content: [{ type: 'text', text: 'No symbols found.' }] };
          const formatted = result.slice(0, 50).map((s: any) => {
            const kind = ['', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable'][s.kind] || s.kind;
            const line = s.location?.range?.start?.line ?? s.range?.start?.line ?? s.selectionRange?.start?.line ?? '?';
            return `  ${kind} ${s.name} (line ${typeof line === 'number' ? line + 1 : line})`;
          });
          return { content: [{ type: 'text', text: `Symbols (${result.length}):\n${formatted.join('\n')}` }] };
        } catch (e) { return { content: [{ type: 'text', text: `LSP error: ${e instanceof Error ? e.message : String(e)}` }], isError: true }; }
      },
      isConcurrencySafe: true, isReadOnly: true,
    }),
  ];
}

// ── Cleanup ──

export function stopAllLSPServers(): void {
  for (const [lang, server] of servers) {
    try { server.process.kill(); } catch {}
    coworkLog('INFO', 'lspClient', `Stopped ${lang} LSP server`);
  }
  servers.clear();
}
