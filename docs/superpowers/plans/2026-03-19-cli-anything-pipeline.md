# CLI-Anything Auto-Install + Harness Generation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user asks Clawdia to use an app it doesn't have a CLI harness for (or that isn't installed), Clawdia autonomously installs the app, generates a full CLI-Anything harness via a nested agent loop, and then executes the original task — all narrated to the user.

**Architecture:** A new pre-task pipeline runs inside `runPreLLMSetup` before the main LLM loop starts. It has two stages: `loop-app-install.ts` handles system package installation (flatpak --user first, then pkexec for apt/snap), and `loop-harness.ts` runs a nested 40-iteration agent loop that follows the 7-phase CLI-Anything methodology to generate, test, and install a harness. `loop.ts` gains a `nestedCancelFn` registration so `cancelLoop()` can abort harness generation mid-flight.

**Tech Stack:** TypeScript, Electron main process, `AnthropicClient` (existing), `better-sqlite3` (existing), `child_process.exec`, HARNESS.md from `~/CLI-Anything/cli-anything-plugin/`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/main/agent/loop-cancel.ts` | **Create** | Shared nested-cancel state — breaks circular import between loop.ts and loop-setup.ts |
| `src/main/agent/loop-app-install.ts` | **Create** | installApp() — flatpak/pkexec install with timeouts |
| `src/main/agent/loop-harness.ts` | **Create** | runHarnessPipeline() — nested 7-phase agent loop |
| `src/main/agent/loop.ts` | **Modify** | Add onProgress to LoopOptions, import fireNestedCancel from loop-cancel, verify startTime placement |
| `src/main/agent/loop-setup.ts` | **Modify** | Add apiKey+onProgress params, wire install+harness checks |
| `tests/test-loop-app-install.ts` | **Create** | Unit tests for installApp() |
| `tests/test-loop-harness.ts` | **Create** | Unit tests for runHarnessPipeline() pre-flight and registry update |

---

## Task 1: Create `loop-cancel.ts` and update `loop.ts`

**Files:**
- Create: `src/main/agent/loop-cancel.ts`
- Modify: `src/main/agent/loop.ts`

`loop-cancel.ts` must be created first. It holds the nested-cancel state so that neither `loop.ts` nor `loop-setup.ts` imports from the other — breaking the circular dependency.

- [ ] **Step 1: Create `src/main/agent/loop-cancel.ts`**

```typescript
/**
 * loop-cancel.ts — Nested loop cancel registration.
 *
 * Extracted from loop.ts to break the circular import:
 *   loop.ts ← loop-setup.ts ← loop-cancel.ts
 *
 * loop.ts imports fireNestedCancel and calls it in cancelLoop().
 * loop-setup.ts imports registerNestedCancel / clearNestedCancel.
 * loop-harness.ts does not import from loop.ts at all.
 */

type NestedCancelFn = () => void;
let nestedCancelFn: NestedCancelFn | null = null;

export function registerNestedCancel(fn: NestedCancelFn): void {
  nestedCancelFn = fn;
}

export function clearNestedCancel(): void {
  nestedCancelFn = null;
}

