/**
 * Tool System — defines the Tool interface and helpers for converting
 * between internal tool definitions and Anthropic API tool schemas.
 *
 * Ported from OpenClaw (Claude Code) src/Tool.ts + src/utils/api.ts
 */

import type { ZodType } from 'zod';
import { zodToJsonSchema } from './zodToJsonSchema';
import type { Tool as AnthropicTool } from './anthropicClient';
import { coworkLog } from './coworkLogger';

// ── Permission types (previously imported from claude-agent-sdk) ──

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
}

// ── Tool result ──

export interface ToolResultContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
  /**
   * Optional context modifier — applied after tool execution to update
   * the execution context (e.g., change cwd after a cd command).
   * Reference: OpenClaw src/Tool.ts ToolResult.contextModifier
   */
  contextModifier?: (ctx: ToolContext) => ToolContext;
}

// ── Tool context passed to call() ──

export interface ToolContext {
  sessionId: string;
  cwd: string;
  abortSignal?: AbortSignal;
}

// ── Core Tool interface ──
// Reference: OpenClaw src/Tool.ts

export interface ToolDefinition<TInput = Record<string, unknown>> {
  /** Unique tool name, sent to the API */
  name: string;

  /**
   * Rich, pedagogical description for the model.
   * Should include: when to use, when NOT to use, parameter explanations,
   * common mistakes, and relationship to other tools.
   * Reference: OpenClaw src/tools/[tool]/prompt.ts
   */
  description: string;

  /** Zod schema for input validation */
  inputSchema: ZodType<TInput>;

  /** Execute the tool and return results */
  call(input: TInput, context: ToolContext): Promise<ToolResult>;

  /**
   * Whether this tool can safely run in parallel with other tools.
   * Can be a static boolean OR a function that inspects input.
   * Read-only tools (search, read) → true
   * Write tools (edit, bash, write) → false
   * Reference: OpenClaw src/services/tools/toolOrchestration.ts
   */
  isConcurrencySafe?: boolean | ((input: any) => boolean);

  /** Whether this tool only reads without side effects */
  isReadOnly?: boolean;

  /** Whether this tool can cause irreversible changes */
  isDestructive?: boolean;
}

// ── Convert Tool to Anthropic API schema ──
// Reference: OpenClaw src/utils/api.ts toolToAPISchema()

export function toolToApiSchema(tool: ToolDefinition): AnthropicTool {
  let jsonSchema: Record<string, unknown>;

  try {
    jsonSchema = zodToJsonSchema(tool.inputSchema);
  } catch (e) {
    coworkLog('WARN', 'toolToApiSchema', `Failed to convert Zod schema for tool "${tool.name}", using empty schema`, {
      error: e instanceof Error ? e.message : String(e),
    });
    jsonSchema = { type: 'object', properties: {} };
  }

  // Clean schema for multi-model compatibility
  cleanSchemaForProviders(jsonSchema);

  return {
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchema as AnthropicTool['input_schema'],
  };
}

/**
 * Clean JSON Schema for multi-model compatibility.
 * Reference: OpenClaw pi-tools.schema.ts — per-provider cleaning
 *
 * Issues addressed:
 * - Gemini: doesn't support 'format', 'default', '$schema', 'examples'
 * - OpenAI: top-level must have 'type: "object"', no 'anyOf' at root
 * - Qwen/DeepSeek: some don't support 'enum' with single value
 */
function cleanSchemaForProviders(schema: Record<string, unknown>): void {
  // Remove keywords that Gemini/Qwen don't support
  delete schema['$schema'];
  delete schema['examples'];
  delete schema['$id'];

  // Recursively clean nested schemas
  if (schema.properties && typeof schema.properties === 'object') {
    for (const prop of Object.values(schema.properties as Record<string, any>)) {
      if (prop && typeof prop === 'object') {
        // Remove 'format' (Gemini rejects 'format: "uri"' etc)
        delete prop.format;
        // Remove 'default' (some models don't support it)
        delete prop.default;
        // Flatten single-value enum to const (better compatibility)
        if (Array.isArray(prop.enum) && prop.enum.length === 1) {
          prop.const = prop.enum[0];
          delete prop.enum;
        }
        // Recursively clean nested objects
        if (prop.properties) cleanSchemaForProviders(prop);
        // Clean items in arrays
        if (prop.items && typeof prop.items === 'object') {
          delete prop.items.format;
          delete prop.items.default;
          if (prop.items.properties) cleanSchemaForProviders(prop.items);
        }
      }
    }
  }

  // Flatten anyOf/oneOf at top level (OpenAI rejects these)
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf || schema.oneOf) as any[];
    if (variants.length > 0) {
      // Merge all variant properties into one object
      const merged: Record<string, unknown> = {};
      for (const v of variants) {
        if (v.properties) Object.assign(merged, v.properties);
      }
      schema.type = 'object';
      schema.properties = { ...((schema.properties || {}) as Record<string, unknown>), ...merged };
      delete schema.anyOf;
      delete schema.oneOf;
    }
  }

  // Ensure top-level has type: "object" (OpenAI requirement)
  if (!schema.type) schema.type = 'object';
}

/**
 * Convert an array of ToolDefinitions to API schemas.
 */
export function toolsToApiSchemas(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map(toolToApiSchema);
}

/**
 * Find a tool definition by name.
 */
export function findTool(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find(t => t.name === name);
}

/**
 * Build a simple tool definition from parts.
 * Convenience helper similar to the old SDK's tool() factory.
 */
export function buildTool(def: {
  name: string;
  description: string;
  inputSchema: ZodType<any>;
  call: (input: any, context: ToolContext) => Promise<ToolResult>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  isDestructive?: boolean;
}): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    call: def.call,
    isConcurrencySafe: def.isConcurrencySafe ?? false,
    isReadOnly: def.isReadOnly ?? false,
    isDestructive: def.isDestructive ?? false,
  };
}
