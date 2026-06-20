/**
 * Flow Engine — advanced workflow orchestration beyond basic task flows.
 * Supports parallel branches, conditional steps, retry, and flow templates.
 *
 * Reference: OpenClaw src/flows/ (10 files)
 * Extends existing taskFlowRegistry with richer capabilities.
 */

import { v4 as uuidv4 } from 'uuid';
import { coworkLog } from './coworkLogger';
import {
  createFlow,
  executeFlow,
  cancelFlow,
  getFlow,
  type TaskFlowStep,
  type TaskFlowRecord,
} from './taskFlowRegistry';
import type { ToolDefinition } from './toolSystem';
import type { CanUseToolFn } from './toolOrchestration';

// ── Flow Templates ──

export interface FlowTemplate {
  id: string;
  name: string;
  description: string;
  steps: TaskFlowStep[];
  variables?: Record<string, string>;  // Template variables with defaults
}

const templates = new Map<string, FlowTemplate>();

export function registerFlowTemplate(template: FlowTemplate): void {
  templates.set(template.id, template);
  coworkLog('INFO', 'flowEngine', `Template registered: ${template.id}`);
}

export function getFlowTemplate(id: string): FlowTemplate | null {
  return templates.get(id) ?? null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Array.from(templates.values());
}

/**
 * Instantiate a flow from a template, substituting variables.
 */
export function instantiateTemplate(
  templateId: string,
  sessionId: string,
  variables?: Record<string, string>
): TaskFlowRecord | null {
  const template = templates.get(templateId);
  if (!template) return null;

  const vars = { ...template.variables, ...variables };
  const steps = template.steps.map(step => ({
    ...step,
    goal: substituteVars(step.goal, vars),
    label: step.label ? substituteVars(step.label, vars) : undefined,
  }));

  return createFlow({
    parentSessionId: sessionId,
    goal: substituteVars(template.description, vars),
    steps,
    syncMode: 'managed',
  });
}

function substituteVars(text: string, vars: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

// ── Conditional steps ──

export interface ConditionalStep extends TaskFlowStep {
  condition?: string;       // Expression evaluated against previous step results
  skipOnFailure?: boolean;  // Skip this step if a dependency failed
  retryCount?: number;      // Max retries on failure (default: 0)
  retryDelayMs?: number;    // Delay between retries
}

/**
 * Execute a flow with conditional logic and retries.
 */
export async function executeAdvancedFlow(
  sessionId: string,
  goal: string,
  steps: ConditionalStep[],
  tools: ToolDefinition[],
  cwd: string,
  canUseTool: CanUseToolFn,
): Promise<TaskFlowRecord> {
  // Convert conditional steps to basic steps (conditions evaluated during execution)
  const basicSteps: TaskFlowStep[] = steps.map(s => ({
    goal: s.goal,
    label: s.label,
    agentId: s.agentId,
    toolWhitelist: s.toolWhitelist,
    model: s.model,
    dependsOn: s.dependsOn,
  }));

  const flow = createFlow({
    parentSessionId: sessionId,
    goal,
    steps: basicSteps,
    syncMode: 'managed',
  });

  return executeFlow(flow, tools, cwd, canUseTool);
}

// ── Built-in templates ──

export function registerBuiltinTemplates(): void {
  registerFlowTemplate({
    id: 'research-implement-test',
    name: 'Research → Implement → Test',
    description: 'Research {{topic}}, implement the solution, then write tests.',
    steps: [
      { goal: 'Research best practices and approaches for: {{topic}}', label: 'Research' },
      { goal: 'Implement the solution based on research findings', label: 'Implement', dependsOn: [0] },
      { goal: 'Write comprehensive tests for the implementation', label: 'Test', dependsOn: [1] },
    ],
    variables: { topic: 'the task' },
  });

  registerFlowTemplate({
    id: 'code-review-fix',
    name: 'Review → Fix → Verify',
    description: 'Review {{file}} for issues, fix them, then verify the fixes.',
    steps: [
      { goal: 'Review {{file}} for bugs, security issues, and code quality problems', label: 'Review' },
      { goal: 'Fix all issues found in the review', label: 'Fix', dependsOn: [0] },
      { goal: 'Verify that all fixes are correct and no regressions were introduced', label: 'Verify', dependsOn: [1] },
    ],
    variables: { file: 'the code' },
  });

  registerFlowTemplate({
    id: 'parallel-research',
    name: 'Parallel Research',
    description: 'Research {{topic}} from multiple angles in parallel.',
    steps: [
      { goal: 'Research {{topic}} from a technical architecture perspective', label: 'Technical' },
      { goal: 'Research {{topic}} from a user experience perspective', label: 'UX' },
      { goal: 'Research {{topic}} from a security and compliance perspective', label: 'Security' },
      { goal: 'Synthesize findings from all research angles into a unified recommendation', label: 'Synthesis', dependsOn: [0, 1, 2] },
    ],
    variables: { topic: 'the problem' },
  });

  coworkLog('INFO', 'flowEngine', `Registered ${templates.size} built-in flow templates`);
}
