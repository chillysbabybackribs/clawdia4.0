/**
 * Core Tool Executors — shell_exec, file_read, file_write, file_edit, directory_tree
 */

import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function executeShellExec(input: Record<string, any>): Promise<string> {
  const { command, timeout = 30 } = input;
  const timeoutMs = Math.min(Number(timeout) || 30, 300) * 1000;

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutMs,
      cwd: os.homedir(),
      env: { ...process.env },
      maxBuffer: 1024 * 1024 * 5,
    });

    let result = '';
    if (stdout.trim()) result += stdout.trim();
    if (stderr.trim()) result += (result ? '\n[stderr] ' : '[stderr] ') + stderr.trim();
    return result || '[No output]';
  } catch (err: any) {
    const exitCode = err.code ?? err.status ?? 'unknown';
    const stderr = err.stderr?.trim() || '';
    const stdout = err.stdout?.trim() || '';
    let msg = `[Exit ${exitCode}]`;
    if (stderr) msg += ` ${stderr}`;
    if (stdout) msg += `\n${stdout}`;
    if (err.killed) msg += '\n[Hint: Command timed out]';
    return msg;
  }
}

export async function executeFileRead(input: Record<string, any>): Promise<string> {
  const { path: filePath, startLine, endLine } = input;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (startLine || endLine) {
      const lines = content.split('\n');
      const start = Math.max(1, startLine || 1) - 1;
      const end = Math.min(lines.length, endLine || lines.length);
      return lines.slice(start, end).join('\n');
    }
    if (content.length > 100_000) {
      return content.slice(0, 100_000) + `\n\n[Truncated — file is ${content.length} bytes. Use startLine/endLine.]`;
    }
    return content;
  } catch (err: any) {
    return `[Error reading ${filePath}]: ${err.message}`;
  }
}

export async function executeFileWrite(input: Record<string, any>): Promise<string> {
  const { path: filePath, content } = input;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `[Written ${content.length} bytes to ${filePath}]`;
  } catch (err: any) {
    return `[Error writing ${filePath}]: ${err.message}`;
  }
}

export async function executeFileEdit(input: Record<string, any>): Promise<string> {
  const { path: filePath, old_str, new_str } = input;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const occurrences = content.split(old_str).length - 1;
    if (occurrences === 0) return `[Error] old_str not found in ${filePath}. Read the file first.`;
    if (occurrences > 1) return `[Error] old_str appears ${occurrences} times. Must appear exactly once.`;
    fs.writeFileSync(filePath, content.replace(old_str, new_str), 'utf-8');
    return `[Edited ${filePath}]`;
  } catch (err: any) {
    return `[Error editing ${filePath}]: ${err.message}`;
  }
}

export async function executeDirectoryTree(input: Record<string, any>): Promise<string> {
  const { path: dirPath, depth = 3 } = input;
  const maxDepth = Math.min(Number(depth) || 3, 10);
  const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', '__pycache__', '.cache']);

  function walk(dir: string, currentDepth: number, prefix: string): string[] {
    if (currentDepth > maxDepth) return [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return [`${prefix}[permission denied]`]; }

    entries = entries
      .filter(e => !e.name.startsWith('.') && !IGNORE.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const lines: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        lines.push(...walk(path.join(dir, entry.name), currentDepth + 1, prefix + childPrefix));
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
    return lines;
  }

  try {
    return `${dirPath}/\n${walk(dirPath, 0, '').join('\n')}`;
  } catch (err: any) {
    return `[Error listing ${dirPath}]: ${err.message}`;
  }
}
