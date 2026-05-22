/**
 * Minimal helper to run a one-shot task in a headless pi subprocess.
 * Mirrors what pi-subagents does internally, without importing its internals.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PiTaskOptions {
  tools?: string[];
  cwd?: string;
  onStderr?: (line: string) => void;
}

export function runPiTask(task: string, options: PiTaskOptions = {}): Promise<void> {
  const { tools = ['read', 'write', 'bash'], cwd = process.cwd(), onStderr } = options;

  // Write task to a temp file to avoid shell-escaping issues with long prompts.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-'));
  const taskFile = path.join(tmpDir, 'task.md');
  fs.writeFileSync(taskFile, `Task: ${task}`, 'utf-8');

  const args = [
    '--no-session',
    '--thinking', 'off',
    '--tools', tools.join(','),
    `@${taskFile}`,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('pi', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line && onStderr) onStderr(line);
    });

    proc.on('close', (code) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      if (code === 0) resolve();
      else reject(new Error(`pi task exited with code ${code}`));
    });

    proc.on('error', (err) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      reject(err);
    });
  });
}
