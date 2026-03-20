# Executor Layer Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `core-executors.ts` (1516 lines) and `desktop-executors.ts` (1508 lines) into focused domain modules without changing any external behavior, public API, or consumer import paths.

**Architecture:** Each original file becomes a thin re-export wrapper (`export * from './core'` / `export * from './desktop'`). All logic moves into new subfolders (`executors/core/` and `executors/desktop/`). External consumers (`tool-builder.ts`, `main.ts`, `loop-setup.ts`) are not touched.

**Tech Stack:** TypeScript, Node.js, Electron. No new dependencies. Validation via `npx tsc --noEmit` and `npm test`.

**Spec:** `docs/superpowers/specs/2026-03-20-executor-refactor-design.md`

---

## File Map

### Files to create

```
src/main/agent/executors/core/
  shell-executor.ts       Persistent shell process, sentinel parsing, GUI auto-detach, destroyShell/executeShellExec
  file-executors.ts       executeFileRead, executeFileWrite, executeFileEdit, executeDirectoryTree
  fs-planning.ts          executeFsFolderSummary, executeFsReorgPlan, executeFsDuplicateScan, executeFsApplyPlan
  fs-search.ts            executeFsQuoteLookup, PDF extraction, text indexing, semantic search
  index.ts                export * from all four modules above

src/main/agent/executors/desktop/
  shared.ts               run(), cmdExists(), wait(), toolCache, TIMEOUT, execAsync
  screenshot-analyzer.ts  getAnalyzerPath(), runScreenshotAnalyzer()
  gui-state.ts            guiState singleton, getGuiState, resetGuiStateForNewConversation, warmCoordinatesForApp
  smart-focus.ts          smartFocus()
  action-verify.ts        shouldVerifyAction(), postActionVerify(), createMacroTrace(), MacroTrace interface
  gui-primitives.ts       execPrimitiveAction() — list_windows through analyze_screenshot + screenshot_region
  gui-macros.ts           execMacroAction() — launch_and_focus, open_menu_path, fill_dialog, confirm_dialog, export_file, click_and_type
  a11y-actions.ts         execA11yAction() — a11y_get_tree through a11y_list_apps
  gui-executor.ts         executeGuiInteract(), batch_actions dispatcher
  app-control.ts          executeAppControl(), tryControlSurface(), guessDbusMethod()
  dbus-executor.ts        executeDbusControl()
  capabilities.ts         getCapabilityStatus(), getDesktopCapabilities(), DesktopCapabilityStatus
  index.ts                export * from all modules above
```

### Files to replace (thin wrappers)

```
src/main/agent/executors/core-executors.ts    Replace body with: export * from './core';
src/main/agent/executors/desktop-executors.ts Replace body with: export * from './desktop';
```

### Files NOT touched

```
src/main/agent/tool-builder.ts
src/main/main.ts
src/main/agent/loop-setup.ts
src/main/agent/executors/browser-executors.ts
src/main/agent/executors/extra-executors.ts
```

---

## Task 1: Create `core/shell-executor.ts`

Extract the persistent shell module from `core-executors.ts` lines 1–203.

**Files:**
- Create: `src/main/agent/executors/core/shell-executor.ts`

- [ ] **Step 1: Create the file**

```typescript
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
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/core/shell-executor.ts`
Expected: file listed

---

## Task 2: Create `core/file-executors.ts`

Extract the four direct file tools from `core-executors.ts` lines 205–289.

**Files:**
- Create: `src/main/agent/executors/core/file-executors.ts`

- [ ] **Step 1: Create the file**

```typescript
import * as fs from 'fs';
import * as path from 'path';

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
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/core/file-executors.ts`
Expected: file listed

---

## Task 3: Create `core/fs-planning.ts`

Extract the filesystem planning tools from `core-executors.ts` lines 291–1021. This includes `executeFsFolderSummary`, `executeFsReorgPlan`, `executeFsDuplicateScan`, `executeFsApplyPlan`, and all their supporting constants and helpers.

**Files:**
- Create: `src/main/agent/executors/core/fs-planning.ts`

- [ ] **Step 1: Create the file**

Copy lines 291–1021 from `src/main/agent/executors/core-executors.ts` verbatim, then add the necessary imports at the top:

```typescript
import * as fs from 'fs';
import * as path from 'path';
```

The constant `FS_QUOTE_IGNORE` (currently defined at line 1023 of the original file) is also needed here. Define it at the top of this file, before the functions that use it:

```typescript
const FS_QUOTE_IGNORE = new Set(['node_modules', '.git', '.next', 'dist', '__pycache__', '.cache']);
```

The file should export: `executeFsFolderSummary`, `executeFsReorgPlan`, `executeFsDuplicateScan`, `executeFsApplyPlan`.

All other functions and constants in this file are internal helpers — do not add `export` to them.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: no errors referencing `fs-planning.ts`

---

## Task 4: Create `core/fs-search.ts`

Extract the filesystem search/quote tools from `core-executors.ts` lines 1023–1516. This includes `executeFsQuoteLookup`, PDF extraction, text indexing, semantic search, and all their supporting code.

**Files:**
- Create: `src/main/agent/executors/core/fs-search.ts`

- [ ] **Step 1: Create the file**

Copy lines 1023–1516 from `src/main/agent/executors/core-executors.ts` verbatim, then add the necessary imports at the top:

```typescript
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  getFilesystemExtraction,
  pruneFilesystemExtractions,
  searchFilesystemExtractions,
  upsertFilesystemExtraction,
} from '../../../db/filesystem-extractions';
```

The only export from this file is `executeFsQuoteLookup`. All other declarations (`FS_QUOTE_IGNORE`, `FS_TEXT_EXTENSIONS`, `extractedTextCache`, `pdftotextAvailable`, `extractionWritesSincePrune`, and all helper functions) are internal — no `export` prefix.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: no errors referencing `fs-search.ts`

---

## Task 5: Create `core/index.ts` and update `core-executors.ts`

Wire up the core submodule and replace the original file with a thin wrapper.

**Files:**
- Create: `src/main/agent/executors/core/index.ts`
- Modify: `src/main/agent/executors/core-executors.ts`

- [ ] **Step 1: Create `core/index.ts`**

```typescript
export * from './shell-executor';
export * from './file-executors';
export * from './fs-planning';
export * from './fs-search';
```

- [ ] **Step 2: Replace `core-executors.ts` body**

Replace the entire content of `src/main/agent/executors/core-executors.ts` with:

```typescript
/**
 * Core Tool Executors — re-export entrypoint.
 * All logic lives in ./core/ submodules.
 */
export * from './core';
```

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -40`
Expected: zero errors

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -20`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/executors/core/ src/main/agent/executors/core-executors.ts
git commit -m "refactor: split core-executors into domain submodules"
```

---

## Task 6: Create `desktop/shared.ts`

Extract the shared utilities used by all desktop modules.

**Files:**
- Create: `src/main/agent/executors/desktop/shared.ts`

- [ ] **Step 1: Create the file**

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

export const execAsync = promisify(exec);
export const TIMEOUT = 30_000;

export async function run(command: string, timeout = TIMEOUT): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      cwd: os.homedir(),
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
      maxBuffer: 1024 * 1024 * 2,
    });
    let result = stdout.trim();
    if (stderr.trim()) result += (result ? '\n[stderr] ' : '[stderr] ') + stderr.trim();
    return result || '[No output]';
  } catch (err: any) {
    const out = err.stdout?.trim() || '';
    const se = err.stderr?.trim() || '';
    return `[Error] ${se || out || err.message}`;
  }
}

const toolCache: Record<string, boolean> = {};
export async function cmdExists(cmd: string): Promise<boolean> {
  if (cmd in toolCache) return toolCache[cmd];
  try { await execAsync(`which ${cmd} 2>/dev/null`); toolCache[cmd] = true; }
  catch { toolCache[cmd] = false; }
  return toolCache[cmd];
}

export function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/shared.ts`
Expected: file listed

---

## Task 7: Create `desktop/screenshot-analyzer.ts`

Extract OCR/analyzer helpers from `desktop-executors.ts` lines 108–194.

**Files:**
- Create: `src/main/agent/executors/desktop/screenshot-analyzer.ts`

- [ ] **Step 1: Create the file**

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execAsync } from './shared';

/** Resolve path to screenshot-analyzer.py (works in dev + packaged builds). */
export function getAnalyzerPath(): string {
  // Packaged: electron-builder copies .py files to resources/gui/ via extraResources
  const resourcePath = path.join(process.resourcesPath, 'gui', 'screenshot-analyzer.py');
  if (fs.existsSync(resourcePath)) return resourcePath;
  // Dev: __dirname is dist/main/agent/executors/desktop — traverse up to project root, then into src
  const projectRoot = path.join(__dirname, '..', '..', '..', '..', '..');
  const srcPath = path.join(projectRoot, 'src', 'main', 'agent', 'gui', 'screenshot-analyzer.py');
  if (fs.existsSync(srcPath)) return srcPath;
  // Final fallback alongside dist
  return path.join(__dirname, '..', '..', 'gui', 'screenshot-analyzer.py');
}