export function fireNestedCancel(): void {
  nestedCancelFn?.();
  nestedCancelFn = null;
}
```

- [ ] **Step 2: Update `cancelLoop()` in `loop.ts` to use `fireNestedCancel`**

Add this import at the top of `src/main/agent/loop.ts` (alongside existing imports):

```typescript
import { fireNestedCancel } from './loop-cancel';
```

Extend the existing `cancelLoop()` export to call `fireNestedCancel`:

```typescript
export function cancelLoop(): void {
  if (activeAbortController) {
    activeAbortController.abort();
    console.log('[Loop] Cancel requested');
  }
  fireNestedCancel();   // abort harness generation if running
  if (pauseResolve) { pauseResolve(); pauseResolve = null; }
  isPaused = false;
}
```

- [ ] **Step 3: Add `onProgress` to `LoopOptions` in `loop.ts`**

Find the `LoopOptions` interface and add the new field:

```typescript
export interface LoopOptions {
  apiKey: string;
  model?: string;
  onStreamText?: (text: string) => void;
  onThinking?: (thought: string) => void;
  onToolActivity?: (activity: { name: string; status: string; detail?: string }) => void;
  onToolStream?: (payload: { toolId: string; toolName: string; chunk: string }) => void;
  onStreamEnd?: () => void;
  onPaused?: () => void;
  onResumed?: () => void;
  onProgress?: (text: string) => void;  // narration during pre-LLM setup
  window?: BrowserWindow;
}
```

- [ ] **Step 4: Verify `startTime` is already correctly positioned**

Open `src/main/agent/loop.ts` and confirm `const startTime = Date.now();` appears AFTER the `await runPreLLMSetup(...)` call. It should already be correct in the refactored file — just verify and move on. No code change needed.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /home/dp/Desktop/clawdia4.0
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -30
```

Expected: no errors related to `loop.ts` or `loop-cancel.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/loop-cancel.ts src/main/agent/loop.ts
git commit -m "feat: add loop-cancel.ts, onProgress to LoopOptions, nested cancel in cancelLoop"
```

---

## Task 2: Create `loop-app-install.ts`

**Files:**
- Create: `src/main/agent/loop-app-install.ts`
- Create: `tests/test-loop-app-install.ts`

- [ ] **Step 1: Write the failing test first**

Create `tests/test-loop-app-install.ts`:

