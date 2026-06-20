/**
 * MCP Client — connects to external MCP servers via stdio/sse/http
 * and materializes their tools as ToolDefinition objects.
 *
 * Ported from OpenClaw (Claude Code) src/services/mcp/client.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
// SSE transport may not be available in all SDK versions; use dynamic import
import { z } from 'zod';
import { spawn } from 'child_process';
import { coworkLog } from './coworkLogger';
import { buildTool, type ToolDefinition, type ToolResult } from './toolSystem';
import {
  ensureFreshOAuthToken,
  oauthAuthorizationHeader,
  type McpOAuthConfig,
} from './mcpOAuth';

// ── Types ──

export interface McpServerConfig {
  name: string;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /**
   * Optional OAuth 2.0 config. When present and complete (accessToken set),
   * we inject `Authorization: Bearer <token>` into the transport headers and
   * refresh via refresh_token when the token is within 60s of expiry.
   */
  oauth?: McpOAuthConfig;
  /**
   * Optional callback fired when a token refresh produced a new access
   * token. The caller (main.ts) persists the updated oauth config back to
   * McpStore via setOAuth(). Optional so the mcpClient module stays
   * framework-agnostic.
   */
  onOAuthRefreshed?: (updated: McpOAuthConfig) => void;
}

interface McpConnection {
  name: string;
  client: Client;
  transport: any;
  tools: ToolDefinition[];
}

// ── Active connections ──

const activeConnections = new Map<string, McpConnection>();

// ── Connect to an MCP server and materialize tools ──