/** Run the screenshot analyzer and return parsed JSON or null. */
export async function runScreenshotAnalyzer(
  imagePath: string,
  opts: { title?: string; region?: string } = {},
): Promise<{ summary: string; targets: Array<{ label: string; x: number; y: number }> } | null> {
  const analyzerPath = getAnalyzerPath();
  let cmd = `python3 "${analyzerPath}" --file "${imagePath}"`;
  if (opts.title) cmd += ` --title "${opts.title}"`;
  if (opts.region) cmd += ` --region ${opts.region}`;

  // Use execAsync directly instead of run() to keep stdout and stderr separate.
  // The analyzer writes JSON to stdout and diagnostics to stderr.
  // run() merges them, which breaks JSON.parse().
  let stdout: string;
  try {
    const result = await execAsync(cmd, {
      timeout: 15_000,
      cwd: os.homedir(),
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
      maxBuffer: 1024 * 1024 * 2,
    });
    stdout = result.stdout.trim();
    if (result.stderr.trim()) {
      console.log(`[Desktop] OCR analyzer: ${result.stderr.trim()}`);
    }
  } catch (err: any) {
    console.warn(`[Desktop] Screenshot analyzer failed: ${err.message}`);
    return null;
  }

  if (!stdout || stdout.startsWith('[Error]')) {
    console.warn(`[Desktop] Screenshot analyzer returned no output`);
    return null;
  }

  try {
    const parsed = JSON.parse(stdout);
    if (parsed.error) {
      console.warn(`[Desktop] Screenshot analyzer error: ${parsed.error}`);
      return null;
    }

    // Build compact summary from JSON fields
    const lines: string[] = [];
    if (parsed.window) lines.push(`Window: ${parsed.window}`);
    if (parsed.size) lines.push(`Size: ${parsed.size}`);
    if (parsed.menu) lines.push(`Menu: ${parsed.menu}`);
    if (parsed.dialog) {
      const d = parsed.dialog;
      lines.push(`⚠ DIALOG at (${d.region.join(',')})`);
      if (d.text) lines.push(`Dialog text: ${d.text.slice(0, 200)}`);
    }
    if (parsed.targets?.length > 0) {
      lines.push('Click targets:');
      for (const t of parsed.targets) {
        lines.push(`  "${t.label}" at (${t.x}, ${t.y})`);
      }
    }
    if (parsed.text) {
      // Include OCR text but cap it
      const textPreview = parsed.text.split('\n').slice(0, 15).join('\n');
      lines.push(`OCR text:\n${textPreview}`);
    }
    if (parsed.tokens_est) lines.push(`[~${parsed.tokens_est} tokens]`);

    return {
      summary: lines.join('\n'),
      targets: parsed.targets || [],
    };
  } catch (e) {
    console.warn(`[Desktop] Failed to parse analyzer output: ${stdout.slice(0, 200)}`);
    return null;
  }
}
```

**Important:** The `__dirname` path in `getAnalyzerPath()` must account for the new subdirectory depth. In the original file `__dirname` is `dist/main/agent/executors`. In the new file it will be `dist/main/agent/executors/desktop` — one level deeper. The path traversal `path.join(__dirname, '..', '..', '..', '..')` in the original becomes `path.join(__dirname, '..', '..', '..', '..', '..')` in the new file (5 levels up instead of 4). The fallback also changes from `path.join(__dirname, '..', 'gui', ...)` to `path.join(__dirname, '..', '..', 'gui', ...)`. Both are corrected in the code above.

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/screenshot-analyzer.ts`
Expected: file listed

---

## Task 8: Create `desktop/gui-state.ts`

Extract the GUI state singleton and its exported management functions from `desktop-executors.ts` lines 196–225.

**Files:**
- Create: `src/main/agent/executors/desktop/gui-state.ts`

- [ ] **Step 1: Create the file**

```typescript
import {
  type UIState,
  createUIState,
  resetUIState,
} from '../../gui/ui-state';
import {
  pruneCoordinateCache,
  warmUIStateFromCache,
} from '../../../db/coordinate-cache';

// ═══════════════════════════════════
// GUI State — Module-level singleton per conversation
// ═══════════════════════════════════

export let guiState: UIState = createUIState();

/** Get current GUI state (read-only snapshot for prompt injection). */
export function getGuiState(): UIState {
  return guiState;
}

/** Reset GUI state (call on new conversation). Prunes coordinate cache once. */
export function resetGuiStateForNewConversation(): void {
  resetUIState(guiState);
  console.log('[Desktop] GUI state reset for new conversation');
  // Lazy maintenance — runs in background, non-blocking
  setImmediate(() => { try { pruneCoordinateCache(); } catch {} });
}

/**
 * Warm the in-memory knownTargets from the persistent coordinate cache
 * for a specific app. Called by the agent loop when an app context is detected.
 */
export function warmCoordinatesForApp(app: string, windowKey = ''): void {
  const loaded = warmUIStateFromCache(guiState.knownTargets, app, windowKey);
  if (loaded > 0) {
    guiState.confidence = Math.max(guiState.confidence, 0.45);
    console.log(`[Desktop] Pre-loaded ${loaded} cached coordinate(s) for "${app}"`);
  }
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/gui-state.ts`
Expected: file listed

---

## Task 9: Create `desktop/smart-focus.ts`

Extract `smartFocus()` from `desktop-executors.ts` lines 233–303.

**Files:**
- Create: `src/main/agent/executors/desktop/smart-focus.ts`

- [ ] **Step 1: Create the file**

```typescript
import { getDb } from '../../../db/database';
import {
  loadPersistedTargets,
  isWindowFocused,
  recordFocus,
  recordError,
  recordSkippedFocus,
} from '../../gui/ui-state';
import { run, cmdExists, wait } from './shared';
import { guiState } from './gui-state';

/**
 * Focus a window, but SKIP if the state says it's already focused.
 * On first focus of a known app+window, loads persisted coordinates from the
 * coordinate cache so the LLM can immediately use remembered targets.
 * Returns true if focus was actually performed, false if skipped.
 */
export async function smartFocus(winName: string): Promise<{ focused: boolean; skipped: boolean }> {
  if (isWindowFocused(guiState, winName)) {
    recordSkippedFocus(guiState);
    console.log(`[Desktop] Skipped redundant focus for "${winName}" (state: focused, confidence: ${(guiState.confidence * 100).toFixed(0)}%)`);
    return { focused: true, skipped: true };
  }

  if (await cmdExists('wmctrl')) {
    await run(`wmctrl -a "${winName}" 2>&1`);
  } else if (await cmdExists('xdotool')) {
    const wid = await run(`xdotool search --name "${winName}" | head -1`);
    if (wid && !wid.startsWith('[Error]')) {
      await run(`xdotool windowactivate ${wid.trim()}`);
    }
  }

  // ── Verify focus actually succeeded ──
  // wmctrl -a can silently fail (window name mismatch, minimized, wrong workspace).
  // Without this check, typing/clicking would go to whatever window IS focused.
  if (await cmdExists('xdotool')) {
    await wait(50); // Brief settle for window manager
    const activeTitle = await run('xdotool getactivewindow getwindowname 2>/dev/null');
    if (!activeTitle.startsWith('[Error]') && !activeTitle.startsWith('[No output]')) {
      const actual = activeTitle.trim().toLowerCase();
      const expected = winName.toLowerCase();
      // Check for substring match (either direction) — window titles often have prefixes/suffixes
      if (!actual.includes(expected) && !expected.includes(actual)) {
        // Also check app name match ("gimp" matches "*Untitled – GNU Image Manipulation Program")
        const appPatterns: Record<string, RegExp> = {
          gimp: /gimp|gnu image/i, libreoffice: /libreoffice|soffice/i,
          blender: /blender/i, inkscape: /inkscape/i, audacity: /audacity/i,
        };
        const appMatch = Object.entries(appPatterns).some(
          ([app, re]) => expected.includes(app) && re.test(actual)
        );
        if (!appMatch) {
          console.warn(`[Desktop] Focus verification FAILED: wanted "${winName}" but active is "${activeTitle.trim()}"`);
          recordError(guiState, 'focus', winName);
          return { focused: false, skipped: false };
        }
      }
    }
  }

  recordFocus(guiState, winName, '');

  // ── Load persisted coordinates from cross-session cache ──
  const app = guiState.focusedWindow?.app || 'unknown';
  if (app !== 'unknown') {
    try {
      const rows = getDb().prepare(`
        SELECT element, x, y, confidence FROM coordinate_cache
        WHERE app = ? AND window_key = ?
          AND confidence >= 0.3
        ORDER BY hit_count DESC LIMIT 20
      `).all(
        app.toLowerCase().replace(/[^a-z0-9]/g, ''),
        winName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().slice(0, 60),
      ) as Array<{ element: string; x: number; y: number; confidence: number }>;

      if (rows.length > 0) {
        loadPersistedTargets(guiState, rows);
        console.log(`[CoordCache] Loaded ${rows.length} persisted targets for "${app}" → "${winName}"`);
      }
    } catch (e) {
      // Non-fatal — proceed without cached targets
    }
  }

  return { focused: true, skipped: false };
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/smart-focus.ts`
Expected: file listed

---

## Task 10: Create `desktop/action-verify.ts`

