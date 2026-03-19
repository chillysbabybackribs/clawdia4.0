/**
 * Core Tool Executors — shell_exec, file_read, file_write, file_edit, directory_tree
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Streamed shell executor.
 * Fires onChunk with progressive stdout/stderr lines while the command runs.
 * Always returns the full accumulated output when the process exits.
 */
/**
 * Known GUI app binaries. If a command ends with "&" and starts with one
 * of these, we auto-wrap with setsid + stream redirect so shell_exec returns
 * instantly instead of hanging for 30s waiting for the GUI's stderr.
 */
const GUI_APP_BINARIES = new Set([
  'gimp', 'blender', 'inkscape', 'libreoffice', 'soffice', 'audacity', 'obs',
  'kdenlive', 'shotcut', 'vlc', 'spotify', 'firefox', 'chrome', 'chromium',
  'google-chrome', 'thunderbird', 'nautilus', 'thunar', 'dolphin', 'krita',
  'darktable', 'rawtherapee', 'openshot', 'pitivi', 'handbrake', 'steam',
  'telegram-desktop', 'signal-desktop', 'zoom', 'code', 'gedit', 'evince',
  'eog', 'totem', 'rhythmbox', 'transmission-gtk', 'qbittorrent',
]);

function autoDetachGuiCommand(command: string): string {
  const trimmed = command.trim();
  // Only auto-detach if the command ends with & (user intends to background it)
  if (!trimmed.endsWith('&')) return command;
  // Already properly detached
  if (trimmed.includes('setsid') || trimmed.includes('nohup') || trimmed.includes('>/dev/null')) return command;
  // Extract the binary name (first word before any flags or &)
  const binary = trimmed.replace(/\s*&\s*$/, '').split(/\s+/)[0].toLowerCase();
  if (GUI_APP_BINARIES.has(binary)) {
    const withoutAmp = trimmed.replace(/\s*&\s*$/, '');
    const detached = `setsid ${withoutAmp} >/dev/null 2>&1 &`;
    console.log(`[Shell] Auto-detached GUI launch: "${binary}" → "${detached}"`);
    return detached;
  }
  return command;
}

export async function executeShellExec(
  input: Record<string, any>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const { command, timeout = 30 } = input;
  const timeoutMs = Math.min(Number(timeout) || 30, 300) * 1000;

  // Auto-detach GUI app launches to prevent 30s hangs
  const finalCommand = autoDetachGuiCommand(command);

  return new Promise<string>((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let killed = false;

    const child = spawn('bash', ['-c', finalCommand], {
      cwd: os.homedir(),
      env: { ...process.env },
      // No shell: true — we already wrap in bash -c for cwd persistence
    });

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stdoutChunks.push(text);
      if (onChunk) onChunk(text);
    });

    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stderrChunks.push(text);
      // Stream stderr too — prefixed so the UI can distinguish
      if (onChunk) onChunk(`[stderr] ${text}`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = stdoutChunks.join('').trim();
      const stderr = stderrChunks.join('').trim();

      if (killed) {
        const partial = stdout || stderr || '';
        resolve(`[Exit SIGKILL — command timed out]\n${partial}`.trim());
        return;
      }

      if (code !== 0 && !stdout && !stderr) {
        resolve(`[Exit ${code}]`);
        return;
      }

      let result = '';
      if (stdout) result += stdout;
      if (stderr) result += (result ? '\n[stderr] ' : '[stderr] ') + stderr;
      if (code !== 0) result = `[Exit ${code}] ${result}`.trimEnd();
      resolve(result || '[No output]');
    });

    child.on('error', (err: any) => {
      clearTimeout(timer);
      resolve(`[Error] ${err.message}`);
    });
  });
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
