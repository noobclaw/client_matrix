/**
 * Agent Summary — automatic compression of subagent results.
 *
 * Problem: `spawn_subagent` returns the raw subagent `result` field
 * straight to the parent agent's tool-result message. For a subagent
 * that did "grep the 20 biggest files in this repo for TODO" that's
 * easily 3000-8000 tokens of raw grep output dumped into the parent
 * context. Over a long unattended run this is the single biggest
 * source of context-window explosions.
 *
 * Fix: before returning, if the raw result exceeds SUMMARY_THRESHOLD
 * chars, compress it via a cheap LLM call to ~400 chars that keeps
 * "what the subagent concluded" and "what files / paths / commands
 * were involved" but drops all the verbatim output. The full raw
 * result is still written to disk for audit, only the summary enters
 * the parent context.
 *
 * Designed to fall through gracefully when:
 *  - the result is already short (under threshold)
 *  - no API config is available (sidecar bootstrap race)
 *  - the summary call itself fails (network / 429 / etc.)
 *
 * The caller should treat a null return as "use the raw result" —
 * never fail the subagent because summarization didn't work.
 *
 * Reference: Claude Code src/services/AgentSummary/agentSummary.ts
 */

import { resolveCurrentApiConfig } from './claudeSettings';
import { coworkLog } from './coworkLogger';

const SUMMARY_THRESHOLD = 2000; // chars
const SUMMARY_MAX_OUTPUT_TOKENS = 500;
const SUMMARY_TIMEOUT_MS = 30_000;

const SUMMARY_SYSTEM_PROMPT = [
  'You are a sub-agent result compressor.',
  '',
  'You will receive the full output of a sub-agent that was spawned to',
  'complete a specific goal. Compress it to a dense summary that keeps:',
  '',
  '  1. What the sub-agent actually did (key tool calls, file paths',
  '     touched, commands run)',
  '  2. The final conclusion / answer / result',
  '  3. Any errors, warnings, or TODOs discovered',
  '  4. Concrete data the parent agent will need (URLs, counts, IDs,',
  '     file paths, numbers — keep these verbatim)',
  '',
  'Drop:',
  '  - Verbatim file contents and long output blocks',
  '  - Redundant "I will now..." narration',
  '  - Thinking-out-loud and process descriptions',
  '',
  'Output target: under 400 tokens. Use bullet points. No apologies,',
  'no "the agent..." preamble — just the compressed information.',
].join('\n');

export interface AgentSummaryInput {
  goal: string;
  rawResult: string;
  status: 'succeeded' | 'failed';
  error?: string | null;
}

export interface AgentSummaryResult {
  /** Compressed text, or the original rawResult if compression was skipped. */
  text: string;
  /** True when the returned text is a real LLM compression, false when it's the raw passthrough. */
  compressed: boolean;
  /** Original length in chars, for logging. */
  originalChars: number;
}

/**
 * Compress a subagent result down to a short summary using the cheap
 * OpenAI-compat endpoint the main runner already talks to.
 *
 * The actual compression path uses raw fetch rather than the anthropic
 * SDK so we can't accidentally inherit the caller's abort signal or
 * tool schemas.
 */
export async function summarizeAgentResult(
  input: AgentSummaryInput,
): Promise<AgentSummaryResult> {
  const raw = input.rawResult || '';
  const originalChars = raw.length;

  // Short-circuit: already small enough, return raw.
  if (originalChars < SUMMARY_THRESHOLD) {
    return { text: raw, compressed: false, originalChars };
  }

  // Resolve the API config from the current session's provider. We use
  // the sandbox target because sandbox is strictly cheaper (proxies to
  // the openai-compat endpoint) and summarization doesn't need a
  // streaming response. Fall back to 'local' if sandbox unavailable.
  const resolved =
    resolveCurrentApiConfig('sandbox').config
    || resolveCurrentApiConfig('local').config;
  if (!resolved) {
    coworkLog('WARN', 'agentSummary', 'No API config — returning raw result');
    return { text: raw, compressed: false, originalChars };
  }

  const apiConfig = resolved as {
    apiKey: string;
    baseURL: string;
    model: string;
    apiType?: string;
  };

  // Build an OpenAI-compat chat completion payload. The proxy handles
  // both Anthropic and OpenAI baseURLs transparently; we just need a
  // plain chat request with system + user messages.
  const userContent =
    `Sub-agent goal: ${input.goal}\n`
    + `Sub-agent status: ${input.status}`
    + (input.error ? `\nError: ${input.error}` : '')
    + `\n\n--- Raw output (${originalChars} chars) ---\n${raw}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const url = `${apiConfig.baseURL.replace(/\/$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiConfig.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: apiConfig.model,
        max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      coworkLog('WARN', 'agentSummary', `LLM summary call failed: ${resp.status} ${body.slice(0, 200)}`);
      return { text: raw, compressed: false, originalChars };
    }

    const data = await resp.json();
    const summary: string | undefined =
      data?.choices?.[0]?.message?.content
      || data?.content?.[0]?.text;
    if (!summary || summary.trim().length === 0) {
      coworkLog('WARN', 'agentSummary', 'LLM returned empty summary');
      return { text: raw, compressed: false, originalChars };
    }

    coworkLog('INFO', 'agentSummary', `Compressed ${originalChars} → ${summary.length} chars`);
    return { text: summary.trim(), compressed: true, originalChars };
  } catch (e: any) {
    coworkLog('WARN', 'agentSummary', `Summary failed: ${e?.message || e}`);
    return { text: raw, compressed: false, originalChars };
  } finally {
    clearTimeout(timer);
  }
}