Extract `shouldVerifyAction`, `postActionVerify`, `createMacroTrace`, and `MacroTrace` from `desktop-executors.ts` lines 462–619.

**Files:**
- Create: `src/main/agent/executors/desktop/action-verify.ts`

- [ ] **Step 1: Create the file**

```typescript
import {
  cacheTarget,
  recordScreenshot,
} from '../../gui/ui-state';
import {
  storeCoordinate,
} from '../../../db/coordinate-cache';
import { run, cmdExists, wait } from './shared';
import { guiState } from './gui-state';
import { runScreenshotAnalyzer } from './screenshot-analyzer';

// ═══════════════════════════════════
// Macro Step Tracing
// ═══════════════════════════════════

export interface MacroTrace {
  macro: string;
  steps: { step: number; action: string; detail: string; result: 'ok' | 'skip' | 'fail'; durationMs: number }[];
  totalMs: number;
}

export function createMacroTrace(name: string): { trace: MacroTrace; step: (action: string, detail: string, fn: () => Promise<string>) => Promise<string>; finish: () => string } {
  const trace: MacroTrace = { macro: name, steps: [], totalMs: 0 };
  const macroStart = Date.now();

  const step = async (action: string, detail: string, fn: () => Promise<string>): Promise<string> => {
    const stepStart = Date.now();
    const stepNum = trace.steps.length + 1;
    console.log(`[Macro] ${name} → step ${stepNum}: ${action}(${detail.slice(0, 60)})`);

    let result: string;
    try {
      result = await fn();
    } catch (err: any) {
      result = `[Error] ${err.message}`;
    }

    const durationMs = Date.now() - stepStart;
    const status = result.startsWith('[Error') ? 'fail' : (result.includes('[cached') || result.includes('Skipped') ? 'skip' : 'ok');
    trace.steps.push({ step: stepNum, action, detail: detail.slice(0, 80), result: status, durationMs });
    console.log(`[Macro]   → ${status} (${durationMs}ms): ${result.slice(0, 100)}`);

    return result;
  };

  const finish = (): string => {
    trace.totalMs = Date.now() - macroStart;
    const stepLines = trace.steps.map(s =>
      `  → ${s.action}(${s.detail}) [${s.result}] ${s.durationMs}ms`
    ).join('\n');
    const summary = `[Macro] ${name} (${trace.steps.length} steps, ${trace.totalMs}ms)\n${stepLines}`;
    console.log(summary);
    return summary;
  };

  return { trace, step, finish };
}

// ═══════════════════════════════════
// Conditional Post-Click Verification
// ═══════════════════════════════════

/** Labels whose clicks are likely to change window/dialog state. */
const HIGH_RISK_LABEL_RE = /\b(menu|file|edit|view|image|layer|filters?|tools?|windows?|help|save|export|open|new|import|ok|cancel|apply|close|yes|no|delete|confirm|submit|accept|create|next|back|finish|preferences|settings|dialog|print|undo|redo)\b/i;

/** Keyboard shortcuts that are likely to open dialogs or menus. */
const HIGH_RISK_KEY_RE = /^(ctrl\+[nospeqwz]|alt\+f|ctrl\+shift\+[es]|F[0-9]+|Return|Escape)$/i;

/**
 * Decide whether a click or key action warrants post-action OCR verification.
 *
 * Triggers on:
 *   1. Click lands on a known target whose label matches a state-change pattern
 *   2. Confidence is low (< 0.5) — early in the interaction, we need feedback
 *   3. The LLM explicitly requested verification via input.verify = true
 *   4. Key combo that likely opens a dialog/menu (Ctrl+N, Ctrl+S, Alt+F, etc.)
 *
 * Skips when:
 *   - tesseract is not installed
 *   - the click has no named target and confidence is high (canvas/drawing clicks)
 *   - the LLM explicitly set verify = false
 */
export function shouldVerifyAction(
  action: string,
  input: Record<string, any>,
  x?: number,
  y?: number,
): boolean {
  // Explicit LLM opt-in/opt-out
  if (input.verify === true) return true;
  if (input.verify === false) return false;

  if (action === 'key' && input.text) {
    return HIGH_RISK_KEY_RE.test(input.text);
  }

  if (action !== 'click') return false;
  if (x == null || y == null) return false;

  // Low confidence — we need to see what happened
  if (guiState.confidence < 0.5) return true;

  // Check if the click targeted a named element with a risky label
  const hitTarget = Object.entries(guiState.knownTargets)
    .find(([, t]) => t.x === x && t.y === y);
  if (hitTarget) {
    const [label] = hitTarget;
    if (HIGH_RISK_LABEL_RE.test(label)) return true;
  }

  // For clicks at coordinates near the top of the window (menu bar area, y < 80),
  // assume menu interaction — these almost always change state
  if (y < 80) return true;

  return false;
}

/**
 * Run a lightweight post-action OCR check.
 * Returns a compact state summary string to append to the action result,
 * or empty string if OCR is unavailable or fails.
 * Updates guiState with any newly discovered targets.
 */
export async function postActionVerify(windowTitle?: string): Promise<string> {
  if (!await cmdExists('tesseract') || !await cmdExists('scrot')) return '';

  const filename = `/tmp/clawdia-verify-${Date.now()}.png`;
  const captureWindow = windowTitle || guiState.focusedWindow?.title;

  if (captureWindow) {
    // Focused window capture is faster and cleaner than full screen
    await wait(300); // Brief settle time after the click
    await run(`scrot -u ${filename}`);
  } else {
    await wait(300);
    await run(`scrot ${filename}`);
  }

  const analysis = await runScreenshotAnalyzer(filename, { title: captureWindow || '' });
  if (!analysis) return '';

  // Cache any new targets discovered
  for (const t of analysis.targets) {
    cacheTarget(guiState, t.label, t.x, t.y);
    if (guiState.activeApp && captureWindow) {
      storeCoordinate(guiState.activeApp, captureWindow, t.label, t.x, t.y, guiState.confidence);
    }
  }

  recordScreenshot(guiState);
  console.log(`[Desktop] Post-action verify: ${analysis.targets.length} targets, dialog=${analysis.summary.includes('DIALOG')}`);

  // Return compact summary (not the full OCR text — keep it concise)
  const lines: string[] = ['[Post-action state]'];
  if (analysis.summary.includes('DIALOG')) {
    // Dialog detected — include full dialog info, this is critical
    const dialogLines = analysis.summary.split('\n').filter(l => l.includes('DIALOG') || l.includes('Dialog'));
    lines.push(...dialogLines);
  }
  if (analysis.targets.length > 0) {
    lines.push(`Visible targets: ${analysis.targets.map(t => `"${t.label}"`).slice(0, 8).join(', ')}`);
  }
  // Include window title if it changed (menu opened, dialog appeared)
  const windowLine = analysis.summary.split('\n').find(l => l.startsWith('Window:'));
  if (windowLine) lines.push(windowLine);

  return lines.join('\n');
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/action-verify.ts`
Expected: file listed

---

## Task 11: Create `desktop/gui-primitives.ts`

Extract primitive GUI action cases from `execSingleAction` in `desktop-executors.ts` lines 631–797 and 1194–1210 (`screenshot_region`). The function signature changes from returning `string` (switch arm) to `Promise<string | null>` (returns `null` for unowned actions).

**Files:**
- Create: `src/main/agent/executors/desktop/gui-primitives.ts`

- [ ] **Step 1: Create the file**