```typescript
// Tests for installApp() — uses mocked execAsync so no real installs happen
import { installApp } from '../src/main/agent/loop-app-install';

// Minimal smoke test: already-installed binary returns true immediately
// (Full integration tests require a real system)
async function testAlreadyInstalled() {
  const progress: string[] = [];
  // 'ls' is always on PATH — should return true without attempting install
  const result = await installApp('ls', (msg) => progress.push(msg));
  if (!result) throw new Error('Expected true for already-installed binary');
  if (progress.length > 0) throw new Error('Should not narrate for already-installed binary');
  console.log('✓ already-installed returns true silently');
}

async function testUnknownApp() {
  const progress: string[] = [];
  // '__nonexistent_app_xyz__' will never be installed
  const result = await installApp('__nonexistent_app_xyz__', (msg) => progress.push(msg));
  if (result) throw new Error('Expected false for unknown app');
  if (!progress.some(m => m.includes('__nonexistent_app_xyz__'))) {
    throw new Error('Expected narration mentioning app name');
  }
  console.log('✓ unknown app returns false with narration');
}

(async () => {
  await testAlreadyInstalled();
  await testUnknownApp();
  console.log('All loop-app-install tests passed');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test to confirm it fails (file doesn't exist yet)**

```bash
cd /home/dp/Desktop/clawdia4.0
npx ts-node --project tsconfig.main.json tests/test-loop-app-install.ts 2>&1 | head -20
```

Expected: `Cannot find module '../src/main/agent/loop-app-install'`

- [ ] **Step 3: Implement `loop-app-install.ts`**

Create `src/main/agent/loop-app-install.ts`:

```typescript
/**
 * App Installer — install system apps before harness generation.
 *
 * Strategy (no bare sudo — blocks on stdin in Electron main process):
 *   1. flatpak install --user  (no auth, user-space)
 *   2. pkexec apt install      (GUI PolicyKit dialog)
 *   3. pkexec snap install     (GUI PolicyKit dialog)
 *
 * All PM calls have 120s timeouts. Failures are non-fatal.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const INSTALL_TIMEOUT = 120_000;

// One-time availability check cache
const pmCache: Record<string, boolean> = {};

async function hasBin(cmd: string): Promise<boolean> {
  if (cmd in pmCache) return pmCache[cmd];
  try {
    await execAsync(`which ${cmd} 2>/dev/null`, { timeout: 3000 });
    pmCache[cmd] = true;
  } catch {
    pmCache[cmd] = false;
  }
  return pmCache[cmd];
}

async function binaryOnPath(appId: string): Promise<boolean> {
  try {
    await execAsync(`which ${appId} 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function installApp(
  appId: string,
  onProgress: (text: string) => void,
): Promise<boolean> {
  // Already installed — fast path
  if (await binaryOnPath(appId)) return true;

  // 1. Try flatpak --user (no auth needed)
  if (await hasBin('flatpak')) {
    onProgress(`Installing ${appId} via flatpak (user install, no password needed)...`);
    try {
      await execAsync(
        `flatpak install --user -y flathub ${appId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      // Flatpak binaries may not be on PATH directly — check both
      if (await binaryOnPath(appId) || await binaryOnPath(`flatpak`)) {
        onProgress(`✓ Installed ${appId} via flatpak.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] flatpak failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // 2. Try pkexec apt (GUI password dialog)
  if (await hasBin('pkexec') && await hasBin('apt')) {
    onProgress(`Installing ${appId} via apt (a password dialog will appear)...`);
    try {
      await execAsync(
        `pkexec apt install -y ${appId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      if (await binaryOnPath(appId)) {
        onProgress(`✓ Installed ${appId} via apt.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] pkexec apt failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // 3. Try pkexec snap (GUI password dialog)
  if (await hasBin('pkexec') && await hasBin('snap')) {
    onProgress(`Installing ${appId} via snap (a password dialog will appear)...`);
    try {
      await execAsync(
        `pkexec snap install ${appId} 2>&1`,
        { timeout: INSTALL_TIMEOUT },
      );
      if (await binaryOnPath(appId)) {
        onProgress(`✓ Installed ${appId} via snap.`);
        return true;
      }
    } catch (e: any) {
      console.log(`[Install] pkexec snap failed for ${appId}: ${e.message?.slice(0, 100)}`);
    }
  }

  // All methods failed
  onProgress(
    `Could not install ${appId} automatically. Please run one of:\n` +
    `  sudo apt install ${appId}\n` +
    `  sudo snap install ${appId}\n` +
    `  flatpak install flathub ${appId}\n` +
    `Then try your request again.`,
  );
  return false;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd /home/dp/Desktop/clawdia4.0
npx ts-node --project tsconfig.main.json tests/test-loop-app-install.ts
```

Expected:
```
✓ already-installed returns true silently
✓ unknown app returns false with narration
All loop-app-install tests passed
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/loop-app-install.ts tests/test-loop-app-install.ts
git commit -m "feat: add loop-app-install — flatpak/pkexec install with narration"
```

---

## Task 3: Create `loop-harness.ts`

**Files:**
- Create: `src/main/agent/loop-harness.ts`
- Create: `tests/test-loop-harness.ts`

This is the largest task. The nested loop reuses `AnthropicClient` + `executeTool` but maintains its own abort controller and message history.

- [ ] **Step 1: Write failing tests**

Create `tests/test-loop-harness.ts`:

```typescript
// Tests for runHarnessPipeline() — pre-flight checks and registry behavior
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Test 1: Pre-flight fails when HARNESS.md is missing
async function testPreflight() {
  // Temporarily point HARNESS_MD_PATH to a nonexistent file by
  // testing the exported helper directly
  const { checkPreflight } = await import('../src/main/agent/loop-harness');
  const result = await checkPreflight('/nonexistent/HARNESS.md', '/nonexistent/repl_skin.py');
  if (result.ok) throw new Error('Expected preflight to fail with missing files');
  if (!result.reason.includes('HARNESS.md')) throw new Error('Expected reason to mention HARNESS.md');
  console.log('✓ preflight fails with missing HARNESS.md');
}

// Test 2: Pre-flight passes when both files exist
async function testPreflightPass() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  const harnessMd = path.join(tmpDir, 'HARNESS.md');
  const replSkin = path.join(tmpDir, 'repl_skin.py');
  fs.writeFileSync(harnessMd, '# HARNESS');
  fs.writeFileSync(replSkin, '# repl skin');

  const { checkPreflight } = await import('../src/main/agent/loop-harness');
  const result = await checkPreflight(harnessMd, replSkin);
  fs.rmSync(tmpDir, { recursive: true });

  if (!result.ok) throw new Error(`Expected preflight to pass: ${result.reason}`);
  console.log('✓ preflight passes when both files exist');
}

(async () => {
  await testPreflight();
  await testPreflightPass();
  console.log('All loop-harness tests passed');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run test — expect fail (file missing)**

```bash
cd /home/dp/Desktop/clawdia4.0
npx ts-node --project tsconfig.main.json tests/test-loop-harness.ts 2>&1 | head -10
```

Expected: `Cannot find module '../src/main/agent/loop-harness'`

- [ ] **Step 3: Implement `loop-harness.ts`**

Create `src/main/agent/loop-harness.ts`:

```typescript
/**
 * Harness Pipeline — generates a CLI-Anything harness for an app.
 *
 * Runs a nested agent loop (max 40 iterations, 12 min wall time) that
 * follows the 7-phase CLI-Anything methodology from HARNESS.md.
 *
 * Does NOT touch module-level state in loop.ts.
 * Registers its abort fn via onRegisterCancel so cancelLoop() can reach it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicClient, resolveModelId } from './client';
import { executeTool, getToolsForGroup } from './tool-builder';
import { getAppProfile, updateAppProfile, type AppProfile } from '../db/app-registry';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const HARNESS_MAX_ITERATIONS = 40;
const HARNESS_MAX_MS = 12 * 60 * 1000;

export interface HarnessPipelineOptions {
  apiKey: string;
  onProgress: (text: string) => void;
  onRegisterCancel: (fn: () => void) => void;
}

export interface PreflightResult {
  ok: boolean;
  reason: string;
  harnessContent?: string;
}

/** Exported for testing — checks that required plugin files exist. */
export async function checkPreflight(
  harnessMdPath: string,
  replSkinPath: string,
): Promise<PreflightResult> {
  if (!fs.existsSync(harnessMdPath)) {
    return { ok: false, reason: `HARNESS.md not found at ${harnessMdPath}. Clone CLI-Anything plugin first.` };
  }
  if (!fs.existsSync(replSkinPath)) {
    return { ok: false, reason: `repl_skin.py not found at ${replSkinPath}.` };
  }
  const harnessContent = fs.readFileSync(harnessMdPath, 'utf-8');
  return { ok: true, reason: '', harnessContent };
}