/**
 * Connect to a single MCP server and return its tools as ToolDefinition[].
 * The connection stays alive until disconnectMcpServer() is called.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  timeoutMs: number = 30_000
): Promise<ToolDefinition[]> {
  // Reuse existing connection if already connected
  const existing = activeConnections.get(config.name);
  if (existing) {
    coworkLog('INFO', 'mcpClient', `Reusing existing connection to "${config.name}"`);
    return existing.tools;
  }

  coworkLog('INFO', 'mcpClient', `Connecting to MCP server "${config.name}" (${config.transportType})`);

  const client = new Client({
    name: `noobclaw-${config.name}`,
    version: '1.0.0',
  });

  let transport: any;

  try {
    switch (config.transportType) {
      case 'stdio': {
        if (!config.command) {
          throw new Error(`MCP server "${config.name}": stdio transport requires a command`);
        }
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
        });
        break;
      }

      case 'sse':
      case 'http': {
        if (!config.url) {
          throw new Error(`MCP server "${config.name}": ${config.transportType} transport requires a url`);
        }

        // Build request headers, merging static user headers with OAuth
        // Authorization header if an oauth config is present. Refresh the
        // access token first if it's within 60s of expiry.
        let mergedHeaders: Record<string, string> | undefined = config.headers
          ? { ...config.headers }
          : undefined;
        if (config.oauth) {
          const { config: refreshedOauth, refreshed } = await ensureFreshOAuthToken(config.oauth);
          if (refreshed && config.onOAuthRefreshed) {
            try { config.onOAuthRefreshed(refreshedOauth); } catch { /* ignore */ }
          }
          const authHeader = oauthAuthorizationHeader(refreshedOauth);
          if (authHeader) {
            mergedHeaders = { ...(mergedHeaders || {}), ...authHeader };
            coworkLog('INFO', 'mcpClient', `"${config.name}": injecting OAuth Bearer token`);
          } else {
            coworkLog('WARN', 'mcpClient', `"${config.name}": oauth config has no access token, connecting unauthenticated`);
          }
        }

        // Use SSE transport for both sse and http
        // Dynamic import since SSE transport may vary by SDK version
        try {
          const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
          transport = new SSEClientTransport(new URL(config.url), {
            requestInit: mergedHeaders ? { headers: mergedHeaders } : undefined,
          } as any);
        } catch {
          // Fallback: try StreamableHTTP transport
          try {
            const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
            transport = new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: mergedHeaders ? { headers: mergedHeaders } : undefined,
            } as any);
          } catch {
            throw new Error(`MCP server "${config.name}": no SSE or HTTP transport available in MCP SDK`);
          }
        }
        break;
      }

      default:
        throw new Error(`MCP server "${config.name}": unknown transport type "${config.transportType}"`);
    }

    // Connect with timeout
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Connection to "${config.name}" timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);

    coworkLog('INFO', 'mcpClient', `Connected to "${config.name}", listing tools`);

    // List tools from the server
    const toolsResult = await client.listTools();
    const mcpTools = toolsResult.tools || [];

    coworkLog('INFO', 'mcpClient', `"${config.name}" exposes ${mcpTools.length} tools`);

    // Materialize each MCP tool as a ToolDefinition
    const toolDefs: ToolDefinition[] = mcpTools.map(mcpTool => {
      const toolName = `mcp__${config.name}__${mcpTool.name}`;

      // Convert JSON Schema to a permissive Zod schema
      // The actual validation is done server-side by the MCP server
      const inputSchema = z.record(z.string(), z.unknown());

      return buildTool({
        name: toolName,
        description: mcpTool.description
          ? `[MCP: ${config.name}] ${mcpTool.description}`
          : `[MCP: ${config.name}] ${mcpTool.name}`,
        inputSchema,
        call: async (input: Record<string, unknown>): Promise<ToolResult> => {
          try {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: input,
            });

            // Convert MCP tool result to our ToolResult format
            const content = Array.isArray(result.content)
              ? result.content.map((c: any) => {
                  if (c.type === 'text') return { type: 'text' as const, text: c.text || '' };
                  if (c.type === 'image') return { type: 'text' as const, text: `[Image: ${c.mimeType || 'image'}]` };
                  return { type: 'text' as const, text: JSON.stringify(c) };
                })
              : [{ type: 'text' as const, text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }];

            return {
              content,
              isError: result.isError === true,
            };
          } catch (e) {
            return {
              content: [{ type: 'text', text: `MCP tool error (${config.name}/${mcpTool.name}): ${e instanceof Error ? e.message : String(e)}` }],
              isError: true,
            };
          }
        },
        isConcurrencySafe: true, // MCP tools are generally safe to run concurrently
        isReadOnly: false, // We can't know — be conservative
      });
    });

    // Store the connection
    activeConnections.set(config.name, {
      name: config.name,
      client,
      transport,
      tools: toolDefs,
    });

    return toolDefs;

  } catch (e) {
    coworkLog('ERROR', 'mcpClient', `Failed to connect to "${config.name}": ${e instanceof Error ? e.message : String(e)}`);
    // Clean up on failure
    try { await client.close(); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Connect to multiple MCP servers in parallel.
 * Returns all tools from all servers, skipping servers that fail to connect.
 */
export async function connectAllMcpServers(
  configs: McpServerConfig[],
  timeoutMs: number = 30_000
): Promise<ToolDefinition[]> {
  if (configs.length === 0) return [];

  const results = await Promise.allSettled(
    configs.map(c => connectMcpServer(c, timeoutMs))
  );

  const allTools: ToolDefinition[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allTools.push(...result.value);
    } else {
      coworkLog('WARN', 'mcpClient', `MCP server "${configs[i].name}" failed: ${result.reason?.message || result.reason}`);
    }
  }

  coworkLog('INFO', 'mcpClient', `Connected ${results.filter(r => r.status === 'fulfilled').length}/${configs.length} MCP servers, ${allTools.length} total tools`);
  return allTools;
}

/**
 * Disconnect a single MCP server.
 */
export async function disconnectMcpServer(name: string): Promise<void> {
  const conn = activeConnections.get(name);
  if (!conn) return;

  try {
    await conn.client.close();
    coworkLog('INFO', 'mcpClient', `Disconnected from "${name}"`);
  } catch (e) {
    coworkLog('WARN', 'mcpClient', `Error disconnecting "${name}": ${e instanceof Error ? e.message : String(e)}`);
  }
  activeConnections.delete(name);
}

/**
 * Disconnect all MCP servers.
 */
export async function disconnectAllMcpServers(): Promise<void> {
  const names = Array.from(activeConnections.keys());
  await Promise.allSettled(names.map(n => disconnectMcpServer(n)));
}

/**
 * Get currently connected server names.
 */
export function getConnectedServers(): string[] {
  return Array.from(activeConnections.keys());
}

// ── MCP Resources API (from OpenClaw src/mcp/channel-tools.ts) ──

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * List resources from a connected MCP server.
 */
export async function listMcpResources(serverName: string): Promise<McpResource[]> {
  const conn = activeConnections.get(serverName);
  if (!conn) return [];

  try {
    const result = await conn.client.listResources();
    return (result.resources || []).map((r: any) => ({
      uri: r.uri,
      name: r.name || r.uri,
      description: r.description,
      mimeType: r.mimeType,
    }));
  } catch (e) {
    coworkLog('WARN', 'mcpClient', `listResources failed for "${serverName}": ${e}`);
    return [];
  }
}

/**
 * Read a resource from a connected MCP server.
 */
export async function readMcpResource(serverName: string, uri: string): Promise<string | null> {
  const conn = activeConnections.get(serverName);
  if (!conn) return null;

  try {
    const result = await conn.client.readResource({ uri });
    const contents = result.contents || [];
    return contents.map((c: any) => c.text || '').join('\n');
  } catch (e) {
    coworkLog('WARN', 'mcpClient', `readResource failed for "${serverName}/${uri}": ${e}`);
    return null;
  }
}

// ── MCP Server (expose local tools as MCP server for other clients) ──
// Reference: OpenClaw src/mcp/plugin-tools-serve.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js';

let localServer: Server | null = null;

/**
 * Start a local MCP server that exposes NoobClaw tools to external MCP clients.
 * Useful for integrating with other AI tools that support MCP.
 */
export function startLocalMcpServer(
  tools: ToolDefinition[],
  options?: { name?: string; version?: string }
): Server {
  if (localServer) return localServer;

  localServer = new Server({
    name: options?.name || 'noobclaw',
    version: options?.version || '1.0.0',
  }, {
    capabilities: {
      tools: {},
    },
  });

  // Register tool list handler
  localServer.setRequestHandler({ method: 'tools/list' } as any, async () => {
    return {
      tools: tools.map(t => ({
        name: t.name,
        description: t.description.slice(0, 2048),
        inputSchema: z.toJSONSchema ? (z as any).toJSONSchema(t.inputSchema) : { type: 'object' },
      })),
    };
  });

  // Register tool call handler
  localServer.setRequestHandler({ method: 'tools/call' } as any, async (request: any) => {
    const toolName = request.params?.name;
    const toolArgs = request.params?.arguments || {};
    const tool = tools.find(t => t.name === toolName);

    if (!tool) {
      return { content: [{ type: 'text', text: `Tool "${toolName}" not found` }], isError: true };
    }

    try {
      const input = tool.inputSchema.parse(toolArgs);
      const result = await tool.call(input, { sessionId: 'mcp-external', cwd: process.cwd() });
      return {
        content: result.content.map(c => ({ type: 'text', text: c.text })),
        isError: result.isError,
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  });

  coworkLog('INFO', 'mcpClient', `Local MCP server started: ${tools.length} tools exposed`);
  return localServer;
}

export function stopLocalMcpServer(): void {
  if (localServer) {
    localServer.close().catch(() => {});
    localServer = null;
    coworkLog('INFO', 'mcpClient', 'Local MCP server stopped');
  }
}

// ── Connection health check ──

export async function checkConnectionHealth(serverName: string): Promise<boolean> {
  const conn = activeConnections.get(serverName);
  if (!conn) return false;
  try {
    await conn.client.listTools();
    return true;
  } catch {
    return false;
  }
}

export async function reconnectIfNeeded(serverName: string): Promise<boolean> {
  const healthy = await checkConnectionHealth(serverName);
  if (healthy) return true;

  // Connection lost — try to reconnect
  const conn = activeConnections.get(serverName);
  if (!conn) return false;

  coworkLog('WARN', 'mcpClient', `"${serverName}" unhealthy, attempting reconnect`);
  await disconnectMcpServer(serverName);
  // Caller needs to re-call connectMcpServer with original config
  return false;
}
