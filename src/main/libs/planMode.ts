/**
 * Plan Mode — structured planning and approval for complex/risky tasks.
 * Simple tasks execute immediately. Complex tasks show a plan first.
 *
 * Reference: Claude Code src/tools/EnterPlanModeTool + ExitPlanModeTool
 *
 * Flow: detect complexity → enter plan mode → show plan → user approves → execute
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { coworkLog } from './coworkLogger';

// ── Types ──

export type PlanStatus = 'drafting' | 'awaiting_approval' | 'approved' | 'rejected' | 'executing' | 'completed';

export interface Plan {
  id: string;
  sessionId: string;
  status: PlanStatus;
  title: string;
  summary: string;
  steps: PlanStep[];
  estimatedEffort: 'small' | 'medium' | 'large';
  filesToModify: string[];
  risks: string[];
  createdAt: number;
  approvedAt: number | null;
  completedAt: number | null;
}

export interface PlanStep {
  index: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  tools: string[];          // Tools this step will use
}

// ── State ──

const activePlans = new Map<string, Plan>();
const PLANS_DIR = path.join(os.tmpdir(), 'noobclaw-plans');

// ── Complexity detection ──

/**
 * Determine if a task should use plan mode.
 * Returns true for tasks that are complex, risky, or touch many files.
 */
export function shouldUsePlanMode(prompt: string, context?: {
  fileCount?: number;
  hasDestructiveOps?: boolean;
}): boolean {
  const lower = prompt.toLowerCase();

  // Explicit plan request
  if (/\b(plan|design|architect|strategy)\s+(first|before|out)\b/i.test(prompt)) return true;
  if (/\bmake a plan\b/i.test(prompt)) return true;

  // Complex indicators
  const complexPatterns = [
    /\b(refactor|rewrite|migrate|redesign|overhaul)\b/i,
    /\b(multi[- ]?file|across.*files|entire.*codebase)\b/i,
    /\b(breaking change|backwards? compat|api change)\b/i,
    /\b(deploy|publish|release|production)\b/i,
    /\b(database|schema|migration)\b/i,
  ];

  const complexCount = complexPatterns.filter(p => p.test(prompt)).length;
  if (complexCount >= 2) return true;

  // Multi-file indicator
  if (context?.fileCount && context.fileCount > 5) return true;

  // Destructive operations
  if (context?.hasDestructiveOps) return true;

  return false;
}

// ── Plan CRUD ──

export function createPlan(sessionId: string, title: string, summary: string): Plan {
  const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const plan: Plan = {
    id,
    sessionId,
    status: 'drafting',
    title,
    summary,
    steps: [],
    estimatedEffort: 'medium',
    filesToModify: [],
    risks: [],
    createdAt: Date.now(),
    approvedAt: null,
    completedAt: null,
  };

  activePlans.set(id, plan);
  savePlanToDisk(plan);
  coworkLog('INFO', 'planMode', `Plan created: ${id} — ${title}`);
  return plan;
}

export function addPlanStep(planId: string, description: string, tools?: string[]): PlanStep | null {
  const plan = activePlans.get(planId);
  if (!plan) return null;

  const step: PlanStep = {
    index: plan.steps.length,
    description,
    status: 'pending',
    tools: tools ?? [],
  };

  plan.steps.push(step);
  savePlanToDisk(plan);
  return step;
}

export function setPlanStatus(planId: string, status: PlanStatus): Plan | null {
  const plan = activePlans.get(planId);
  if (!plan) return null;

  plan.status = status;
  if (status === 'approved') plan.approvedAt = Date.now();
  if (status === 'completed') plan.completedAt = Date.now();

  savePlanToDisk(plan);
  coworkLog('INFO', 'planMode', `Plan ${planId} → ${status}`);
  return plan;
}

export function updateStepStatus(planId: string, stepIndex: number, status: PlanStep['status']): boolean {
  const plan = activePlans.get(planId);
  if (!plan || !plan.steps[stepIndex]) return false;
  plan.steps[stepIndex].status = status;
  savePlanToDisk(plan);
  return true;
}

export function getPlan(planId: string): Plan | null {
  return activePlans.get(planId) ?? null;
}

export function getActivePlan(sessionId: string): Plan | null {
  for (const plan of activePlans.values()) {
    if (plan.sessionId === sessionId && plan.status !== 'completed' && plan.status !== 'rejected') {
      return plan;
    }
  }
  return null;
}

// ── Format for display ──

export function formatPlanForDisplay(plan: Plan): string {
  const statusIcon = {
    drafting: '📝', awaiting_approval: '⏳', approved: '✅',
    rejected: '❌', executing: '🔄', completed: '✅',
  }[plan.status];

  const lines = [
    `${statusIcon} **${plan.title}** (${plan.status})`,
    plan.summary,
    '',
    `Estimated effort: ${plan.estimatedEffort}`,
  ];

  if (plan.filesToModify.length > 0) {
    lines.push(`Files to modify: ${plan.filesToModify.join(', ')}`);
  }

  if (plan.risks.length > 0) {
    lines.push(`Risks: ${plan.risks.join('; ')}`);
  }

  if (plan.steps.length > 0) {
    lines.push('', 'Steps:');
    for (const step of plan.steps) {
      const icon = { pending: '○', in_progress: '◉', completed: '●', skipped: '○' }[step.status];
      lines.push(`  ${icon} ${step.index + 1}. ${step.description}`);
    }
  }

  return lines.join('\n');
}

// ── System prompt injection ──

/**
 * Get plan mode guidance for the system prompt.
 * Only added when plan mode is active for the session.
 */
export function getPlanModePrompt(sessionId: string): string | null {
  const plan = getActivePlan(sessionId);
  if (!plan) return null;

  if (plan.status === 'drafting' || plan.status === 'awaiting_approval') {
    return [
      '## Plan Mode Active',
      'You are in plan mode. Do NOT execute any file modifications or destructive actions.',
      'Instead, outline your plan step by step. When done, present it for user approval.',
      'Only after approval should you begin executing the plan.',
    ].join('\n');
  }

  if (plan.status === 'approved' || plan.status === 'executing') {
    return [
      '## Executing Approved Plan',
      `Plan: ${plan.title}`,
      `Steps remaining: ${plan.steps.filter(s => s.status === 'pending').length}/${plan.steps.length}`,
      'Follow the approved plan. Mark each step as you complete it.',
      'Do not deviate from the plan without informing the user.',
    ].join('\n');
  }

  return null;
}

// ── Persistence ──

function savePlanToDisk(plan: Plan): void {
  try {
    if (!fs.existsSync(PLANS_DIR)) fs.mkdirSync(PLANS_DIR, { recursive: true });
    const filePath = path.join(PLANS_DIR, `${plan.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf-8');
  } catch {}
}

export function cleanupOldPlans(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  try {
    if (!fs.existsSync(PLANS_DIR)) return;
    const cutoff = Date.now() - maxAgeMs;
    for (const file of fs.readdirSync(PLANS_DIR)) {
      const filePath = path.join(PLANS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch {}
    }
  } catch {}
}
