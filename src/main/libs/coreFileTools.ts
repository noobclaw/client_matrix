/**
 * Core File Tools — Read, Write, Edit, Bash, Glob, Grep.
 * These are the fundamental tools that Claude Code / the old SDK provided built-in.
 * Now we register them explicitly since we use @anthropic-ai/sdk directly.
 */

import { z } from 'zod';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildTool, type ToolDefinition } from './toolSystem';
import { coworkLog } from './coworkLogger';

const IS_WIN = process.platform === 'win32';

export function buildCoreFileTools(): ToolDefinition[] {
  return [
    // ── Read: read file contents ──
    buildTool({
      name: 'Read',
      description: [
        'Read a file from the filesystem. Returns the file content with line numbers.',
        'Use offset and limit to read specific portions of large files.',
        'Can read text files, PDFs (first pages), images (returns metadata), and notebooks.',
      ].join('\n'),
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Absolute path to the file to read'),
        offset: z.number().optional().describe('Line number to start reading from (1-based)'),
        limit: z.number().optional().describe('Number of lines to read'),
      }),
      call: async (input, context) => {
        try {
          const filePath = path.isAbsolute(input.file_path)
            ? input.file_path
            : path.resolve(context.cwd, input.file_path);

          if (!fs.existsSync(filePath)) {
            return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
          }

          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            const entries = fs.readdirSync(filePath);
            return { content: [{ type: 'text', text: `Directory listing (${entries.length} entries):\n${entries.join('\n')}` }] };
          }

          // Size check
          if (stat.size > 5 * 1024 * 1024) {
            return { content: [{ type: 'text', text: `File too large (${Math.round(stat.size / 1024)}KB). Use offset and limit to read portions.` }], isError: true };
          }

          const raw = fs.readFileSync(filePath, 'utf-8');
          const lines = raw.split('\n');
          const start = (input.offset ?? 1) - 1;
          const end = input.limit ? start + input.limit : lines.length;
          const selected = lines.slice(Math.max(0, start), end);

          // Add line numbers
          const numbered = selected.map((line, i) => `${start + i + 1}\t${line}`);
          return { content: [{ type: 'text', text: numbered.join('\n') }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Read error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── Write: write file contents ──
    buildTool({
      name: 'Write',
      description: 'Write content to a file. Creates the file if it doesn\'t exist. Overwrites if it does.',
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Absolute path to the file'),
        content: z.string().describe('Content to write'),
      }),
      call: async (input, context) => {
        try {
          const filePath = path.isAbsolute(input.file_path)
            ? input.file_path
            : path.resolve(context.cwd, input.file_path);

          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

          fs.writeFileSync(filePath, input.content, 'utf-8');
          return { content: [{ type: 'text', text: `Written ${input.content.length} chars to ${filePath}` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Write error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    // ── Edit: replace text in a file ──
    buildTool({
      name: 'Edit',
      description: [
        'Replace a specific string in a file. The old_string must be unique in the file.',
        'Use this instead of Write when making targeted changes to existing files.',
      ].join('\n'),
      inputSchema: z.object({
        file_path: z.string().min(1),
        old_string: z.string().min(1).describe('The exact text to find and replace'),
        new_string: z.string().describe('The replacement text'),
      }),
      call: async (input, context) => {
        try {
          const filePath = path.isAbsolute(input.file_path)
            ? input.file_path
            : path.resolve(context.cwd, input.file_path);

          if (!fs.existsSync(filePath)) {
            return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true };
          }

          const content = fs.readFileSync(filePath, 'utf-8');
          const count = content.split(input.old_string).length - 1;

          if (count === 0) {
            return { content: [{ type: 'text', text: `String not found in ${filePath}` }], isError: true };
          }
          if (count > 1) {
            return { content: [{ type: 'text', text: `String found ${count} times — must be unique. Provide more context.` }], isError: true };
          }

          const newContent = content.replace(input.old_string, input.new_string);
          fs.writeFileSync(filePath, newContent, 'utf-8');
          return { content: [{ type: 'text', text: `Edited ${filePath}: replaced 1 occurrence` }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Edit error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    // ── Bash: execute shell commands ──
    buildTool({
      name: 'Bash',
      description: [
        'Execute a shell command and return stdout/stderr.',
        'On Windows uses PowerShell, on macOS/Linux uses bash.',
        'For long-running commands, use process_spawn instead.',
      ].join('\n'),
      inputSchema: z.object({
        command: z.string().min(1).describe('Shell command to execute'),
        timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
      }),
      call: async (input, context) => {
        try {
          const timeout = input.timeout ?? 30000;
          const shell = IS_WIN ? 'powershell.exe' : '/bin/bash';
          const args = IS_WIN
            ? ['-NoProfile', '-NonInteractive', '-Command', input.command]
            : ['-c', input.command];

          const result = spawnSync(shell, args, {
            cwd: context.cwd,
            timeout,
            encoding: 'utf-8',
            windowsHide: IS_WIN,
            maxBuffer: 1024 * 1024, // 1MB
          });

          const stdout = (result.stdout || '').trim();
          const stderr = (result.stderr || '').trim();
          const exitCode = result.status ?? -1;

          let output = '';
          if (stdout) output += stdout;
          if (stderr) output += (output ? '\n\nSTDERR:\n' : '') + stderr;
          if (!output) output = `(no output, exit code: ${exitCode})`;

          // Truncate
          if (output.length > 20000) {
            output = output.slice(0, 20000) + '\n\n[Output truncated at 20KB]';
          }

          return {
            content: [{ type: 'text', text: output }],
            isError: exitCode !== 0,
          };
        } catch (e) {
          return { content: [{ type: 'text', text: `Bash error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    }),

    // ── Glob: find files by pattern ──
    buildTool({
      name: 'Glob',
      description: [
        'Find files matching a glob pattern. Returns file paths sorted by modification time.',
        'Examples: "**/*.ts", "src/**/*.tsx", "*.json"',
      ].join('\n'),
      inputSchema: z.object({
        pattern: z.string().min(1).describe('Glob pattern (e.g., "**/*.ts")'),
        path: z.string().optional().describe('Directory to search in (default: cwd)'),
      }),
      call: async (input, context) => {
        try {
          const searchDir = input.path
            ? (path.isAbsolute(input.path) ? input.path : path.resolve(context.cwd, input.path))
            : context.cwd;

          // Use shell find/dir command since we don't have a glob library
          let cmd: string;
          if (IS_WIN) {
            // PowerShell Get-ChildItem with -Filter
            const pattern = input.pattern.replace(/\*\*\//g, '');
            cmd = `powershell -NoProfile -Command "Get-ChildItem -Path '${searchDir}' -Recurse -Filter '${pattern}' -File | Select-Object -ExpandProperty FullName | Select-Object -First 100"`;
          } else {
            cmd = `find "${searchDir}" -name "${input.pattern.replace(/\*\*\//g, '')}" -type f 2>/dev/null | head -100`;
          }

          const result = execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd: context.cwd }).trim();
          if (!result) return { content: [{ type: 'text', text: 'No files found.' }] };

          return { content: [{ type: 'text', text: result }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `Glob error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),

    // ── Grep: search file contents ──
    buildTool({
      name: 'Grep',
      description: [
        'Search for a pattern in file contents. Uses regex by default.',
        'Returns matching lines with file paths and line numbers.',
      ].join('\n'),
      inputSchema: z.object({
        pattern: z.string().min(1).describe('Regex pattern to search for'),
        path: z.string().optional().describe('File or directory to search (default: cwd)'),
        include: z.string().optional().describe('File glob filter (e.g., "*.ts")'),
      }),
      call: async (input, context) => {
        try {
          const searchPath = input.path
            ? (path.isAbsolute(input.path) ? input.path : path.resolve(context.cwd, input.path))
            : context.cwd;

          let cmd: string;
          const escapedPattern = input.pattern.replace(/"/g, '\\"');

          if (IS_WIN) {
            const includeArg = input.include ? `-Include '${input.include}'` : '';
            cmd = `powershell -NoProfile -Command "Get-ChildItem -Path '${searchPath}' -Recurse ${includeArg} -File | Select-String -Pattern '${escapedPattern}' | Select-Object -First 50 | ForEach-Object { $_.ToString() }"`;
          } else {
            const includeArg = input.include ? `--include='${input.include}'` : '';
            cmd = `grep -rn ${includeArg} "${escapedPattern}" "${searchPath}" 2>/dev/null | head -50`;
          }

          const result = execSync(cmd, { encoding: 'utf-8', timeout: 15000, cwd: context.cwd }).trim();
          if (!result) return { content: [{ type: 'text', text: 'No matches found.' }] };

          return { content: [{ type: 'text', text: result }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('exit code 1') || msg.includes('status 1')) {
            return { content: [{ type: 'text', text: 'No matches found.' }] };
          }
          return { content: [{ type: 'text', text: `Grep error: ${msg}` }], isError: true };
        }
      },
      isConcurrencySafe: true,
      isReadOnly: true,
    }),
  ];
}
