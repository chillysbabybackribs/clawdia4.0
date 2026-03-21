/**
 * Persistent Shell Executor
 *
 * shell_exec uses a PERSISTENT bash process that stays alive across calls.
 * This means `cd`, `export`, aliases, and shell state carry over between
 * tool calls — exactly as the tool description promises the LLM.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

// ═══════════════════════════════════
// Persistent Shell Process
// ═══════════════════════════════════

let shellProcess: ChildProcess | null = null;
let shellAlive = false;
let shellQueue: Promise<unknown> = Promise.resolve();

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

function resetShell(reason: string, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (shellProcess) {
    console.warn(`[Shell] Resetting persistent bash (${reason})`);
    shellProcess.kill(signal);
    shellProcess = null;
    shellAlive = false;
  }
}

/** Kill the persistent shell (call on app quit). */
export function destroyShell(): void {
  resetShell('destroyed');
}

function enqueueShellRun<T>(fn: () => Promise<T>): Promise<T> {
  const run = shellQueue.then(fn, fn);
  shellQueue = run.then(() => undefined, () => undefined);
  return run;
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
  return enqueueShellRun(() => executeShellExecSerial(input, onChunk));
}

async function executeShellExecSerial(
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
      shell.removeListener('exit', onShellExit);
      shell.removeListener('error', onShellError);
      shell.stdout!.removeListener('data', onStdout);
      shell.stderr!.removeListener('data', onStderr);
    };

    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      resetShell(`timeout after ${timeout}s`, 'SIGKILL');
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

    const onShellExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      cleanup();
      shellAlive = false;
      shellProcess = null;
      const partial = stdoutChunks.join('').trim() || stderrChunks.join('').trim();
      const reason = code !== null ? `Shell exited unexpectedly (code ${code})` : `Shell exited unexpectedly (${signal || 'unknown signal'})`;
      resolve(partial ? `${reason}\n${partial}` : reason);
    };

    const onShellError = (err: Error) => {
      if (done) return;
      cleanup();
      shellAlive = false;
      shellProcess = null;
      const partial = stdoutChunks.join('').trim() || stderrChunks.join('').trim();
      resolve(partial ? `[Shell error] ${err.message}\n${partial}` : `[Shell error] ${err.message}`);
    };

    shell.stdout!.on('data', onStdout);
    shell.stderr!.on('data', onStderr);
    shell.on('exit', onShellExit);
    shell.on('error', onShellError);

    // Write the command followed by a sentinel echo that includes the exit code.
    // The sentinel on stdout tells us the command is done and what its exit code was.
    try {
      shell.stdin!.write(`${finalCommand}\necho "${sentinel}:$?"\n`);
    } catch (err: any) {
      cleanup();
      resetShell('stdin write failure', 'SIGKILL');
      resolve(`[Shell write failed] ${err?.message || String(err)}`);
    }
  });
}

export const __testing = {
  resetState(): void {
    resetShell('test reset', 'SIGKILL');
    shellQueue = Promise.resolve();
  },
};
