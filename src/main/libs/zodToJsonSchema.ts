/**
 * Zod → JSON Schema converter.
 *
 * Uses Zod v4's built-in z.toJSONSchema() which correctly handles all types,
 * constraints (min/max/int), descriptions, optionals, and defaults.
 *
 * We strip the $schema field since the Anthropic API doesn't expect it.
 */

import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  try {
    const jsonSchema = z.toJSONSchema(schema) as JsonSchema;
    // Strip $schema field — Anthropic API doesn't need it
    delete jsonSchema.$schema;
    return jsonSchema;
  } catch (e) {
    // Fallback for edge cases where toJSONSchema fails
    return { type: 'object', properties: {} };
  }
}
