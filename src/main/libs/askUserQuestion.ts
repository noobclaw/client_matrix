/**
 * AskUserQuestion Tool — model asks user structured multiple-choice questions.
 * Instead of guessing, the model presents options for the user to choose.
 *
 * Reference: Claude Code src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import { coworkLog } from './coworkLogger';

// ── Types (for renderer to consume via IPC) ──

export interface UserQuestion {
  question: string;
  header: string;           // Short label (max 12 chars): "Auth method", "Library"
  options: UserQuestionOption[];
  multiSelect: boolean;
}

export interface UserQuestionOption {
  label: string;            // 1-5 words
  description: string;      // Explanation of this option
  preview?: string;         // Optional: code snippet or mockup shown on hover
}

export interface UserQuestionResponse {
  answers: Record<string, string>;   // question → selected option label
  annotations?: Record<string, { notes?: string }>;
}

// ── Pending question state ──

let pendingResolve: ((response: UserQuestionResponse) => void) | null = null;
let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Called from IPC when user answers the question.
 */
export function resolveUserQuestion(response: UserQuestionResponse): void {
  if (pendingResolve) {
    pendingResolve(response);
    pendingResolve = null;
    if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }
  }
}

// ── Tool definition ──

export function buildAskUserQuestionTool(
  emitQuestion: (sessionId: string, questions: UserQuestion[]) => void
): ToolDefinition {
  return buildTool({
    name: 'AskUserQuestion',
    description: [
      'Ask the user a question with multiple-choice options.',
      'Use when you need user input on a decision: which approach to take,',
      'which library to use, what configuration to apply, etc.',
      '',
      'Provide 2-4 clear options with descriptions.',
      'The user can also type a custom response if none of the options fit.',
      '',
      'Do NOT use this for yes/no questions — just proceed with the best approach.',
      'Do NOT use this repeatedly — gather all needed info in one call.',
    ].join('\n'),
    inputSchema: z.object({
      questions: z.array(z.object({
        question: z.string().min(1).describe('The question to ask'),
        header: z.string().max(12).optional().describe('Short label like "Auth method"'),
        options: z.array(z.object({
          label: z.string().min(1).describe('Option label (1-5 words)'),
          description: z.string().describe('What this option means'),
          preview: z.string().optional().describe('Code snippet or mockup'),
        })).min(2).max(4),
        multiSelect: z.boolean().optional().describe('Allow multiple selections (default: false)'),
      })).min(1).max(4),
    }),
    call: async (input, context) => {
      const questions: UserQuestion[] = input.questions.map((q: any) => ({
        question: q.question,
        header: q.header || q.question.slice(0, 12),
        options: q.options,
        multiSelect: q.multiSelect ?? false,
      }));

      coworkLog('INFO', 'askUserQuestion', `Asking ${questions.length} question(s): ${questions.map(q => q.question.slice(0, 50)).join('; ')}`);

      // Emit to renderer via IPC
      emitQuestion(context.sessionId, questions);

      // Wait for user response (timeout: 5 minutes)
      const response = await new Promise<UserQuestionResponse>((resolve) => {
        pendingResolve = resolve;
        pendingTimeout = setTimeout(() => {
          pendingResolve = null;
          resolve({ answers: { [questions[0].question]: '(no response — timed out)' } });
        }, 5 * 60 * 1000);
      });

      // Format response
      const lines: string[] = [];
      for (const [question, answer] of Object.entries(response.answers)) {
        lines.push(`Q: ${question}`);
        lines.push(`A: ${answer}`);
        const note = response.annotations?.[question]?.notes;
        if (note) lines.push(`Note: ${note}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') || '(no answers provided)' }],
      };
    },
  });
}