function buildSystemPrompt(appId: string, harnessContent: string, outputDir: string): string {
  return `You are building a CLI-Anything harness for the application "${appId}".

Follow the 7-phase methodology in HARNESS.md exactly. After completing each phase, narrate what you did in plain text before calling the next tool.

Output directory: ${outputDir}
App binary: ${appId}

HARNESS.md methodology:
${harnessContent}

IMPORTANT RULES:
- Use file_write to create all Python files
- Use shell_exec to run commands (pytest, pip install, --help, man, etc.)
- Use file_read / file_edit to refine files
- After Phase 7 (install), verify with: shell_exec("which cli-anything-${appId}")
- If which succeeds, output the exact text: [HARNESS_INSTALLED_SUCCESS]
- If anything blocks you, explain and continue with best effort
- Never use gui_interact, browser tools, or memory tools`;
}

// Only CORE tools — no GUI, browser, memory
const HARNESS_TOOLS = ['shell_exec', 'file_read', 'file_write', 'file_edit', 'directory_tree'];

export async function runHarnessPipeline(
  appId: string,
  options: HarnessPipelineOptions,
): Promise<boolean> {
  const { apiKey, onProgress, onRegisterCancel } = options;
  const homedir = os.homedir();

  // Pre-flight: verify plugin files exist
  const harnessMdPath = path.join(homedir, 'CLI-Anything', 'cli-anything-plugin', 'HARNESS.md');
  const replSkinPath = path.join(homedir, 'CLI-Anything', 'cli-anything-plugin', 'repl_skin.py');
  const preflight = await checkPreflight(harnessMdPath, replSkinPath);
  if (!preflight.ok) {
    onProgress(`[Harness] Cannot generate: ${preflight.reason}`);
    return false;
  }

  const outputDir = path.join(homedir, 'CLI-Anything', appId, 'agent-harness');
  fs.mkdirSync(outputDir, { recursive: true });

  // Copy repl_skin.py to output utils dir
  const utilsDir = path.join(outputDir, 'cli_anything', appId, 'utils');
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.copyFileSync(replSkinPath, path.join(utilsDir, 'repl_skin.py'));

  // Private abort controller — never touches loop.ts module state
  const abortController = new AbortController();
  onRegisterCancel(() => abortController.abort());

  const client = new AnthropicClient(apiKey, resolveModelId('sonnet'));
  const systemPrompt = buildSystemPrompt(appId, preflight.harnessContent!, outputDir);

  // Get app version for context
  let versionInfo = '';
  try {
    const { stdout } = await execAsync(`${appId} --version 2>&1`, { timeout: 5000 });
    versionInfo = stdout.trim().split('\n')[0];
  } catch { /* non-fatal */ }

  const initialMessage = `Build a complete CLI-Anything harness for "${appId}"${versionInfo ? ` (${versionInfo})` : ''}.

Follow all 7 phases from HARNESS.md. The output goes to: ${outputDir}

Start with Phase 1: run \`${appId} --help\` and \`man ${appId}\` (if available) to understand the app.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialMessage },
  ];

  // Get tool schemas for CORE tools only
  const allTools = getToolsForGroup('full');
  const harnessToolSchemas = allTools.filter(t => HARNESS_TOOLS.includes(t.name));

  let installed = false;
  const startMs = Date.now();

  onProgress(`Building CLI harness for ${appId}... (this takes several minutes)`);

  for (let iteration = 0; iteration < HARNESS_MAX_ITERATIONS; iteration++) {
    if (abortController.signal.aborted) {
      onProgress(`[Harness] Generation cancelled.`);
      break;
    }
    if (Date.now() - startMs > HARNESS_MAX_MS) {
      onProgress(`[Harness] Generation timed out after 12 minutes.`);
      break;
    }

    let response: Awaited<ReturnType<typeof client.chat>>;
    try {
      response = await client.chat(
        messages,
        harnessToolSchemas,
        systemPrompt,
        '',
        (text) => {
          // Forward LLM narration to user in real time
          if (text.trim()) onProgress(text);
        },
        { signal: abortController.signal },
      );
    } catch (err: any) {
      if (abortController.signal.aborted) break;
      console.error(`[Harness] LLM error at iteration ${iteration}:`, err.message);
      break;
    }

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const responseText = textBlocks.map(b => b.text).join('');

    // Check for success signal
    if (responseText.includes('[HARNESS_INSTALLED_SUCCESS]')) {
      installed = true;
      onProgress(`✓ CLI harness for ${appId} installed successfully!`);
      break;
    }

    // No tools = final answer
    if (toolUseBlocks.length === 0) {
      console.log(`[Harness] No tool calls at iteration ${iteration} — stopping.`);
      break;
    }

    messages.push({ role: 'assistant', content: response.content as any });

    // Execute tools sequentially (order matters for file creation)
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      if (!HARNESS_TOOLS.includes(toolUse.name)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `[Error] Tool "${toolUse.name}" not available in harness mode.`,
        });
        continue;
      }
      let result: string;
      try {
        result = await executeTool(toolUse.name, toolUse.input as any);
      } catch (err: any) {
        result = `[Error] ${err.message}`;
      }
      console.log(`[Harness] ${toolUse.name}: ${result.slice(0, 100)}`);
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults as any });
  }

  // Update registry if installed
  if (installed) {
    try {
      // Discover commands
      let commands: string[] | undefined;
      try {
        const { stdout } = await execAsync(
          `cli-anything-${appId} --help 2>/dev/null | grep -E '^  [a-z]' | awk '{print $1}'`,
          { timeout: 5000 },
        );
        const parsed = stdout.trim().split('\n').filter(Boolean);
        if (parsed.length > 0) commands = parsed;
      } catch { /* non-fatal */ }

      // Find SKILL.md
      let skillContent: string | undefined;
      const skillPath = path.join(outputDir, 'cli_anything', appId, 'skills', 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        skillContent = fs.readFileSync(skillPath, 'utf-8');
      }

      const existingProfile = getAppProfile(appId);
      if (existingProfile) {
        existingProfile.cliAnything = {
          command: `cli-anything-${appId}`,
          installed: true,
          commands,
          skillPath: fs.existsSync(skillPath) ? skillPath : undefined,
          skillContent,
        };
        if (!existingProfile.availableSurfaces.includes('cli_anything')) {
          existingProfile.availableSurfaces.unshift('cli_anything');
        }
        existingProfile.lastScanned = new Date().toISOString();
        updateAppProfile(existingProfile);
      } else {
        const newProfile: AppProfile = {
          appId,
          displayName: appId.charAt(0).toUpperCase() + appId.slice(1),
          binaryPath: appId,
          availableSurfaces: ['cli_anything', 'native_cli', 'gui'],
          cliAnything: {
            command: `cli-anything-${appId}`,
            installed: true,
            commands,
            skillPath: fs.existsSync(skillPath) ? skillPath : undefined,
            skillContent,
          },
          windowMatcher: appId,
          confidence: 0.8,
          lastScanned: new Date().toISOString(),
        };
        updateAppProfile(newProfile);
      }
      console.log(`[Harness] Registry updated for ${appId}`);
    } catch (err: any) {
      console.warn(`[Harness] Registry update failed: ${err.message}`);
    }
  }

  return installed;
}
```

- [ ] **Step 4: Run harness tests — expect pass**

```bash
cd /home/dp/Desktop/clawdia4.0
npx ts-node --project tsconfig.main.json tests/test-loop-harness.ts
```

Expected:
```
✓ preflight fails with missing HARNESS.md
✓ preflight passes when both files exist
All loop-harness tests passed
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/agent/loop-harness.ts tests/test-loop-harness.ts
git commit -m "feat: add loop-harness — nested 7-phase CLI-Anything generation pipeline"
```

---

## Task 4: Wire everything into `loop-setup.ts`

**Files:**
- Modify: `src/main/agent/loop-setup.ts`

- [ ] **Step 1: Update `runPreLLMSetup` signature**

In `src/main/agent/loop-setup.ts`, change the function signature from:

```typescript
export async function runPreLLMSetup(
  userMessage: string,
  profile: TaskProfile,
): Promise<SetupResult>
```

To:

```typescript
export async function runPreLLMSetup(
  userMessage: string,
  profile: TaskProfile,
  apiKey: string,
  onProgress?: (text: string) => void,
): Promise<SetupResult>
```

- [ ] **Step 2: Add imports**

At the top of `loop-setup.ts`, add:

```typescript
import { installApp } from './loop-app-install';
import { runHarnessPipeline } from './loop-harness';
import { registerNestedCancel, clearNestedCancel } from './loop-cancel';
import { getAppProfile } from '../db/app-registry';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function cmdExists(cmd: string): Promise<boolean> {
  try {
    await execAsync(`which ${cmd} 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Add install + harness checks inside the desktop setup branch**

Find the block inside `runPreLLMSetup` that starts with `if (targetApp) {` and add the install/harness checks BEFORE the existing `routeTask` call:

```typescript
if (targetApp) {
  // ── NEW: Install app if binary is missing ──
  const binaryMissing = !(await cmdExists(targetApp));
  if (binaryMissing) {
    onProgress?.(`Installing ${targetApp}...`);
    await installApp(targetApp, onProgress ?? (() => {}));
  }

  // ── NEW: Generate harness if none exists ──
  const existingProfile = getAppProfile(targetApp);
  const hasHarness = existingProfile?.cliAnything?.installed === true;
  if (!hasHarness) {
    onProgress?.(`No CLI harness found for ${targetApp} — building one now. This takes a few minutes...`);
    const built = await runHarnessPipeline(targetApp, {
      apiKey,
      onProgress: onProgress ?? (() => {}),
      onRegisterCancel: registerNestedCancel,
    });
    clearNestedCancel();
    if (!built) {
      onProgress?.(`Harness generation failed — falling back to available surfaces.`);
    }
  }

  // ── EXISTING: Route (now reads updated profile from SQLite) ──
  result.executionPlan = routeTask(userMessage, targetApp);
  // ... rest of existing code unchanged
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/loop-setup.ts
git commit -m "feat: wire app install + harness generation into loop-setup pre-LLM phase"
```

---

## Task 5: Update `loop.ts` call site

**Files:**
- Modify: `src/main/agent/loop.ts`

- [ ] **Step 1: Pass `apiKey` and `onProgress` to `runPreLLMSetup`**

Find the existing call to `runPreLLMSetup` in `runAgentLoop`:

```typescript
const setup = await runPreLLMSetup(userMessage, profile);
```

Change it to:

```typescript
const setup = await runPreLLMSetup(userMessage, profile, apiKey, options.onProgress);
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main/agent/loop.ts
git commit -m "feat: pass apiKey and onProgress to runPreLLMSetup"
```

---

## Task 6: Wire `onProgress` in the renderer/main IPC layer

**Files:**
- Modify: `src/main/main.ts` (or wherever `runAgentLoop` is called)

- [ ] **Step 1: Find the `runAgentLoop` call site**

```bash
grep -n "runAgentLoop" /home/dp/Desktop/clawdia4.0/src/main/main.ts
```

- [ ] **Step 2: Add `onProgress` to the options object**

Find the options object passed to `runAgentLoop`. It will have `onStreamText`. Add `onProgress` pointing to the same IPC channel:

```typescript
onProgress: (text: string) => {
  // Route to the same stream channel as onStreamText
  routeEvent(processId, IPC_EVENTS.CHAT_STREAM_TEXT, text);
},
```

This reuses the existing renderer streaming — progress narration appears inline with the response.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc -p tsconfig.main.json --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Build the app**

```bash
cd /home/dp/Desktop/clawdia4.0
npm run build:main 2>&1 | tail -20
```

Expected: successful build, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/main.ts
git commit -m "feat: wire onProgress to chat stream IPC channel in main.ts"
```

---

## Task 7: End-to-end smoke test

Manual test to verify the full pipeline works. No automated test — this requires real LLM calls.

- [ ] **Step 1: Start the app in dev mode**

```bash
cd /home/dp/Desktop/clawdia4.0
npm run dev
```

- [ ] **Step 2: Send this prompt in Clawdia**

> Use Shotcut to trim the first 5 seconds from ~/Desktop/test.mp4

(Shotcut has a pre-built harness in the CLI-Anything repo. If `~/Desktop/test.mp4` doesn't exist, create a dummy: `ffmpeg -f lavfi -i color=c=blue:s=320x240:d=10 ~/Desktop/test.mp4`)

- [ ] **Step 3: Observe console output**

Check developer console (Ctrl+Shift+I) for:
```
[Setup] app discovery: → shotcut
[Harness] Building CLI harness for shotcut...
[Harness] Phase 1: Analyzing shotcut architecture...
...
[Harness] ✓ CLI harness for shotcut installed successfully!
[Router] App: shotcut → surface: cli_anything
[Agent] Tool #1: shell_exec(cli-anything-shotcut ...)
```

- [ ] **Step 4: Verify no `gui_interact` calls appear**

In the tool activity log in the Clawdia UI, confirm zero `gui_interact` calls for the task.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: CLI-Anything auto-install + harness generation pipeline complete"
```

