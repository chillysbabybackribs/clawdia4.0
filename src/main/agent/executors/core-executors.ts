/**
 * Core Tool Executors — shell_exec, file_read, file_write, file_edit, directory_tree
 *
 * shell_exec uses a PERSISTENT bash process that stays alive across calls.
 * This means `cd`, `export`, aliases, and shell state carry over between
 * tool calls — exactly as the tool description promises the LLM.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

// ═══════════════════════════════════
// Persistent Shell Process
// ═══════════════════════════════════

let shellProcess: ChildProcess | null = null;
let shellAlive = false;

/** Generate a unique sentinel string to delimit command output. */
function makeSentinel(): string {
  return `__CLAWDIA_DONE_${randomBytes(6).toString('hex')}__`;
}

/** Spawn (or respawn) the persistent bash process. */
function ensureShell(): ChildProcess {
  if (shellProcess && shellAlive) return shellProcess;

  const shellCwd = path.join(os.homedir(), 'Desktop');
  console.log(`[Shell] Spawning persistent bash process (cwd: ${shellCwd})`);
  shellProcess = spawn('bash', ['--norc', '--noprofile', '-i'], {
    cwd: shellCwd,
    env: {
      ...process.env,
      // Disable prompt to avoid PS1 noise in output
      PS1: '',
      PS2: '',
      PROMPT_COMMAND: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  shellAlive = true;

  shellProcess.on('exit', (code) => {
    console.log(`[Shell] Persistent bash exited (code ${code}), will respawn on next call`);
    shellAlive = false;
    shellProcess = null;
  });

  shellProcess.on('error', (err) => {
    console.warn(`[Shell] Persistent bash error: ${err.message}`);
    shellAlive = false;
    shellProcess = null;
  });

  return shellProcess;
}

/** Kill the persistent shell (call on app quit). */
export function destroyShell(): void {
  if (shellProcess) {
    shellProcess.kill('SIGTERM');
    shellProcess = null;
    shellAlive = false;
    console.log('[Shell] Persistent bash destroyed');
  }
}

/**
 * Known GUI app binaries. If a command ends with "&" and starts with one
 * of these, we auto-wrap with setsid + stream redirect so shell_exec returns
 * instantly instead of hanging waiting for the GUI's stderr.
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
  if (!trimmed.endsWith('&')) return command;
  if (trimmed.includes('setsid') || trimmed.includes('nohup') || trimmed.includes('>/dev/null')) return command;
  const binary = trimmed.replace(/\s*&\s*$/, '').split(/\s+/)[0].toLowerCase();
  if (GUI_APP_BINARIES.has(binary)) {
    const withoutAmp = trimmed.replace(/\s*&\s*$/, '');
    const detached = `setsid ${withoutAmp} >/dev/null 2>&1 &`;
    console.log(`[Shell] Auto-detached GUI launch: "${binary}" → "${detached}"`);
    return detached;
  }
  return command;
}

/**
 * Execute a command in the persistent bash shell.
 *
 * CWD, exports, and aliases persist between calls. The command's stdout
 * and stderr are captured via unique sentinels written after the command
 * completes. This means `cd /project` in one call actually changes the
 * working directory for the next call.
 */
export async function executeShellExec(
  input: Record<string, any>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const { command, timeout = 30 } = input;
  const timeoutMs = Math.min(Number(timeout) || 30, 300) * 1000;

  const finalCommand = autoDetachGuiCommand(command);
  const sentinel = makeSentinel();

  const shell = ensureShell();
  if (!shell.stdin || !shell.stdout || !shell.stderr) {
    return '[Error] Shell process has no stdio';
  }

  return new Promise<string>((resolve) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let done = false;
    let exitCode = '0';

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      shell.stdout!.removeListener('data', onStdout);
      shell.stderr!.removeListener('data', onStderr);
    };

    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      // Send Ctrl+C to interrupt the running command, don't kill the shell
      shell.stdin!.write('\x03\n');
      const partial = stdoutChunks.join('').trim() || stderrChunks.join('').trim() || '';
      resolve(`[Timed out after ${timeout}s]\n${partial}`.trim());
    }, timeoutMs);

    const onStdout = (buf: Buffer) => {
      if (done) return;
      const text = buf.toString();

      // Check if this chunk contains our sentinel
      const sentinelIdx = text.indexOf(sentinel);
      if (sentinelIdx !== -1) {
        // Grab any output before the sentinel
        const before = text.slice(0, sentinelIdx);
        if (before) stdoutChunks.push(before);

        // Extract exit code from the line after sentinel: "SENTINEL:CODE"
        const afterSentinel = text.slice(sentinelIdx + sentinel.length);
        const codeMatch = afterSentinel.match(/:(\d+)/);
        if (codeMatch) exitCode = codeMatch[1];

        cleanup();

        const stdout = stdoutChunks.join('').trim();
        const stderr = stderrChunks.join('').trim();
        const code = parseInt(exitCode, 10);

        if (code !== 0 && !stdout && !stderr) {
          resolve(`[Exit ${code}]`);
          return;
        }

        let result = '';
        if (stdout) result += stdout;
        if (stderr) result += (result ? '\n[stderr] ' : '[stderr] ') + stderr;
        if (code !== 0) result = `[Exit ${code}] ${result}`.trimEnd();
        resolve(result || '[No output]');
        return;
      }

      stdoutChunks.push(text);
      if (onChunk) onChunk(text);
    };

    const onStderr = (buf: Buffer) => {
      if (done) return;
      const text = buf.toString();
      stderrChunks.push(text);
      if (onChunk) onChunk(`[stderr] ${text}`);
    };

    shell.stdout!.on('data', onStdout);
    shell.stderr!.on('data', onStderr);

    // Write the command followed by a sentinel echo that includes the exit code.
    // The sentinel on stdout tells us the command is done and what its exit code was.
    shell.stdin!.write(`${finalCommand}\necho "${sentinel}:$?"\n`);
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
