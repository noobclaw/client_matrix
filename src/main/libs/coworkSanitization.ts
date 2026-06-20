/**
 * Unicode sanitization — ported from Claude Code utils/sanitization.ts
 *
 * Prevents ASCII smuggling / hidden prompt injection attacks by stripping
 * invisible Unicode characters and normalizing to NFKC.
 */

const MAX_ITERATIONS = 10;

/**
 * Iteratively sanitize a string by NFKC-normalizing and stripping invisible
 * Unicode characters. Loops until stable (max 10 iterations).
 */
export function partiallySanitizeUnicode(prompt: string): string {
  let current = prompt;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const previous = current;

    // Step 1: NFKC normalization (collapses compatibility decompositions)
    current = current.normalize('NFKC');

    // Step 2: Strip Unicode property classes — format, private use, unassigned
    current = current.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, '');

    // Step 3: Explicit fallback ranges for environments where \p{} may not cover all
    current = current
      .replace(/[\u200B-\u200F]/g, '')   // Zero-width spaces, LTR/RTL marks
      .replace(/[\u202A-\u202E]/g, '')   // Directional formatting characters
      .replace(/[\u2066-\u2069]/g, '')   // Directional isolates
      .replace(/[\uFEFF]/g, '')          // Byte order mark
      .replace(/[\uE000-\uF8FF]/g, ''); // BMP Private Use Area

    if (current === previous) break;
  }
  return current;
}

/**
 * Recursively sanitize all string values in an object/array/primitive.
 */
export function recursivelySanitizeUnicode<T>(value: T): T {
  if (typeof value === 'string') {
    return partiallySanitizeUnicode(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(recursivelySanitizeUnicode) as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[partiallySanitizeUnicode(k)] = recursivelySanitizeUnicode(v);
    }
    return result as T;
  }
  return value;
}