```typescript
import * as os from 'os';
import {
  cacheTarget,
  recordFocus,
  recordSuccess,
  recordError,
  recordScreenshot,
} from '../../gui/ui-state';
import {
  storeCoordinate,
  invalidateCoordinate,
} from '../../../db/coordinate-cache';
import { run, cmdExists, wait } from './shared';
import { guiState } from './gui-state';
import { smartFocus } from './smart-focus';
import { shouldVerifyAction, postActionVerify } from './action-verify';
import { runScreenshotAnalyzer } from './screenshot-analyzer';

/**
 * Handle primitive GUI actions.
 * Returns null for any action this handler does not own (dispatcher falls through).
 */
export async function execPrimitiveAction(
  input: Record<string, any>,
  batchWindow?: string,
): Promise<string | null> {
  const { action, window: winName, x, y, text, delay: inputDelay } = input;
  const delayMs = inputDelay || 0;
  const effectiveWindow = winName || batchWindow;

  switch (action) {
    case 'list_windows': {
      if (!await cmdExists('wmctrl')) return '[Error] wmctrl not installed. Run: sudo apt install wmctrl';
      return await run('wmctrl -l -p');
    }

    case 'find_window': {
      if (!effectiveWindow) return '[Error] window name required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      const ids = await run(`xdotool search --name "${effectiveWindow}" 2>/dev/null`);
      if (ids.startsWith('[Error]') || ids === '[No output]') return `No windows matching "${effectiveWindow}".`;
      const wids = ids.split('\n').filter(Boolean).slice(0, 5);
      const details: string[] = [];
      for (const wid of wids) {
        details.push(`  ${wid}: ${await run(`xdotool getwindowname ${wid} 2>/dev/null`)}`);
      }
      return `Found ${wids.length} window(s):\n${details.join('\n')}`;
    }

    case 'focus': {
      if (!effectiveWindow) return '[Error] window name required.';
      const { skipped } = await smartFocus(effectiveWindow);
      if (delayMs) await wait(delayMs);
      return skipped
        ? `Focused: "${effectiveWindow}" [cached — already focused]`
        : `Focused: "${effectiveWindow}"`;
    }

    case 'click': {
      if (x == null || y == null) return '[Error] x and y coordinates required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (effectiveWindow) {
        const { focused, skipped } = await smartFocus(effectiveWindow);
        if (!focused) return `[Error] Could not focus "${effectiveWindow}" — aborting click to prevent interaction with wrong window.`;
        if (!skipped) await wait(100);
      }
      if (delayMs) await wait(delayMs);
      const clickResult = await run(`xdotool mousemove ${x} ${y} click 1`);
      if (clickResult.startsWith('[Error]')) {
        if (effectiveWindow && guiState.activeApp) {
          const hitTarget = Object.entries(guiState.knownTargets)
            .find(([, t]) => t.x === x && t.y === y);
          if (hitTarget) invalidateCoordinate(guiState.activeApp, effectiveWindow, hitTarget[0]);
        }
        recordError(guiState, 'click', `(${x},${y})`);
        return clickResult;
      }
      recordSuccess(guiState, 'click', `(${x},${y})`);
      if (effectiveWindow && guiState.activeApp) {
        const hitTarget = Object.entries(guiState.knownTargets)
          .find(([, t]) => t.x === x && t.y === y);
        if (hitTarget) {
          storeCoordinate(guiState.activeApp, effectiveWindow, hitTarget[0], x, y, guiState.confidence);
        }
      }
      let verifyBlock = '';
      if (shouldVerifyAction('click', input, x, y)) {
        verifyBlock = await postActionVerify(effectiveWindow);
      }
      return `Clicked (${x}, ${y})${verifyBlock ? '\n' + verifyBlock : ''}`;
    }

    case 'type': {
      if (!text) return '[Error] text required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (effectiveWindow) {
        const { focused, skipped } = await smartFocus(effectiveWindow);
        if (!focused) return `[Error] Could not focus "${effectiveWindow}" — aborting type to prevent text entry into wrong window.`;
        if (!skipped) await wait(100);
      }
      if (delayMs) await wait(delayMs);
      await run(`xdotool type --delay 15 -- "${text.replace(/"/g, '\\"')}"`);
      recordSuccess(guiState, 'type', text.slice(0, 30));
      return `Typed "${text.slice(0, 50)}"`;
    }

    case 'key': {
      if (!text) return '[Error] key combo required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (effectiveWindow) {
        const { focused, skipped } = await smartFocus(effectiveWindow);
        if (!focused) return `[Error] Could not focus "${effectiveWindow}" — aborting key press to prevent interaction with wrong window.`;
        if (!skipped) await wait(100);
      }
      if (delayMs) await wait(delayMs);
      await run(`xdotool key ${text}`);
      recordSuccess(guiState, 'key', text);
      let keyVerifyBlock = '';
      if (shouldVerifyAction('key', input)) {
        keyVerifyBlock = await postActionVerify(effectiveWindow);
      }
      return `Key: ${text}${keyVerifyBlock ? '\n' + keyVerifyBlock : ''}`;
    }

    case 'screenshot': {
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (effectiveWindow) { await run(`wmctrl -a "${effectiveWindow}" 2>/dev/null`); await wait(200); }
      if (delayMs) await wait(delayMs);
      if (await cmdExists('scrot')) { await run(`scrot ${effectiveWindow ? '-u ' : ''}${filename}`); }
      else if (await cmdExists('gnome-screenshot')) { await run(`gnome-screenshot -f ${filename}`); }
      else if (await cmdExists('import')) { await run(`import -window root ${filename}`); }
      else { return '[Error] No screenshot tool. Install: sudo apt install scrot'; }
      recordScreenshot(guiState);
      if (effectiveWindow) recordFocus(guiState, effectiveWindow, '');
      return `[Screenshot: ${filename}]`;
    }

    case 'screenshot_and_focus': {
      if (!effectiveWindow) return '[Error] window name required.';
      await smartFocus(effectiveWindow);
      await wait(250);
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (await cmdExists('scrot')) { await run(`scrot -u ${filename}`); }
      else if (await cmdExists('gnome-screenshot')) { await run(`gnome-screenshot -f ${filename}`); }
      else { return `Focused: "${effectiveWindow}" [No screenshot tool]`; }
      recordScreenshot(guiState);
      const windows = await run('wmctrl -l 2>/dev/null');
      let ocrBlock = '';
      if (await cmdExists('tesseract')) {
        const analysis = await runScreenshotAnalyzer(filename, { title: effectiveWindow });
        if (analysis) {
          ocrBlock = '\n\n[OCR Analysis]\n' + analysis.summary;
          for (const t of analysis.targets) {
            cacheTarget(guiState, t.label, t.x, t.y);
          }
          console.log(`[Desktop] OCR: ${analysis.targets.length} click targets cached`);
        }
      }
      return `Focused: "${effectiveWindow}"\n[Screenshot: ${filename}]${ocrBlock}\n\nOpen windows:\n${windows}`;
    }

    case 'wait':
    case 'delay': {
      const waitMs = inputDelay || (input.ms as number) || 500;
      await wait(waitMs);
      return `Waited ${waitMs}ms`;
    }

    case 'verify_window_title': {
      const title = await run('xdotool getactivewindow getwindowname 2>/dev/null');
      if (title.startsWith('[Error]')) return title;
      const trimmed = title.trim();
      if (trimmed) recordFocus(guiState, trimmed, '');
      return `Active window: "${trimmed}"`;
    }

    case 'verify_file_exists': {
      const filePath = input.path || text;
      if (!filePath) return '[Error] path or text (filepath) required.';
      const stat = await run(`stat --printf="%s bytes, modified %y" "${filePath}" 2>/dev/null`);
      if (stat.startsWith('[Error]')) return `File not found: ${filePath}`;
      return `File exists: ${filePath} (${stat})`;
    }

    case 'analyze_screenshot': {
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      let analyzeWindow = effectiveWindow;
      if (!analyzeWindow && guiState.focusedWindow) {
        analyzeWindow = guiState.focusedWindow.title;
        console.log(`[Desktop] analyze_screenshot: auto-using focused window "${analyzeWindow}"`);
      }
      if (analyzeWindow) {
        await smartFocus(analyzeWindow);
        await wait(250);
      }
      if (await cmdExists('scrot')) {
        await run(`scrot ${analyzeWindow ? '-u ' : ''}${filename}`);
      } else {
        return '[Error] No screenshot tool installed. Run: sudo apt install scrot';
      }
      recordScreenshot(guiState);
      if (!await cmdExists('tesseract')) {
        return `[Screenshot: ${filename}]\n[Warning] tesseract not installed — OCR unavailable. Run: sudo apt install tesseract-ocr`;
      }
      const analysis = await runScreenshotAnalyzer(filename, { title: analyzeWindow || '' });
      if (!analysis) {
        return `[Screenshot: ${filename}]\n[OCR analysis failed — raw screenshot available at path above]`;
      }
      for (const t of analysis.targets) {
        cacheTarget(guiState, t.label, t.x, t.y);
        if (guiState.activeApp) {
          storeCoordinate(guiState.activeApp, analyzeWindow || '', t.label, t.x, t.y, guiState.confidence);
        }
      }
      if (analysis.targets.length > 0) {
        console.log(`[Desktop] OCR: ${analysis.targets.length} click targets cached (memory + SQLite)`);
      }
      return `[Screenshot: ${filename}]\n\n${analysis.summary}`;
    }

    case 'screenshot_region': {
      const { rx, ry, rw, rh } = input;
      if (rx == null || ry == null || rw == null || rh == null) {
        return '[Error] screenshot_region requires rx, ry, rw, rh (region x, y, width, height).';
      }
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;
      if (await cmdExists('scrot')) {
        await run(`scrot -a ${rx},${ry},${rw},${rh} ${filename}`);
      } else if (await cmdExists('import')) {
        await run(`import -window root -crop ${rw}x${rh}+${rx}+${ry} ${filename}`);
      } else {
        return '[Error] No region screenshot tool. Install: sudo apt install scrot';
      }
      recordScreenshot(guiState);
      return `[Screenshot: ${filename}] (region: ${rw}x${rh} at ${rx},${ry})`;
    }

    default:
      return null;
  }
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/gui-primitives.ts`
Expected: file listed

---

## Task 12: Create `desktop/gui-macros.ts`

Extract macro action cases from `execSingleAction` in `desktop-executors.ts` lines 859–1192.

**Files:**
- Create: `src/main/agent/executors/desktop/gui-macros.ts`

- [ ] **Step 1: Create the file**

```typescript
import * as os from 'os';
import {
  cacheTarget,
  recordSuccess,
  recordError,
  recordScreenshot,
} from '../../gui/ui-state';
import {
  storeCoordinate,
} from '../../../db/coordinate-cache';
import { run, cmdExists, wait } from './shared';
import { guiState } from './gui-state';
import { smartFocus } from './smart-focus';
import { postActionVerify, createMacroTrace } from './action-verify';
import { runScreenshotAnalyzer } from './screenshot-analyzer';

