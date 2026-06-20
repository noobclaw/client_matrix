/**
 * Coordinator Mode — multi-worker orchestration for complex tasks.
 * Main agent becomes a project manager, spawning workers for subtasks.
 *
 * Reference: Claude Code src/coordinator/coordinatorMode.ts
 *
 * Workflow: Analyze → Plan → Spawn workers → Monitor → Synthesize
 */

import { coworkLog } from './coworkLogger';

// ── Types ──

export interface CoordinatorConfig {
  enabled: boolean;
  maxWorkers: number;           // Max parallel workers (default: 5)
  autoDetect: boolean;          // Auto-detect when coordinator mode is useful
  workerModel?: string;         // Model for workers (default: same as main)
}

export interface WorkerTask {
  id: string;
  goal: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  taskId?: string;              // References taskRegistry task
  result?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface CoordinatorPlan {
  goal: string;
  phases: CoordinatorPhase[];
  workers: WorkerTask[];
}

export interface CoordinatorPhase {
  name: string;
  description: string;
  workerIds: string[];           // Which workers run in this phase
  dependsOnPhase?: number;       // Phase index dependency
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  enabled: true,
  maxWorkers: 5,
  autoDetect: true,
};

let config = { ...DEFAULT_CONFIG };

// ── Configure ──

export function configureCoordinator(custom?: Partial<CoordinatorConfig>): void {
  if (custom) config = { ...config, ...custom };
}

// ── Detection: should we use coordinator mode? ──

/**
 * Detect if a task would benefit from multi-worker coordination.
 */
export function shouldUseCoordinatorMode(prompt: string): boolean {
  if (!config.enabled || !config.autoDetect) return false;

  const lower = prompt.toLowerCase();

  // Explicit multi-task indicators
  if (/\b(parallel|simultaneously|at the same time|in parallel)\b/i.test(prompt)) return true;
  if (/\b(multiple files|several files|many files|across.*files)\b/i.test(prompt)) return true;

  // Complex project-level tasks
  const complexPatterns = [
    /\b(full.stack|end.to.end|complete.*feature|entire.*system)\b/i,
    /\b(research.*then.*implement|analyze.*then.*fix)\b/i,
    /\b(refactor.*entire|rewrite.*all|migrate.*from.*to)\b/i,
    /\b(test.*and.*fix|review.*and.*update)\b/i,
  ];

  return complexPatterns.filter(p => p.test(prompt)).length >= 1;
}

// ── System prompt for coordinator ──

/**
 * Build the coordinator system prompt section.
 * Injected when coordinator mode is active.
 */
export function getCoordinatorPrompt(): string {
  return [
    '## Coordinator Mode',
    '',
    'You are operating as a **project coordinator**. Your role is to:',
    '1. Break complex tasks into independent subtasks',
    '2. Spawn workers via `spawn_subagent` for each subtask',
    '3. Monitor progress via `get_task_result`',
    '4. Synthesize results into a coherent deliverable',
    '',
    '### When to Spawn Workers',
    '- Tasks that can run independently (e.g., researching different aspects)',
    '- File modifications that don\'t conflict (different files/modules)',
    '- Test suites that can run in parallel',
    '',
    '### When NOT to Spawn Workers',
    '- Sequential dependencies (step B needs step A\'s output)',
    '- Simple single-file changes',
    '- Tasks requiring real-time user interaction',
    '',
    '### Worker Guidelines',
    '- Give each worker a CLEAR, SPECIFIC goal (not vague)',
    '- Include relevant context (file paths, function names, error messages)',
    '- Use `run_in_background: true` for parallel execution',
    '- Check results with `get_task_result` before synthesizing',
    '',
    '### Workflow Phases',
    '1. **Research** — Understand the problem (spawn research workers)',
    '2. **Plan** — Design the solution based on research',
    '3. **Implement** — Spawn implementation workers',
    '4. **Verify** — Run tests, check for regressions',
    '5. **Synthesize** — Combine results, report to user',
    '',
    '### Example',
    '```',
    'User: "Add authentication to the API"',
    '',
    'Coordinator thinks:',
    '- Worker 1: Research existing auth patterns in codebase',
    '- Worker 2: Research best practices for JWT auth',
    '- (wait for research)',
    '- Worker 3: Implement auth middleware',
    '- Worker 4: Add auth to route handlers',
    '- Worker 5: Write tests',
    '```',
  ].join('\n');
}

// ── Plan builder ──

/**
 * Create a coordinator plan from a task description.
 * The plan structures the work into phases with worker assignments.
 */
export function createCoordinatorPlan(goal: string, subtasks: string[]): CoordinatorPlan {
  const workers: WorkerTask[] = subtasks.map((task, i) => ({
    id: `worker-${i + 1}`,
    goal: task,
    status: 'pending' as const,
  }));

  // Default: all workers in a single parallel phase
  const phases: CoordinatorPhase[] = [{
    name: 'Execute',
    description: 'Run all subtasks',
    workerIds: workers.map(w => w.id),
  }];

  coworkLog('INFO', 'coordinatorMode', `Plan created: ${workers.length} workers, ${phases.length} phases`);
  return { goal, phases, workers };
}

/**
 * Create a phased plan (research → implement → verify).
 */
export function createPhasedPlan(
  goal: string,
  research: string[],
  implementation: string[],
  verification: string[]
): CoordinatorPlan {
  const workers: WorkerTask[] = [];
  let idx = 0;

  const researchWorkers = research.map(task => {
    const w: WorkerTask = { id: `research-${++idx}`, goal: task, status: 'pending' };
    workers.push(w);
    return w.id;
  });

  const implWorkers = implementation.map(task => {
    const w: WorkerTask = { id: `impl-${++idx}`, goal: task, status: 'pending' };
    workers.push(w);
    return w.id;
  });

  const verifyWorkers = verification.map(task => {
    const w: WorkerTask = { id: `verify-${++idx}`, goal: task, status: 'pending' };
    workers.push(w);
    return w.id;
  });

  const phases: CoordinatorPhase[] = [];
  if (researchWorkers.length > 0) {
    phases.push({ name: 'Research', description: 'Understand the problem', workerIds: researchWorkers });
  }
  if (implWorkers.length > 0) {
    phases.push({ name: 'Implement', description: 'Build the solution', workerIds: implWorkers, dependsOnPhase: phases.length > 0 ? 0 : undefined });
  }
  if (verifyWorkers.length > 0) {
    phases.push({ name: 'Verify', description: 'Test and validate', workerIds: verifyWorkers, dependsOnPhase: phases.length > 0 ? phases.length - 1 : undefined });
  }

  return { goal, phases, workers };
}

// ── Format for display ──

export function formatCoordinatorPlan(plan: CoordinatorPlan): string {
  const lines = [`**Coordinator Plan**: ${plan.goal}`, ''];

  for (const phase of plan.phases) {
    lines.push(`### ${phase.name}`);
    lines.push(phase.description);
    const phaseWorkers = plan.workers.filter(w => phase.workerIds.includes(w.id));
    for (const w of phaseWorkers) {
      const icon = { pending: '○', running: '◉', completed: '●', failed: '✗' }[w.status];
      lines.push(`  ${icon} ${w.id}: ${w.goal}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
