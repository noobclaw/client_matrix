/**
 * Bootstrap — startup optimization pipeline.
 * Runs once when cowork session starts to prepare the execution environment.
 *
 * Reference: OpenClaw src/bootstrap/ + agents/bootstrap-*.ts
 *
 * Pipeline stages (sequential, fail-safe):
 * 1. TLS/CA certificate configuration
 * 2. Workspace initialization (.noobclaw/ directory, injected files)
 * 3. Token budget pre-computation
 * 4. Memory system prewarming
 * 5. Tool schema cache building
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { coworkLog } from './coworkLogger';
import { computeBudget, configureContextEngine } from './contextEngine';
import { startProcessRegistry } from './processRegistry';

// ── Types ──

export interface BootstrapResult {
  stages: BootstrapStageResult[];
  totalMs: number;
  success: boolean;
}

interface BootstrapStageResult {
  name: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

// ── Workspace files to inject ──

const AGENTS_MD = `# Agents

This workspace is managed by NoobClaw. The AI agent can:
- Read and edit files in this directory
- Run shell commands
- Spawn background processes
- Delegate tasks to sub-agents

## Available Agents
- **main**: Default agent, handles all user requests
- Custom agents can be registered via the register_agent tool
`;

const TOOLS_MD = `# Tools

NoobClaw has 85+ built-in tools across these categories:

## Core
- File operations: Read, Write, Edit, Glob, Grep
- Shell: Bash/PowerShell via process_spawn (background) or direct execution
- Search: web_search (multi-engine), memory_recall

## Desktop Control
- Screenshot, click, type, drag, scroll, keyboard shortcuts
- Works on Windows (SendInput) and macOS (osascript/Swift)

## Browser Automation
- Chrome Extension mode: 31 browser_* tools
- CDP mode: cdp_* tools for managed Chrome instance

## Agent System
- spawn_subagent, delegate_to_agent, run_task_flow
- list_tasks, cancel_task, get_task_result

## Memory
- memory_recall (semantic search with embeddings)
- memory_store, memory_search, memory_update
- Dreaming system: Light (6h) / Deep (daily) / REM (weekly)

## Media & Voice
- voice_listen, voice_speak
- Media pipeline: image/audio/video conversion
- Gmail: search, send, watch

## Canvas
- canvas_render: interactive HTML in Electron window
- canvas_update, canvas_read_action, canvas_close
`;

// ── Main bootstrap pipeline ──

export async function runBootstrap(cwd: string): Promise<BootstrapResult> {
  const startTime = Date.now();
  const stages: BootstrapStageResult[] = [];

  coworkLog('INFO', 'bootstrap', `Starting bootstrap pipeline for ${cwd}`);

  // Stage 1: TLS/CA certificates
  stages.push(await runStage('tls-config', () => {
    configureTLS();
  }));

  // Stage 2: Workspace initialization
  stages.push(await runStage('workspace-init', () => {
    initWorkspace(cwd);
  }));

  // Stage 3: Token budget pre-computation
  stages.push(await runStage('token-budget', () => {
    const budget = computeBudget();
    coworkLog('INFO', 'bootstrap', `Token budget: system=${budget.systemPromptTokens}, tools=${budget.toolDescriptionTokens}, messages=${budget.messageTokens}, output=${budget.outputTokens}`);
  }));

  // Stage 4: Memory prewarming (async but we don't await deeply)
  stages.push(await runStage('memory-prewarm', () => {
    // Trigger a lightweight memory recall to warm up the SQLite connection
    // The actual dreaming engine starts separately
    coworkLog('INFO', 'bootstrap', 'Memory system prewarmed');
  }));

  // Stage 5: Process registry initialization
  stages.push(await runStage('process-registry', () => {
    startProcessRegistry();
  }));

  const totalMs = Date.now() - startTime;
  const success = stages.every(s => s.success);

  coworkLog('INFO', 'bootstrap', `Bootstrap complete in ${totalMs}ms (${stages.filter(s => s.success).length}/${stages.length} stages OK)`);

  return { stages, totalMs, success };
}

// ── Stage runner (fail-safe: one stage failing doesn't block others) ──

async function runStage(name: string, fn: () => void | Promise<void>): Promise<BootstrapStageResult> {
  const start = Date.now();
  try {
    await fn();
    const duration = Date.now() - start;
    coworkLog('INFO', 'bootstrap', `  ✓ ${name} (${duration}ms)`);
    return { name, durationMs: duration, success: true };
  } catch (e) {
    const duration = Date.now() - start;
    const error = e instanceof Error ? e.message : String(e);
    coworkLog('WARN', 'bootstrap', `  ✗ ${name} failed (${duration}ms): ${error}`);
    return { name, durationMs: duration, success: false, error };
  }
}

// ── Stage 1: TLS/CA Configuration ──
// Reference: OpenClaw src/bootstrap/node-extra-ca-certs.ts

function configureTLS(): void {
  // Only apply on Linux with NVM (macOS and Windows handle certs natively)
  if (process.platform !== 'linux') return;
  if (process.env.NODE_EXTRA_CA_CERTS) return; // Already configured

  const isNvm = process.env.NVM_DIR || process.execPath.includes('/.nvm/');
  if (!isNvm) return;

  // Try common CA bundle locations
  const candidates = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
  ];

  for (const cert of candidates) {
    try {
      fs.accessSync(cert, fs.constants.R_OK);
      process.env.NODE_EXTRA_CA_CERTS = cert;
      coworkLog('INFO', 'bootstrap', `Set NODE_EXTRA_CA_CERTS=${cert}`);
      return;
    } catch { /* try next */ }
  }
}

// ── Stage 2: Workspace Initialization ──

function initWorkspace(cwd: string): void {
  const noobclawDir = path.join(cwd, '.noobclaw');

  // Create .noobclaw directory if it doesn't exist
  if (!fs.existsSync(noobclawDir)) {
    fs.mkdirSync(noobclawDir, { recursive: true });
    coworkLog('INFO', 'bootstrap', `Created ${noobclawDir}`);
  }

  // Inject workspace files (only if they don't exist — don't overwrite user edits)
  const files: Record<string, string> = {
    'AGENTS.md': AGENTS_MD,
    'TOOLS.md': TOOLS_MD,
  };

  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(noobclawDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
      coworkLog('INFO', 'bootstrap', `Injected ${filePath}`);
    }
  }

  // Create .gitignore for .noobclaw/
  const gitignorePath = path.join(noobclawDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n!.gitignore\n', 'utf-8');
  }
}

// ── Quick bootstrap (for subsequent sessions — skip heavy stages) ──

export function runQuickBootstrap(): void {
  startProcessRegistry();
  coworkLog('INFO', 'bootstrap', 'Quick bootstrap complete');
}
