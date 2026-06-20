/**
 * Process Tools — tool definitions for background process management.
 * Allows agent to spawn dev servers, run builds, and manage long-lived processes.
 *
 * Reference: OpenClaw src/process/ tool integration
 */

import { z } from 'zod';
import { buildTool, type ToolDefinition } from './toolSystem';
import {
  spawnProcess,
  pollProcess,
  pollProcessDelta,
  writeToProcess,
  killProcess,
  listProcesses,
  getRunningCount,
  type ProcessLane,
} from './processRegistry';

export function buildProcessTools(): ToolDefinition[] {
  return [
    buildTool({
      name: 'process_spawn',
      description: [
        'Spawn a background process that runs while you continue working.',
        'Use this for: dev servers (npm run dev), file watchers, builds, tests.',
        '',
        'The process runs in the background. Use process_poll to check output,',
        'process_write to send input, and process_kill to stop it.',
        '',
        'Example: spawn "npm run dev" then continue editing code.',
      ].join('\n'),
      inputSchema: z.object({
        command: z.string().min(1).describe('Command to run (e.g., "npm", "node", "python")'),
        args: z.array(z.string()).optional().describe('Command arguments (e.g., ["run", "dev"])'),
        cwd: z.string().optional().describe('Working directory (default: current)'),
        lane: z.enum(['main', 'background']).optional().describe('Execution lane (default: background)'),
        timeout_minutes: z.number().min(1).max(120).optional().describe('Max run time in minutes (default: 30)'),
      }),
      call: async (input, context) => {
        const run = spawnProcess({
          command: input.command,
          args: input.args,
          cwd: input.cwd || context.cwd,
          lane: (input.lane as ProcessLane) || 'background',
          scopeKey: context.sessionId,
          totalTimeoutMs: input.timeout_minutes ? input.timeout_minutes * 60 * 1000 : undefined,
        });

        if (!run) {
          return { content: [{ type: 'text', text: 'Failed to spawn: lane at capacity. Kill some processes first.' }], isError: true };
        }

        if (run.state === 'exited' && run.exitCode !== 0) {
          return { content: [{ type: 'text', text: `Spawn failed: ${run.stderr || 'Unknown error'}` }], isError: true };
        }

        return {
          content: [{
            type: 'text',
            text: [
              `Process spawned in background.`,
              `  Run ID: ${run.runId}`,
              `  PID: ${run.pid}`,
              `  Command: ${run.command} ${(run.args || []).join(' ')}`,
              `  Lane: ${run.lane}`,
              '',
              'Use process_poll to check output, process_kill to stop.',
            ].join('\n'),
          }],
        };
      },
    }),

    buildTool({
      name: 'process_poll',
      description: [
        'Get the latest output from a background process.',
        'Returns stdout, stderr, and current state (running/stalled/exited).',
        'Use delta=true to get only new output since last poll.',
      ].join('\n'),
      inputSchema: z.object({
        run_id: z.string().min(1).describe('Process run ID from process_spawn'),
        delta: z.boolean().optional().describe('Only return new output since last poll (default: false)'),
        tail_lines: z.number().min(1).max(200).optional().describe('Only show last N lines of output'),
      }),
      call: async (input) => {
        const result = input.delta
          ? pollProcessDelta(input.run_id)
          : pollProcess(input.run_id);

        if (!result) {
          return { content: [{ type: 'text', text: `Process ${input.run_id} not found.` }], isError: true };
        }

        let stdout = result.stdout;
        let stderr = result.stderr;

        if (input.tail_lines) {
          stdout = stdout.split('\n').slice(-input.tail_lines).join('\n');
          stderr = stderr.split('\n').slice(-input.tail_lines).join('\n');
        }

        // Truncate to avoid huge tool results
        if (stdout.length > 10000) stdout = '...(truncated)\n' + stdout.slice(-10000);
        if (stderr.length > 5000) stderr = '...(truncated)\n' + stderr.slice(-5000);

        const parts: string[] = [`State: ${result.state}`];
        if ('exitCode' in result && result.exitCode !== null) parts.push(`Exit code: ${result.exitCode}`);
        if (stdout.trim()) parts.push(`\n--- stdout ---\n${stdout}`);
        if (stderr.trim()) parts.push(`\n--- stderr ---\n${stderr}`);
        if (!stdout.trim() && !stderr.trim()) parts.push('(no output)');

        return { content: [{ type: 'text', text: parts.join('\n') }] };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'process_list',
      description: 'List all background processes with their status.',
      inputSchema: z.object({
        show_exited: z.boolean().optional().describe('Include exited processes (default: false)'),
      }),
      call: async (input) => {
        const procs = listProcesses();
        const filtered = input.show_exited
          ? procs
          : procs.filter(p => p.state !== 'exited');

        if (filtered.length === 0) {
          return { content: [{ type: 'text', text: `No ${input.show_exited ? '' : 'running '}processes.` }] };
        }

        const lines = filtered.map(p => {
          const age = Math.round((Date.now() - p.startedAt) / 1000);
          return `[${p.state.toUpperCase()}] ${p.runId} — ${p.command} ${p.args.join(' ')} (${age}s, pid=${p.pid || '?'})`;
        });

        return {
          content: [{
            type: 'text',
            text: `Processes (${filtered.length}, ${getRunningCount()} running):\n${lines.join('\n')}`,
          }],
        };
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    buildTool({
      name: 'process_write',
      description: 'Write data to a background process stdin. Use for interactive processes that expect input.',
      inputSchema: z.object({
        run_id: z.string().min(1),
        data: z.string().min(1).describe('Data to write (newline appended automatically if not present)'),
      }),
      call: async (input) => {
        const data = input.data.endsWith('\n') ? input.data : input.data + '\n';
        const success = writeToProcess(input.run_id, data);
        return {
          content: [{ type: 'text', text: success ? `Wrote ${data.length} bytes to ${input.run_id}` : `Failed: process not found or not running.` }],
          isError: !success,
        };
      },
    }),

    buildTool({
      name: 'process_kill',
      description: 'Kill a background process and all its children. Uses graceful shutdown (SIGTERM → 5s → SIGKILL).',
      inputSchema: z.object({
        run_id: z.string().min(1),
      }),
      call: async (input) => {
        const killed = await killProcess(input.run_id);
        return {
          content: [{ type: 'text', text: killed ? `Process ${input.run_id} killed.` : `Process not found or already exited.` }],
          isError: !killed,
        };
      },
    }),
  ];
}