/**
 * Handle macro (composite) GUI actions.
 * Returns null for any action this handler does not own.
 */
export async function execMacroAction(
  input: Record<string, any>,
  batchWindow?: string,
): Promise<string | null> {
  const { action, window: winName, x, y, text, delay: inputDelay } = input;
  const delayMs = inputDelay || 0;
  const effectiveWindow = winName || batchWindow;

  switch (action) {
    case 'launch_and_focus': {
      const appBinary = input.app || text;
      if (!appBinary) return '[Error] launch_and_focus requires "app" (binary name) or "text".';
      const windowMatch = effectiveWindow || appBinary;
      const m = createMacroTrace(`launch_and_focus("${appBinary}")`);

      const launchResult = await m.step('launch', appBinary, async () => {
        await run(`setsid ${appBinary} >/dev/null 2>&1 &`);
        return `Launched ${appBinary} in background`;
      });

      const waitResult = await m.step('wait_for_window', windowMatch, async () => {
        const launchStart = Date.now();
        while (Date.now() - launchStart < 10_000) {
          await wait(500);
          const windows = await run('wmctrl -l 2>/dev/null');
          if (new RegExp(windowMatch, 'i').test(windows)) {
            return `Window "${windowMatch}" appeared after ${Date.now() - launchStart}ms`;
          }
        }
        return `[Error] No window matching "${windowMatch}" appeared within 10s`;
      });
      if (waitResult.startsWith('[Error')) {
        return `${m.finish()}\n${waitResult}. Use list_windows to check.`;
      }

      await m.step('focus', windowMatch, async () => {
        await smartFocus(windowMatch);
        await wait(500);
        return `Focused "${windowMatch}"`;
      });

      let ocrResult = '';
      if (await cmdExists('tesseract') && await cmdExists('scrot')) {
        ocrResult = await m.step('ocr_capture', windowMatch, async () => {
          const filename = `/tmp/clawdia-launch-${Date.now()}.png`;
          await run(`scrot -u ${filename}`);
          recordScreenshot(guiState);
          const analysis = await runScreenshotAnalyzer(filename, { title: windowMatch });
          if (analysis) {
            for (const t of analysis.targets) {
              cacheTarget(guiState, t.label, t.x, t.y);
              if (guiState.activeApp) {
                storeCoordinate(guiState.activeApp, windowMatch, t.label, t.x, t.y, guiState.confidence);
              }
            }
            return analysis.summary;
          }
          return 'OCR returned no results';
        });
      }

      recordSuccess(guiState, 'launch_and_focus', appBinary);
      return `${m.finish()}\n\nResult: Launched and focused "${appBinary}" → "${windowMatch}"${ocrResult ? '\n\n' + ocrResult : ''}`;
    }

    case 'open_menu_path': {
      let menuPath: string[];
      if (Array.isArray(input.path)) {
        menuPath = input.path;
      } else if (typeof input.path === 'string') {
        menuPath = input.path.split(/\s*>\s*/);
      } else if (text) {
        menuPath = text.split(/\s*>\s*/);
      } else {
        return '[Error] open_menu_path requires "path" as array ["File","Export As"] or string "File > Export As".';
      }
      if (menuPath.length === 0) return '[Error] Menu path is empty.';
      const mMenu = createMacroTrace(`open_menu_path("${menuPath.join(' > ')}")`);

      if (effectiveWindow) {
        await mMenu.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      const firstMenu = menuPath[0].trim();
      const firstLetter = firstMenu[0].toLowerCase();
      await mMenu.step('open_menu', firstMenu, async () => {
        await run(`xdotool key alt+${firstLetter}`);
        await wait(300);
        return `Opened menu "${firstMenu}" via Alt+${firstLetter}`;
      });

      for (let i = 1; i < menuPath.length; i++) {
        const item = menuPath[i].trim();
        const isFinal = i === menuPath.length - 1;
        await mMenu.step(isFinal ? 'activate' : 'navigate', item, async () => {
          for (const char of item.slice(0, 5)) {
            await run(`xdotool key ${char.toLowerCase()}`);
            await wait(50);
          }
          await wait(200);
          if (!isFinal) {
            await run('xdotool key Right');
            await wait(200);
            return `Navigated to submenu "${item}"`;
          } else {
            await run('xdotool key Return');
            await wait(300);
            return `Activated "${item}"`;
          }
        });
      }

      const verifyResult = await postActionVerify(effectiveWindow);
      recordSuccess(guiState, 'open_menu_path', menuPath.join(' > '));
      return `${mMenu.finish()}\n\nResult: Menu ${menuPath.join(' > ')}${verifyResult ? '\n' + verifyResult : ''}`;
    }

    case 'fill_dialog': {
      const fields = input.fields as Array<{ value: string; label?: string }>;
      if (!fields || !Array.isArray(fields) || fields.length === 0) {
        return '[Error] fill_dialog requires "fields" array with {value} objects in tab order.';
      }
      const mFill = createMacroTrace(`fill_dialog(${fields.length} fields)`);

      if (effectiveWindow) {
        await mFill.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const value = String(field.value);
        const label = field.label ? ` (${field.label})` : '';
        const fillResult = await mFill.step('fill_field', `field ${i + 1}${label}: "${value.slice(0, 30)}"`, async () => {
          if (i > 0) {
            await run('xdotool key Tab');
            await wait(100);
          }
          await run('xdotool key ctrl+a');
          await wait(50);
          await run(`xdotool type --delay 10 -- "${value.replace(/"/g, '\\"')}"`);
          await wait(100);
          return `Filled field ${i + 1}${label}: "${value.slice(0, 40)}"`;
        });
        if (fillResult.startsWith('[Error')) break;
      }

      const shouldConfirm = input.confirm !== false;
      if (shouldConfirm) {
        await mFill.step('confirm', 'Enter', async () => {
          await wait(200);
          await run('xdotool key Return');
          await wait(300);
          return 'Confirmed (Enter)';
        });
      }

      recordSuccess(guiState, 'fill_dialog', `${fields.length} fields`);
      const verifyResult = shouldConfirm ? await postActionVerify(effectiveWindow) : '';
      return `${mFill.finish()}${verifyResult ? '\n' + verifyResult : ''}`;
    }

    case 'confirm_dialog': {
      const mConfirm = createMacroTrace(`confirm_dialog(${input.button || 'Enter'})`);

      if (effectiveWindow) {
        await mConfirm.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      const settleMs = input.settle_ms || 300;
      await mConfirm.step('settle', `${settleMs}ms`, async () => {
        await wait(settleMs);
        return `Waited ${settleMs}ms for dialog to settle`;
      });

      if (input.button) {
        const buttonLabel = String(input.button).toLowerCase();
        const target = Object.entries(guiState.knownTargets)
          .find(([label]) => label.toLowerCase().includes(buttonLabel));
        if (target) {
          const [label, coords] = target;
          await mConfirm.step('click_button', label, async () => {
            await run(`xdotool mousemove ${coords.x} ${coords.y} click 1`);
            recordSuccess(guiState, 'confirm_dialog', label);
            return `Clicked "${label}" at (${coords.x}, ${coords.y})`;
          });
          return mConfirm.finish();
        }
        console.log(`[Macro] confirm_dialog: button "${input.button}" not in cache, using Enter`);
      }

      await mConfirm.step('confirm', 'Enter', async () => {
        await run('xdotool key Return');
        recordSuccess(guiState, 'confirm_dialog', 'Enter');
        return 'Pressed Enter';
      });

      const verifyResult = await postActionVerify(effectiveWindow);
      return `${mConfirm.finish()}${verifyResult ? '\n' + verifyResult : ''}`;
    }

    case 'export_file': {
      const exportPath = input.path || input.export_path;
      if (!exportPath) return '[Error] export_file requires "path" (output file path).';
      const mExport = createMacroTrace(`export_file("${exportPath}")`);

      if (effectiveWindow) {
        await mExport.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      let shortcut = input.shortcut as string | undefined;
      if (!shortcut) {
        const app = input.app || guiState.activeApp || '';
        const { resolveShortcut } = require('../../gui/shortcuts');
        shortcut = resolveShortcut(app, 'export_as') || resolveShortcut(app, 'save_as') || 'ctrl+shift+e';
      }

      await mExport.step('shortcut', shortcut!, async () => {
        await run(`xdotool key ${shortcut}`);
        await wait(800);
        return `Triggered ${shortcut}`;
      });

      await mExport.step('fill_path', exportPath, async () => {
        await run('xdotool key ctrl+a');
        await wait(100);
        await run(`xdotool type --delay 10 -- "${exportPath.replace(/"/g, '\\"')}"`);
        await wait(200);
        return `Typed path: ${exportPath}`;
      });

      await mExport.step('confirm', 'Enter', async () => {
        await run('xdotool key Return');
        await wait(500);
        return 'Pressed Enter to confirm';
      });

      const afterExport = await postActionVerify(effectiveWindow);
      if (afterExport.includes('DIALOG') || afterExport.toLowerCase().includes('overwrite') || afterExport.toLowerCase().includes('replace')) {
        await mExport.step('confirm_overwrite', 'Enter', async () => {
          await wait(200);
          await run('xdotool key Return');
          await wait(300);
          return 'Confirmed overwrite dialog';
        });
      }

      const resolvedPath = exportPath.replace(/^~\//, os.homedir() + '/');
      await mExport.step('verify_file', resolvedPath, async () => {
        const fileCheck = await run(`stat --printf="%s bytes" "${resolvedPath}" 2>/dev/null`);
        return fileCheck.startsWith('[Error]') ? '[Error] File NOT found' : `File: ${fileCheck}`;
      });

      recordSuccess(guiState, 'export_file', exportPath);
      return `${mExport.finish()}${afterExport ? '\n' + afterExport : ''}`;
    }

    case 'click_and_type': {
      if (x == null || y == null) return '[Error] click_and_type requires x, y coordinates.';
      if (!text) return '[Error] click_and_type requires "text" to type.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';

      const m = createMacroTrace(`click_and_type(${x},${y},"${text.slice(0, 30)}")`);

      if (effectiveWindow) {
        await m.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      const clickResult = await m.step('click', `(${x},${y})`, async () => {
        const r = await run(`xdotool mousemove ${x} ${y} click 1`);
        if (r.startsWith('[Error')) return r;
        await wait(100);
        recordSuccess(guiState, 'click', `(${x},${y})`);
        return `Clicked (${x}, ${y})`;
      });
      if (clickResult.startsWith('[Error')) {
        recordError(guiState, 'click_and_type', `click failed at (${x},${y})`);
        return `${m.finish()}\nFailed at click step.`;
      }

      await m.step('type', text.slice(0, 40), async () => {
        await run(`xdotool type --delay 15 -- "${text.replace(/"/g, '\\"')}"`);
        recordSuccess(guiState, 'type', text.slice(0, 30));
        return `Typed "${text.slice(0, 50)}"`;
      });

      recordSuccess(guiState, 'click_and_type', `(${x},${y}) "${text.slice(0, 20)}"`);
      return `${m.finish()}\n\nResult: Clicked (${x},${y}) and typed "${text.slice(0, 50)}"`;
    }

    default:
      return null;
  }
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/gui-macros.ts`
Expected: file listed

---

## Task 13: Create `desktop/a11y-actions.ts`

Extract AT-SPI action cases from `execSingleAction` in `desktop-executors.ts` lines 1220–1308.

**Files:**
- Create: `src/main/agent/executors/desktop/a11y-actions.ts`

- [ ] **Step 1: Create the file**

```typescript
import {
  a11yGetTree, a11yFind, a11yDoAction, a11ySetValue, a11yGetState, a11yListApps,
  isA11yAvailable,
} from '../../gui/a11y';
import {
  recordSuccess,
} from '../../gui/ui-state';
import { guiState } from './gui-state';

/**
 * Handle AT-SPI accessibility actions.
 * Returns null for any action this handler does not own.
 */
export async function execA11yAction(
  input: Record<string, any>,
  batchWindow?: string,
): Promise<string | null> {
  const { action, window: winName, text } = input;
  const effectiveWindow = winName || batchWindow;

  switch (action) {
    case 'a11y_get_tree': {
      const appTarget = input.app || effectiveWindow || input.name || text || '';
      if (!appTarget) return `[Error] a11y_get_tree requires "app" or "window". Got input keys: ${Object.keys(input).join(', ')}`;
      if (!await isA11yAvailable()) return '[Error] AT-SPI not available. Install: sudo apt install gir1.2-atspi-2.0';
      const result = await a11yGetTree(appTarget, input.scope, input.depth);
      if (result.error) {
        console.warn(`[a11y] get_tree failed: ${result.error}`);
        return `[a11y Error] ${result.error}${result.available_apps ? '\nAvailable apps: ' + result.available_apps.join(', ') : ''}`;
      }
      recordSuccess(guiState, 'a11y_get_tree', appTarget);
      return `[a11y Tree] ${appTarget}${input.scope ? ' > ' + input.scope : ''}\n${JSON.stringify(result.tree, null, 2).slice(0, 4000)}`;
    }

    case 'a11y_find': {
      const appTarget = input.app || effectiveWindow || '';
      if (!appTarget || !input.role || !input.name) return '[Error] a11y_find requires "app", "role", and "name".';
      if (!await isA11yAvailable()) return '[Error] AT-SPI not available.';
      const result = await a11yFind(appTarget, input.role, input.name, input.scope);
      if (result.error) return `[a11y Error] ${result.error}`;
      if (!result.found) return `[a11y] Element not found: role="${input.role}" name="${input.name}"`;
      if (result.ambiguous) {
        return `[a11y Warning] Ambiguous match (${result.candidates} candidates). Top matches:\n${JSON.stringify(result.top_matches, null, 2).slice(0, 1500)}`;
      }
      recordSuccess(guiState, 'a11y_find', `${input.role}:${input.name}`);
      return `[a11y Found] ${JSON.stringify(result.match, null, 2)}`;
    }

    case 'a11y_do_action': {
      const appTarget = input.app || effectiveWindow || '';
      if (!appTarget || !input.role || !input.name || !input.a11y_action) {
        return `[Error] a11y_do_action requires "app", "role", "name", and "a11y_action". Got: app=${appTarget || 'null'} role=${input.role || 'null'} name=${input.name || 'null'} a11y_action=${input.a11y_action || 'null'}`;
      }
      if (!await isA11yAvailable()) return '[Error] AT-SPI not available.';
      console.log(`[a11y] do_action: ${input.a11y_action} on ${input.role} "${input.name}" in ${appTarget}${input.scope ? ' > ' + input.scope : ''}`);
      const result = await a11yDoAction(appTarget, input.role, input.name, input.a11y_action, input.scope);
      if (result.error) {
        console.warn(`[a11y] do_action failed: ${result.error}`);
        return `[a11y Error] ${result.error}${result.candidates ? '\nCandidates: ' + JSON.stringify(result.candidates) : ''}${result.available_actions ? '\nAvailable actions: ' + result.available_actions.join(', ') : ''}`;
      }
      recordSuccess(guiState, 'a11y_do_action', `${input.a11y_action}:${input.name}`);
      return `[a11y] Action "${input.a11y_action}" on ${input.role} "${input.name}": ${result.success ? 'success' : 'failed'}`;
    }

    case 'a11y_set_value': {
      const appTarget = input.app || effectiveWindow || '';
      const a11yValue = input.value ?? text ?? null;
      const a11yName = input.name || '';
      const a11yRole = input.role || '';
      if (!appTarget || !a11yRole || !a11yName || a11yValue == null) {
        return `[Error] a11y_set_value requires "app", "role", "name", and "value" (or "text"). Got: app=${appTarget || 'null'} role=${a11yRole || 'null'} name=${a11yName || 'null'} value=${a11yValue ?? 'null'}`;
      }
      if (!await isA11yAvailable()) return '[Error] AT-SPI not available.';
      console.log(`[a11y] set_value: ${a11yRole} "${a11yName}" = "${String(a11yValue).slice(0, 40)}" in ${appTarget}`);
      const result = await a11ySetValue(appTarget, a11yRole, a11yName, String(a11yValue), input.scope);
      if (result.error) {
        console.warn(`[a11y] set_value failed: ${result.error}`);
        return `[a11y Error] ${result.error}`;
      }
      recordSuccess(guiState, 'a11y_set_value', `${a11yName}=${String(a11yValue).slice(0, 20)}`);
      return `[a11y] Set ${a11yRole} "${a11yName}" = "${result.value_set}" (read back: "${result.value_read_back || 'N/A'}")`;
    }

    case 'a11y_get_state': {
      const appTarget = input.app || effectiveWindow || '';
      if (!appTarget || !input.role || !input.name) return '[Error] a11y_get_state requires "app", "role", and "name".';
      if (!await isA11yAvailable()) return '[Error] AT-SPI not available.';
      const result = await a11yGetState(appTarget, input.role, input.name, input.scope);
      if (result.error) return `[a11y Error] ${result.error}`;
      return `[a11y State] ${input.role} "${input.name}": value="${result.value || 'N/A'}" states=[${(result.states || []).join(', ')}]`;
    }

    case 'a11y_list_apps': {
      if (!await isA11yAvailable()) return '[Error] AT-SPI not available.';
      const result = await a11yListApps();
      if (result.error) return `[a11y Error] ${result.error}`;
      return `[a11y] Accessible apps: ${(result.apps || []).join(', ')}`;
    }

    default:
      return null;
  }
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/a11y-actions.ts`
Expected: file listed

---

## Task 14: Create `desktop/gui-executor.ts`

Create the public `executeGuiInteract` function and `batch_actions` dispatcher.

**Files:**
- Create: `src/main/agent/executors/desktop/gui-executor.ts`

- [ ] **Step 1: Create the file**

```typescript
import { execPrimitiveAction } from './gui-primitives';
import { execMacroAction } from './gui-macros';
import { execA11yAction } from './a11y-actions';
import { guiState } from './gui-state';
import {
  recordError,
} from '../../gui/ui-state';

async function execSingleAction(input: Record<string, any>, batchWindow?: string): Promise<string> {
  const result = await execPrimitiveAction(input, batchWindow)
               ?? await execMacroAction(input, batchWindow)
               ?? await execA11yAction(input, batchWindow);
  return result ?? `[Error] Unknown action: "${input.action}"`;
}

export async function executeGuiInteract(input: Record<string, any>): Promise<string> {
  const { action } = input;
  if (!action) return '[Error] action is required.';

  // Guard: prevent gui_interact from being used on the browser panel
  const winName = (input.window || '').toLowerCase();
  if (/clawdia|electron|chromium|browser/i.test(winName) && action !== 'list_windows' && action !== 'verify_window_title') {
    return '[Error] Do not use gui_interact for the browser. Use browser_click, browser_type, and browser_navigate instead — they operate at the DOM level and are faster and more reliable than xdotool pixel clicking.';
  }

  const sessionType = process.env.XDG_SESSION_TYPE || '';
  if (sessionType === 'wayland' && action !== 'list_windows' && action !== 'verify_window_title' && action !== 'verify_file_exists') {
    return `[Warning] GUI automation requires X11. Detected: Wayland.`;
  }

  if (action === 'batch_actions') {
    const actions = input.actions as Record<string, any>[];
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      return '[Error] batch_actions requires an "actions" array.';
    }
    if (actions.length > 20) return '[Error] Max 20 steps per batch.';

    const batchWindow = input.window as string | undefined;

    const results: string[] = [];
    for (let i = 0; i < actions.length; i++) {
      const step = actions[i];
      if (!step.action) { results.push(`[Step ${i + 1}] [Error] Missing action`); continue; }
      if (!step.delay && (step.action === 'click' || step.action === 'key')) step.delay = 100;

      const stepResult = await execSingleAction(step, batchWindow);
      results.push(`[Step ${i + 1}: ${step.action}] ${stepResult}`);

      if (stepResult.startsWith('[Error]')) {
        recordError(guiState, step.action, step.window || batchWindow);
        console.warn(`[Desktop] Batch step ${i + 1} failed: ${stepResult}`);
      }
    }

    const stateNote = guiState.skippedFocusCalls > 0
      ? `\n[State] Skipped ${guiState.skippedFocusCalls} redundant focus calls (window already focused)`
      : '';
    return results.join('\n') + stateNote;
  }

  return await execSingleAction(input);
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/gui-executor.ts`
Expected: file listed

---

## Task 15: Create `desktop/app-control.ts`

Extract `executeAppControl`, `tryControlSurface`, and `guessDbusMethod` from `desktop-executors.ts` lines 304–452.

**Files:**
- Create: `src/main/agent/executors/desktop/app-control.ts`

- [ ] **Step 1: Create the file**

```typescript
import {
  getAppProfile,
  getHarnessGuidance,
  type AppProfile,
  type ControlSurface,
  recordFallback,
} from '../../../db/app-registry';
import { run, cmdExists } from './shared';

/** Best-effort mapping of command words to MPRIS method names. */
function guessDbusMethod(command: string): string {
  const lower = command.toLowerCase();
  if (/pause|resume|toggle/i.test(lower)) return 'PlayPause';
  if (/^play\b/i.test(lower)) return 'Play';
  if (/stop/i.test(lower)) return 'Stop';
  if (/next|skip/i.test(lower)) return 'Next';
  if (/prev/i.test(lower)) return 'Previous';
  if (/open|uri|url/i.test(lower)) return 'OpenUri';
  if (/what.*playing|now.*playing|status|metadata/i.test(lower)) return 'Metadata (via get_property)';
  return 'PlayPause';
}

async function tryControlSurface(
  surface: ControlSurface,
  profile: AppProfile,
  appName: string,
  command: string,
  json: boolean,
): Promise<{ ok: boolean; result: string }> {
  switch (surface) {
    case 'dbus': {
      if (!profile.dbusService) return { ok: false, result: '[Skip] No DBus service in profile' };
      if (!await cmdExists('dbus-send')) return { ok: false, result: '[Skip] dbus-send not installed' };

      const ping = await run(
        `dbus-send --session --dest=${profile.dbusService} --type=method_call --print-reply /org/mpris/MediaPlayer2 org.freedesktop.DBus.Properties.Get string:"org.mpris.MediaPlayer2" string:"Identity"`,
        5000,
      );
      if (ping.startsWith('[Error]')) {
        return { ok: false, result: `[Skip] DBus service "${profile.dbusService}" not running` };
      }
      return {
        ok: true,
        result: `[DBus available] Service "${profile.dbusService}" is running. Use dbus_control to send commands. For MPRIS media players: action="call", service="${profile.dbusService}", path="/org/mpris/MediaPlayer2", interface="org.mpris.MediaPlayer2.Player", method="${guessDbusMethod(command)}".`,
      };
    }

    case 'cli_anything': {
      const harness = profile.cliAnything?.command || `cli-anything-${appName}`;
      if (!await cmdExists(harness)) return { ok: false, result: `[Skip] Harness "${harness}" not installed` };
      const flag = json ? ' --json' : '';
      console.log(`[app_control] CLI-Anything: ${harness}${flag} ${command}`);
      const result = await run(`${harness}${flag} ${command}`, 60_000);
      if (result.startsWith('[Error]')) return { ok: false, result };
      return { ok: true, result };
    }

    case 'native_cli': {
      const bin = profile.nativeCli?.command || profile.binaryPath || appName;
      if (!await cmdExists(bin)) return { ok: false, result: `[Skip] Binary "${bin}" not found` };
      const helpHint = profile.nativeCli?.helpSummary || '';
      const timeout = /hang|block|timeout/i.test(helpHint) ? 15_000 : 60_000;
      console.log(`[app_control] Native CLI: ${bin} ${command} (timeout: ${timeout / 1000}s)`);
      const result = await run(`${bin} ${command}`, timeout);
      if (result.startsWith('[Error]')) return { ok: false, result };
      return { ok: true, result };
    }

    case 'programmatic': {
      const alts = profile.programmaticAlternatives?.join(', ') || 'python3';
      return {
        ok: false,
        result: `[Hint] For file-level operations (resize, convert, create), use shell_exec with ${alts} instead of app_control. Continuing fallback chain for app-level operations...`,
      };
    }

    case 'gui': {
      return {
        ok: false,
        result: `[Skip] GUI surface — not handled by app_control.`,
      };
    }

    default:
      return { ok: false, result: `[Skip] Unknown surface: ${surface}` };
  }
}

export async function executeAppControl(input: Record<string, any>): Promise<string> {
  const { app, command, json = true } = input;
  if (!app || !command) return '[Error] app and command are required.';

  const appName = app.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const profile = getAppProfile(appName);

  if (profile) {
    const tried: string[] = [];
    for (const surface of profile.availableSurfaces) {
      const attempt = await tryControlSurface(surface, profile, appName, command, json);
      tried.push(`${surface}: ${attempt.ok ? 'OK' : attempt.result}`);
      if (attempt.ok) {
        console.log(`[app_control] ${profile.displayName} → ${surface} succeeded`);
        return attempt.result;
      }
      console.log(`[app_control] ${profile.displayName} → ${surface} failed, trying next...`);
    }

    recordFallback();
    const guidance = getHarnessGuidance(appName);
    const harnessBlock = guidance.alreadySuggested
      ? ''
      : `\n\n${guidance.installSteps}`;
    return `[Error] All control surfaces failed for "${profile.displayName}".
Tried: ${tried.join(' → ')}

Fallback options:
- Use shell_exec to launch it: setsid ${profile.binaryPath || appName} >/dev/null 2>&1 &${harnessBlock}`;
  }

  const hasNative = await cmdExists(appName);
  if (!hasNative) {
    const guidance = getHarnessGuidance(appName);
    const harnessBlock = guidance.alreadySuggested ? '' : `\n\n${guidance.installSteps}`;
    return `[No profile or binary found for "${app}"]

This app is not in the registry and is not installed. Try:
- shell_exec to check: which ${appName}${harnessBlock}`;
  }

  console.log(`[app_control] No profile for ${app}, using raw native CLI`);
  return await run(`${appName} ${command}`, 60_000);
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/app-control.ts`
Expected: file listed

---

## Task 16: Create `desktop/dbus-executor.ts`

Extract `executeDbusControl` from `desktop-executors.ts` lines 1364–1405.

**Files:**
- Create: `src/main/agent/executors/desktop/dbus-executor.ts`

- [ ] **Step 1: Create the file**

```typescript
import { run, cmdExists } from './shared';

export async function executeDbusControl(input: Record<string, any>): Promise<string> {
  const { action, service, path: objPath, interface: iface, method, args = [] } = input;
  if (!action) return '[Error] action is required.';
  if (!await cmdExists('dbus-send')) return '[Error] dbus-send not found.';

  switch (action) {
    case 'list_running': {
      const raw = await run(`dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply /org/freedesktop/DBus org.freedesktop.DBus.ListNames`);
      const lines = raw.split('\n').filter(l => l.includes('string "')).map(l => l.match(/string "(.+)"/)?.[1])
        .filter((s): s is string => !!s && !s.startsWith(':') && !s.startsWith('org.freedesktop.') && s.includes('.')).sort();
      if (lines.length === 0) return 'No interesting DBus services found.';
      return `Active DBus services (${lines.length}):\n${lines.map(s => `  ${s}`).join('\n')}`;
    }
    case 'discover': {
      if (!service) return '[Error] service name required.';
      const path = objPath || '/';
      const result = await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${path} org.freedesktop.DBus.Introspectable.Introspect`);
      const xmlMatch = result.match(/<node[\s\S]*<\/node>/);
      if (xmlMatch) {
        const ifaces = xmlMatch[0].match(/<interface name="([^"]+)">/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter((s): s is string => !!s && !s.startsWith('org.freedesktop.DBus.')) || [];
        const methods = xmlMatch[0].match(/<method name="([^"]+)">/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter(Boolean) || [];
        const props = xmlMatch[0].match(/<property name="([^"]+)"/g)?.map(m => m.match(/name="([^"]+)"/)?.[1]).filter(Boolean) || [];
        let s = `Service: ${service}\nPath: ${path}\n`;
        if (ifaces.length) s += `\nInterfaces:\n${ifaces.map(i => `  ${i}`).join('\n')}`;
        if (methods.length) s += `\nMethods:\n${methods.map(m => `  ${m}()`).join('\n')}`;
        if (props.length) s += `\nProperties:\n${props.map(p => `  ${p}`).join('\n')}`;
        return s;
      }
      return result;
    }
    case 'call': {
      if (!service || !objPath || !iface || !method) return '[Error] service, path, interface, method required.';
      const argsStr = (args as string[]).map(a => `string:"${a}"`).join(' ');
      return await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${objPath} ${iface}.${method} ${argsStr}`);
    }
    case 'get_property': {
      if (!service || !objPath || !iface || !method) return '[Error] service, path, interface, property required.';
      return await run(`dbus-send --session --dest=${service} --type=method_call --print-reply ${objPath} org.freedesktop.DBus.Properties.Get string:"${iface}" string:"${method}"`);
    }
    default: return `[Error] Unknown action: "${action}".`;
  }
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/dbus-executor.ts`
Expected: file listed

---

## Task 17: Create `desktop/capabilities.ts`

Extract `getCapabilityStatus`, `getDesktopCapabilities`, and `DesktopCapabilityStatus` from `desktop-executors.ts` lines 1407–1508.

**Files:**
- Create: `src/main/agent/executors/desktop/capabilities.ts`

- [ ] **Step 1: Create the file**

```typescript
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isA11yAvailable } from '../../gui/a11y';
import { listProfiles } from '../../../db/app-registry';
import { cmdExists, execAsync } from './shared';

export interface DesktopCapabilityStatus {
  xdotool: boolean;
  dbus: boolean;
  a11y: boolean;
  cliAnythingPlugin: boolean;
}

let _capabilityStatus: DesktopCapabilityStatus | null = null;

export async function getCapabilityStatus(): Promise<DesktopCapabilityStatus> {
  if (_capabilityStatus) return _capabilityStatus;
  const [xdotool, dbus, a11yResult] = await Promise.all([
    cmdExists('xdotool'),
    cmdExists('dbus-send'),
    isA11yAvailable(),
  ]);
  const cliAnythingPlugin = fs.existsSync(
    path.join(os.homedir(), 'CLI-Anything', 'cli-anything-plugin', 'HARNESS.md')
  );
  _capabilityStatus = { xdotool, dbus, a11y: a11yResult, cliAnythingPlugin };
  return _capabilityStatus;
}

let cachedCapabilities: string | null = null;

export async function getDesktopCapabilities(): Promise<string> {
  if (cachedCapabilities) return cachedCapabilities;

  const [xdotool, wmctrl, scrot, dbus, python3, convert] = await Promise.all([
    cmdExists('xdotool'), cmdExists('wmctrl'), cmdExists('scrot'),
    cmdExists('dbus-send'), cmdExists('python3'), cmdExists('convert'),
  ]);

  let hasPillow = false;
  if (python3) {
    try {
      await execAsync('python3 -c "from PIL import Image" 2>/dev/null', { timeout: 3000 });
      hasPillow = true;
    } catch {}
  }

  let harnesses: string[] = [];
  try {
    const profiles = listProfiles();
    harnesses = profiles
      .filter(p => p.cliAnything?.installed)
      .map(p => p.appId);
  } catch {}

  let displayLayout = '';
  try {
    const { stdout: xrandr } = await execAsync('xrandr --current 2>/dev/null', { timeout: 3000 });
    const monitors = xrandr.split('\n')
      .filter(l => / connected/.test(l))
      .map(l => {
        const name = l.split(' ')[0];
        const primary = l.includes('primary');
        const geom = l.match(/(\d+x\d+\+\d+\+\d+)/)?.[1] || '';
        return `  ${name}: ${geom}${primary ? ' (primary)' : ''}`;
      });
    if (monitors.length > 0) {
      displayLayout = `Monitors (${monitors.length}):\n${monitors.join('\n')}`;
    }
  } catch {}

  const sessionType = process.env.XDG_SESSION_TYPE || 'unknown';

  const lines: string[] = ['[Desktop capabilities]'];
  lines.push(`Display: ${sessionType}${sessionType === 'wayland' ? ' (⚠ xdotool limited)' : ''}`);
  if (displayLayout) lines.push(displayLayout);
  lines.push(`GUI tools: ${[xdotool && 'xdotool', wmctrl && 'wmctrl', scrot && 'scrot'].filter(Boolean).join(', ') || 'none'}`);
  lines.push(`DBus: ${dbus ? 'available' : 'not installed'}`);
  lines.push(`Imaging: ${[hasPillow && 'python3+Pillow', convert && 'ImageMagick'].filter(Boolean).join(', ') || 'none'}`);
  if (harnesses.length > 0) lines.push(`CLI-Anything: ${harnesses.join(', ')}`);

  let hasA11y = false;
  try {
    await execAsync('python3 -c "import gi; gi.require_version(\'Atspi\', \'2.0\')" 2>/dev/null', { timeout: 3000 });
    hasA11y = true;
  } catch {}
  lines.push(`Accessibility (AT-SPI): ${hasA11y ? 'available — use a11y_* actions for menus, dialogs, buttons, text fields' : 'not installed (sudo apt install gir1.2-atspi-2.0)'}`);

  if (!xdotool && !wmctrl) lines.push('Install GUI tools: sudo apt install xdotool wmctrl scrot');

  cachedCapabilities = lines.join('\n');
  console.log(`[Desktop] ${cachedCapabilities}`);
  return cachedCapabilities;
}
```

- [ ] **Step 2: Verify file exists**

Run: `ls src/main/agent/executors/desktop/capabilities.ts`
Expected: file listed

---

## Task 18: Create `desktop/index.ts` and update `desktop-executors.ts`

Wire up the desktop submodule and replace the original file with a thin wrapper.

**Files:**
- Create: `src/main/agent/executors/desktop/index.ts`
- Modify: `src/main/agent/executors/desktop-executors.ts`

- [ ] **Step 1: Create `desktop/index.ts`**

```typescript
export * from './gui-state';
export * from './gui-executor';
export * from './app-control';
export * from './dbus-executor';
export * from './capabilities';
```

Note: `shared.ts`, `screenshot-analyzer.ts`, `smart-focus.ts`, `action-verify.ts`, `gui-primitives.ts`, `gui-macros.ts`, and `a11y-actions.ts` are internal — their exports are not part of the public API and must NOT be re-exported from `index.ts`.

- [ ] **Step 2: Replace `desktop-executors.ts` body**

Replace the entire content of `src/main/agent/executors/desktop-executors.ts` with:

```typescript
/**
 * Desktop Tool Executors — re-export entrypoint.
 * All logic lives in ./desktop/ submodules.
 */
export * from './desktop';
```

- [ ] **Step 3: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | head -40`
Expected: zero errors

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -20`
Expected: all tests pass

- [ ] **Step 5: Verify all original public exports are still accessible**

Run:
```bash
node -e "
const tsc = require('child_process');
// Quick import smoke test: check the wrapper re-exports compile
console.log('Checking core wrapper...');
" 2>&1
```

Actually verify by checking the tsc output above covers it — if `npx tsc --noEmit` passes with zero errors, all imports in `tool-builder.ts`, `main.ts`, and `loop-setup.ts` are verified.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/executors/desktop/ src/main/agent/executors/desktop-executors.ts
git commit -m "refactor: split desktop-executors into domain submodules"
```

---

## Task 19: Final Validation

Confirm everything works end-to-end.

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit`
Expected: zero errors, zero warnings

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 3: Verify original file sizes are now small**

Run: `wc -l src/main/agent/executors/core-executors.ts src/main/agent/executors/desktop-executors.ts`
Expected: both files are ~5 lines each (just the re-export wrapper)

- [ ] **Step 4: Verify new files exist at expected paths**

Run: `find src/main/agent/executors/core src/main/agent/executors/desktop -name "*.ts" | sort`
Expected: all 13 new files present

- [ ] **Step 5: Verify no consumers were modified**

Run: `git diff HEAD~2 -- src/main/agent/tool-builder.ts src/main/main.ts src/main/agent/loop-setup.ts`
Expected: empty diff (no changes to these files)

- [ ] **Step 6: Final commit if any loose changes remain**

```bash
git status
# Only commit if there are uncommitted changes
git add -p
git commit -m "refactor: finalize executor layer decomposition"
```
