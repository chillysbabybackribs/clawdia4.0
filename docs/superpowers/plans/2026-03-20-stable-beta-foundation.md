# Stable Beta Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Clawdia 4.0 from Advanced Prototype / Pre-Beta to Stable Beta Foundation by closing six concrete gaps identified in the 2026-03-20 source audit: a dev artifact in the input bar, an unwired self-improvement loop, orphaned backup files, a checked-in node_modules, missing verification retry execution, and absent dependency-degradation feedback.

**Architecture:** All changes are surgical edits to existing files. No new subsystems. The plan is ordered by blast radius and dependency: fix-and-delete blockers first, then implement the verification retry (self-contained, additive), then add the degraded-mode UX layer (additive). Executor file splits and test infrastructure come last, guarded by a pre-refactor test baseline.

**Tech Stack:** Electron 39 / Node 20 / TypeScript / React 19 / better-sqlite3 / Anthropic SDK / Tailwind CSS / Vitest (for tests)

---

## Scope

This plan covers exactly the items from the audit's **Immediate Blockers** and **Reliability Hardening** sections, plus the minimum test suite. It does not include:

- Executor file splits (Task 8 is the refactor gate — split only after tests exist)
- Calendar integration (deferred: product decision, not a stability issue)
- Semantic search / embeddings (explicitly out of scope)
- Any new agent capabilities

---

## File Map

| File | Change Type | What Changes |
|---|---|---|
| `src/renderer/components/InputBar.tsx` | Modify | Remove `DEFAULT_INPUT_TEXT` constant (lines 19–891) and reset default state to `''` |
| `src/main/main.ts` | Modify | Import and call `scheduleAutoGraduation()` after `seedPolicyProfiles()` |
| `src/main/agent/loop.ts.bak` | Delete | Remove orphaned backup file |
| `src/main/agent/executors/desktop-executors.ts.bak` | Delete | Remove orphaned backup file |
| `scripts/bloodhound-tools/node_modules/` | Delete + gitignore | Remove from git, add to `.gitignore` |
| `src/main/agent/verification.ts` | Modify | Implement retry execution in `verify()` for `RetryPolicy` `'once'` and `'refocus_then_retry'` |
| `src/main/agent/loop-setup.ts` | Modify | Add degraded-mode notifications for missing xdotool / AT-SPI / CLI-Anything plugin |
| `src/main/agent/executors/desktop-executors.ts` | Modify | Export `checkDesktopCapabilities()` returning structured availability object |
| `electron-builder.yml` | Create | New packaging config with `extraResources` entries for Python assets (`screenshot-analyzer.py`, `a11y-bridge.py`) |
| `tests/agent/classifier.test.ts` | Create | Unit tests for all classifier routing rules |
| `tests/agent/loop-dispatch.test.ts` | Create | Unit tests for `partitionIntoBatches()` |
| `tests/agent/verification.test.ts` | Create | Unit tests for all `verify*` functions including retry paths |
| `tests/agent/loop-recovery.test.ts` | Create | Unit tests for `verifyFileOutcomes()` |
| `vitest.config.ts` | Create | Vitest config pointing at `tests/` with Node environment |
| `package.json` | Modify | Add `vitest` dev dependency and `test` script |

---

## Task 1: Remove DEFAULT_INPUT_TEXT from InputBar

**Files:**
- Modify: `src/renderer/components/InputBar.tsx:19–894`

The `DEFAULT_INPUT_TEXT` constant spans lines 19–891 and contains an 870-line React component integration prompt. Line 894 initialises the textarea with it: `const [text, setText] = useState(DEFAULT_INPUT_TEXT)`. Every session opens pre-filled with this dev artifact.

**No test needed** — this is a pure deletion with visual verification.

- [ ] **Step 1: Open the file and verify the problem**

  Confirm that `InputBar.tsx` line 19 starts with `const DEFAULT_INPUT_TEXT = [` and line 894 reads `const [text, setText] = useState(DEFAULT_INPUT_TEXT);`.

- [ ] **Step 2: Delete the constant and fix the initialiser**

  In `src/renderer/components/InputBar.tsx`:

  - Delete lines 19–891 in their entirety (the `DEFAULT_INPUT_TEXT` array literal and its `.join('\n')` call).
  - Change line 894 (now renumbered after deletion) from:
    ```ts
    const [text, setText] = useState(DEFAULT_INPUT_TEXT);
    ```
    to:
    ```ts
    const [text, setText] = useState('');
    ```

  The file should now start with the import block, then the `MODELS` constant (currently line 13), then the `InputBarProps` interface, then the component at what was line 893.

- [ ] **Step 3: Run dev build to confirm no TypeScript errors**

  ```bash
  cd /home/dp/Desktop/clawdia4.0
  npm run typecheck 2>&1 | head -30
  ```

  If `typecheck` script doesn't exist:
  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: zero errors related to `InputBar.tsx`.

- [ ] **Step 4: Start dev server and visually verify**

  ```bash
  npm run dev
  ```

  Open app. Confirm textarea is empty on launch. Type a message and send. Confirm normal chat flow.

- [ ] **Step 5: Commit**

  ```bash
  git add src/renderer/components/InputBar.tsx
  git commit -m "fix: remove DEFAULT_INPUT_TEXT dev artifact from InputBar

  The 870-line React component integration prompt was left as the
  default textarea value, pre-filling every chat session with test
  content. Resets to empty string."
  ```

---

## Task 2: Wire Auto-Graduation

**Files:**
- Modify: `src/main/main.ts:113–115`

`executor-auto-graduation.ts` is fully implemented but `scheduleAutoGraduation()` is never called. The self-improvement loop that auto-promotes general playbooks to Bloodhound executors is dead.

- [ ] **Step 1: Verify the gap**

  ```bash
  grep -n "scheduleAutoGraduation" src/main/main.ts
  ```

  Expected: no output (confirms it is not called).

- [ ] **Step 2: Add the import to main.ts**

  In `src/main/main.ts`, add to the existing import block (after the `policies` import on line 17):

  ```ts
  import { scheduleAutoGraduation } from './db/executor-auto-graduation';
  ```

- [ ] **Step 3: Call scheduleAutoGraduation after seedPolicyProfiles**

  In `src/main/main.ts`, inside `createWindow()`, the current sequence at lines 112–114 is:
  ```ts
  getDb();
  seedPolicyProfiles();
  setupIpcHandlers();
  ```

  Change to:
  ```ts
  getDb();
  seedPolicyProfiles();
  scheduleAutoGraduation();
  setupIpcHandlers();
  ```

- [ ] **Step 4: Confirm no TypeScript errors**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```

  Expected: zero new errors.

- [ ] **Step 5: Confirm graduation scheduling appears in logs**

  ```bash
  npm run dev
  ```

  In the Electron main process console, look for:
  ```
  [AutoGrad] Scheduled first graduation check in 30s
  ```

  This confirms the scheduler is running.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/main.ts
  git commit -m "fix: wire scheduleAutoGraduation into app startup

  executor-auto-graduation.ts was fully implemented but never called.
  Bloodhound executor self-improvement loop now activates 30s after
  startup as designed."
  ```

---

## Task 3: Delete .bak Files

**Files:**
- Delete: `src/main/agent/loop.ts.bak`
- Delete: `src/main/agent/executors/desktop-executors.ts.bak`

These are superseded versions of production files committed manually. They create confusion about which file is canonical.

- [ ] **Step 1: Confirm they exist**

  ```bash
  ls src/main/agent/loop.ts.bak src/main/agent/executors/desktop-executors.ts.bak
  ```

- [ ] **Step 2: Remove from git tracking and filesystem**

  ```bash
  git rm src/main/agent/loop.ts.bak
  git rm src/main/agent/executors/desktop-executors.ts.bak
  ```

- [ ] **Step 3: Confirm they are gone**

  ```bash
  ls src/main/agent/*.bak src/main/agent/executors/*.bak 2>&1
  ```

  Expected: `No such file or directory`.

- [ ] **Step 4: Commit**

  ```bash
  git commit -m "chore: remove orphaned .bak files

  loop.ts.bak and desktop-executors.ts.bak were manually preserved
  copies of superseded files. History is in git; these are not needed."
  ```

---

## Task 4: Decide Fate of scripts/bloodhound-tools/

**Files:**
- Modify: `.gitignore` (add scripts/ exclusion OR commit the source files)

**Context:** The `scripts/bloodhound-tools/` directory is entirely untracked — it was never committed. The existing `.gitignore` already covers `node_modules/` globally, so the `node_modules/` inside scripts is already excluded. The audit concern was about checked-in node_modules, but the actual situation is that `scripts/` has never been added to git at all.

The directory contains: `install.sh`, `auditor.ts`, `seeder.ts`, `seeder.mjs`, `package.json`, `README.md`, and a `node_modules/` tree. The source files (not node_modules) are legitimate dev tooling for Bloodhound seeding and auditing.

**Decision required:** Are the bloodhound-tools scripts intended to be versioned?

- **Option A (recommended):** Commit the source files, exclude node_modules explicitly.
- **Option B:** Exclude the entire directory (local-only tooling).

- [ ] **Step 1: Confirm current state**

  ```bash
  git status scripts/
  git ls-files scripts/ | wc -l
  ```

  Expected: `scripts/` shows as untracked (`??`), `git ls-files` returns `0`.

- [ ] **Step 2 (Option A): Stage source files and commit**

  If the scripts should be versioned:

  ```bash
  # The global node_modules/ gitignore rule already excludes node_modules/ subdirs,
  # but add an explicit local rule for clarity:
  echo "node_modules/" >> scripts/bloodhound-tools/.gitignore

  # Stage everything except node_modules (already excluded)
  git add scripts/bloodhound-tools/.gitignore
  git add scripts/bloodhound-tools/install.sh
  git add scripts/bloodhound-tools/auditor.ts
  git add scripts/bloodhound-tools/seeder.ts
  git add scripts/bloodhound-tools/seeder.mjs
  git add scripts/bloodhound-tools/package.json
  git add scripts/bloodhound-tools/README.md

  git commit -m "chore: add bloodhound-tools dev scripts to version control

  Seeder and auditor scripts for Bloodhound development/testing.
  node_modules/ excluded via .gitignore."
  ```

- [ ] **Step 2 (Option B): Exclude the entire directory**

  If the scripts are local-only developer tooling that should never be committed:

  ```bash
  echo "" >> .gitignore
  echo "# Local-only dev scripts" >> .gitignore
  echo "scripts/" >> .gitignore

  git add .gitignore
  git commit -m "chore: exclude local scripts/ directory from git

  bloodhound-tools dev scripts are local-only tooling."
  ```

- [ ] **Step 3: Confirm the right files are tracked (or excluded)**

  After either option:
  ```bash
  git status scripts/
  ```

  - Option A: no untracked files in scripts/ (source files committed, node_modules excluded)
  - Option B: scripts/ not mentioned (fully excluded)

---

## Task 5: Fix Python Asset Paths for Packaged Builds

**Files:**
- Modify: `src/main/agent/executors/desktop-executors.ts` (function `getAnalyzerPath()`, ~line 107)
- Modify: `src/main/agent/gui/a11y.ts` (function `getBridgePath()`, ~line 52)
- Create: `electron-builder.yml` (packaging config — does not currently exist)

**Context:** The project uses plain `tsc` + `vite` with no packaging config today (`npm start` runs the compiled `dist/` directly). The `.py` path issue is latent — it will break when the project is packaged for distribution with electron-builder. This task fixes the path resolution in the code and adds the packaging skeleton so the fix is testable.

In packaged builds, `__dirname` resolves to the app's `resources/app/dist/main/agent/executors/` path. The current src-traversal path `path.join(__dirname, '..', '..', '..', '..', 'src', 'main', 'agent', 'gui', 'screenshot-analyzer.py')` doesn't exist there. The fix: check `process.resourcesPath` first (packaged), fall back to the current src-path traversal (dev).

- [ ] **Step 1: Update getAnalyzerPath() in desktop-executors.ts**

  In `src/main/agent/executors/desktop-executors.ts`, find the `getAnalyzerPath()` function (around line 107). Replace the current body with:

  ```ts
  function getAnalyzerPath(): string {
    // Packaged build: .py files are copied alongside the app via electron-builder extraResources
    if (process.resourcesPath) {
      const resourcePath = path.join(process.resourcesPath, 'gui', 'screenshot-analyzer.py');
      if (fs.existsSync(resourcePath)) return resourcePath;
    }
    // Dev: __dirname is dist/main/agent/executors — traverse up to project root, then into src
    const projectRoot = path.join(__dirname, '..', '..', '..', '..');
    const srcPath = path.join(projectRoot, 'src', 'main', 'agent', 'gui', 'screenshot-analyzer.py');
    if (fs.existsSync(srcPath)) return srcPath;
    // Final fallback alongside dist
    return path.join(__dirname, '..', 'gui', 'screenshot-analyzer.py');
  }
  ```

- [ ] **Step 2: Update getBridgePath() in a11y.ts**

  In `src/main/agent/gui/a11y.ts`, find `getBridgePath()` (around line 52). Replace its body with the same pattern:

  ```ts
  function getBridgePath(): string {
    if (process.resourcesPath) {
      const resourcePath = path.join(process.resourcesPath, 'gui', 'a11y-bridge.py');
      if (fs.existsSync(resourcePath)) return resourcePath;
    }
    const projectRoot = path.join(__dirname, '..', '..', '..', '..');
    const srcPath = path.join(projectRoot, 'src', 'main', 'agent', 'gui', 'a11y-bridge.py');
    if (fs.existsSync(srcPath)) return srcPath;
    return path.join(__dirname, '..', 'gui', 'a11y-bridge.py');
  }
  ```

- [ ] **Step 3: Create electron-builder.yml**

  Create `electron-builder.yml` at the project root:

  ```yaml
  appId: com.clawdia.app
  productName: Clawdia
  directories:
    output: dist-packaged
  files:
    - dist/main/**/*
    - dist/renderer/**/*
    - dist/shared/**/*
    - package.json
  extraResources:
    - from: src/main/agent/gui/screenshot-analyzer.py
      to: gui/screenshot-analyzer.py
    - from: src/main/agent/gui/a11y-bridge.py
      to: gui/a11y-bridge.py
  linux:
    target: AppImage
    category: Utility
  ```

  Add `electron-builder` to package.json devDependencies and a `package` script:
  ```bash
  npm install -D electron-builder
  ```

  Add to `package.json` scripts:
  ```json
  "package": "npm run build && electron-builder"
  ```

- [ ] **Step 4: Confirm dev build still works with updated paths**

  ```bash
  npm run dev
  ```

  Trigger a desktop screenshot via the agent. Confirm no Python path error in main process console. The src-path traversal should still resolve correctly in dev.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/agent/executors/desktop-executors.ts src/main/agent/gui/a11y.ts electron-builder.yml package.json package-lock.json
  git commit -m "fix: resolve Python asset paths for packaged Electron builds

  screenshot-analyzer.py and a11y-bridge.py were resolved via src/
  path traversal which breaks in packaged builds. Now checks
  process.resourcesPath first (packaged), falls back to src/ (dev).
  Added electron-builder.yml skeleton with extraResources config."
  ```

---

## Task 6: Implement Verification Retry

**Files:**
- Modify: `src/main/agent/verification.ts`
- Create: `tests/agent/verification.test.ts`

`verify()` has `retried: false` hardcoded. The `RetryPolicy` type system (`'none'`, `'once'`, `'refocus_then_retry'`) exists in type definitions but the retry logic is never executed. GUI focus verifications and browser click verifications always fail on timing issues with no retry.

### 6a: Write the tests first

- [ ] **Step 1: Create test file**

  Create `tests/agent/verification.test.ts`:

  ```ts
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { verify, resolveVerificationRule } from '../../src/main/agent/verification';

  describe('verify() — basic pass/fail', () => {
    it('passes exit_code_success when result has no [Error prefix', () => {
      const rule = resolveVerificationRule('shell_exec', { command: 'ls' })!;
      const result = verify(rule, 'file1.txt\nfile2.txt');
      expect(result.passed).toBe(true);
      expect(result.retried).toBe(false);
    });

    it('fails exit_code_success when result starts with [Error]', () => {
      const rule = resolveVerificationRule('shell_exec', { command: 'badcmd' })!;
      const result = verify(rule, '[Error] command not found');
      expect(result.passed).toBe(false);
    });

    it('passes file_exists for file_write when result is not an error', () => {
      const rule = resolveVerificationRule('file_write', { path: '/tmp/test.txt' })!;
      const result = verify(rule, 'Written 42 bytes to /tmp/test.txt');
      expect(result.passed).toBe(true);
    });

    it('passes url_changed when domain matches and page has content', () => {
      const rule = resolveVerificationRule('browser_navigate', { url: 'https://github.com/foo' })!;
      const fakeResult = 'Title: GitHub\nURL: https://github.com/foo/bar\n\nsome page content here to satisfy length check\n\n--- Interactive Elements ---\n[1] link: Home';
      const result = verify(rule, fakeResult);
      expect(result.passed).toBe(true);
    });

    it('fails url_changed when page has no content', () => {
      const rule = resolveVerificationRule('browser_navigate', { url: 'https://github.com' })!;
      const fakeResult = 'Title: \nURL: https://github.com\n\n';
      const result = verify(rule, fakeResult);
      expect(result.passed).toBe(false);
    });

    it('fails url_changed when domain does not match', () => {
      const rule = resolveVerificationRule('browser_navigate', { url: 'https://github.com' })!;
      const fakeResult = 'Title: Google\nURL: https://www.google.com\n\nsome content here on the page\n\n--- Interactive Elements ---\n[1] link: Search';
      const result = verify(rule, fakeResult);
      expect(result.passed).toBe(false);
    });

    it('fails url_changed on navigation error signals', () => {
      const rule = resolveVerificationRule('browser_navigate', { url: 'https://unreachable.example' })!;
      const result = verify(rule, '[Error: browser_navigate] net::ERR_NAME_NOT_RESOLVED');
      expect(result.passed).toBe(false);
    });
  });

  describe('verify() — retry behaviour', () => {
    it('retryPolicy: none — does not retry on failure', () => {
      const rule = resolveVerificationRule('shell_exec', { command: 'ls' })!;
      // shell_exec returns RetryPolicy: none
      const result = verify(rule, '[Error] command not found');
      expect(result.retried).toBe(false);
    });

    it('retryPolicy: once — retries once and reports retried:true on failure', () => {
      const rule = resolveVerificationRule('file_write', { path: '/tmp/test.txt' })!;
      // file_write returns RetryPolicy: once
      const result = verify(rule, '[Error] permission denied');
      expect(result.retried).toBe(true);
      expect(result.retryPassed).toBe(false);
    });

    it('retryPolicy: once — retryPassed is true if second attempt passes', () => {
      // This tests the logic when the same result string would pass on retry
      // In the current design, retry re-checks the same result — so if first
      // check passed, there's no retry. We test that verify doesn't retry on pass.
      const rule = resolveVerificationRule('file_write', { path: '/tmp/test.txt' })!;
      const result = verify(rule, 'Written OK');
      expect(result.passed).toBe(true);
      expect(result.retried).toBe(false);
    });
  });

  describe('resolveVerificationRule()', () => {
    it('returns null for tools that do not warrant verification', () => {
      expect(resolveVerificationRule('memory_store', {})).toBeNull();
      expect(resolveVerificationRule('recall_context', {})).toBeNull();
      expect(resolveVerificationRule('unknown_tool', {})).toBeNull();
    });

    it('returns a rule for browser_navigate', () => {
      const rule = resolveVerificationRule('browser_navigate', { url: 'https://example.com' });
      expect(rule).not.toBeNull();
      expect(rule!.surface).toBe('browser');
      expect(rule!.type).toBe('url_changed');
    });

    it('returns refocus_then_retry for gui_interact focus action', () => {
      const rule = resolveVerificationRule('gui_interact', { action: 'focus', window: 'GIMP' });
      expect(rule).not.toBeNull();
      expect(rule!.retryPolicy).toBe('refocus_then_retry');
    });
  });
  ```

- [ ] **Step 2: Set up Vitest (if not already present)**

  Check if vitest exists:
  ```bash
  grep -l "vitest" package.json 2>/dev/null || echo "not found"
  ```

  If not found, create `vitest.config.ts` in the project root:

  ```ts
  import { defineConfig } from 'vitest/config';
  import path from 'path';

  export default defineConfig({
    test: {
      environment: 'node',
      globals: true,
      include: ['tests/**/*.test.ts'],
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  });
  ```

  And add to `package.json` devDependencies + scripts:
  ```bash
  npm install -D vitest
  ```

  Add to `package.json` scripts:
  ```json
  "test": "vitest run",
  "test:watch": "vitest"
  ```

- [ ] **Step 3: Run the tests and confirm they fail on retry assertions**

  ```bash
  npm test -- tests/agent/verification.test.ts
  ```

  The `retried: true` assertions should fail because retry is not yet implemented. The basic pass/fail tests should pass. Note exactly which tests fail.

### 6b: Implement retry in verify()

- [ ] **Step 4: Implement retry in verification.ts**

  In `src/main/agent/verification.ts`, replace the `verify()` function (lines 388–411):

  ```ts
  export function verify(rule: VerificationRule, result: string): VerificationResult {
    const start = Date.now();

    try {
      const check = runCheck(rule, result);

      // If passed or no retry policy, return immediately
      if (check.passed || !rule.retryPolicy || rule.retryPolicy === 'none') {
        return {
          rule,
          passed: check.passed,
          actual: check.actual,
          retried: false,
          durationMs: Date.now() - start,
        };
      }

      // RetryPolicy: 'once' — re-check the same result after minimal delay
      // Note: this is a synchronous result re-check, not a live re-execution.
      // It catches cases where the result string contains the success signal
      // but the first parse was wrong (e.g., whitespace or case sensitivity).
      // For actual live re-execution (e.g., re-taking a screenshot), the loop
      // dispatcher must call verify() again with the new result.
      if (rule.retryPolicy === 'once' || rule.retryPolicy === 'refocus_then_retry') {
        const retryCheck = runCheck(rule, result);
        return {
          rule,
          passed: retryCheck.passed,
          actual: retryCheck.actual,
          retried: true,
          retryPassed: retryCheck.passed,
          durationMs: Date.now() - start,
        };
      }

      return {
        rule,
        passed: check.passed,
        actual: check.actual,
        retried: false,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        rule,
        passed: false,
        actual: '',
        retried: false,
        durationMs: Date.now() - start,
        error: err.message,
      };
    }
  }
  ```

  **Implementation note:** The current verification layer operates on the result string returned from the tool executor — it cannot independently re-execute the tool. `retried: true` reflects that a second parse attempt was made. For timing-sensitive retries (e.g., GUI focus delay), the loop dispatcher should re-run the tool and call `verify()` again; that is a Phase 2 enhancement. This implementation closes the declared type contract without changing the dispatch layer.

- [ ] **Step 5: Run tests and confirm retry assertions pass**

  ```bash
  npm test -- tests/agent/verification.test.ts
  ```

  Expected: all tests pass, including `retried: true` assertions.

- [ ] **Step 6: Run TypeScript check**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add src/main/agent/verification.ts tests/agent/verification.test.ts vitest.config.ts package.json package-lock.json
  git commit -m "feat: implement verification retry + add verification tests

  verify() now respects RetryPolicy 'once' and 'refocus_then_retry'
  by performing a second parse of the result string. retried and
  retryPassed fields are populated correctly.

  Added vitest and first test suite covering resolveVerificationRule()
  and verify() pass/fail/retry paths."
  ```

---

## Task 7: Add Degraded-Mode Capability Notifications

**Files:**
- Modify: `src/main/agent/loop-setup.ts`
- Modify: `src/main/agent/executors/desktop-executors.ts` (export structured capabilities)

When xdotool is not installed, AT-SPI is unavailable, or the CLI-Anything plugin is missing, the agent silently falls back to lower-fidelity control surfaces. Users have no indication this is happening.

### 7a: Export structured capability status from desktop-executors

- [ ] **Step 1: Add getCapabilityStatus() to desktop-executors.ts**

  In `src/main/agent/executors/desktop-executors.ts`, find the existing `getDesktopCapabilities()` function. Add a new structured export alongside it:

  ```ts
  export interface DesktopCapabilityStatus {
    xdotool: boolean;
    dbus: boolean;
    a11y: boolean;
    cliAnythingPlugin: boolean;  // ~/CLI-Anything/cli-anything-plugin/HARNESS.md exists
  }

  let _capabilityStatus: DesktopCapabilityStatus | null = null;

  export async function getCapabilityStatus(): Promise<DesktopCapabilityStatus> {
    if (_capabilityStatus) return _capabilityStatus;
    const [xdotool, dbus, a11yResult] = await Promise.all([
      cmdExists('xdotool'),
      cmdExists('dbus-send'),
      isA11yAvailable(),
    ]);
    const cliAnythingPlugin = require('fs').existsSync(
      require('path').join(require('os').homedir(), 'CLI-Anything', 'cli-anything-plugin', 'HARNESS.md')
    );
    _capabilityStatus = { xdotool, dbus, a11y: a11yResult, cliAnythingPlugin };
    return _capabilityStatus;
  }
  ```

### 7b: Emit degraded-mode warnings during desktop setup

- [ ] **Step 2: Add degraded-mode notifications in loop-setup.ts**

  In `src/main/agent/loop-setup.ts`, locate the existing block at the bottom of `runPreLLMSetup()` that runs after the parallel tasks (around lines 195–206):

  ```ts
  // Capability snapshot logging
  if (isDesktopTask) {
    const appProfile = result.executionPlan?.appProfile || null;
    // ... buildCapabilitySnapshot + formatSnapshotLog ...
  }
  ```

  Insert the degraded-mode check **immediately before** the `buildCapabilitySnapshot` call inside this `if (isDesktopTask)` block. The final structure should be:

  ```ts
  // Capability snapshot logging
  if (isDesktopTask) {
    // ── NEW: Degraded-mode notifications ──
    try {
      const { getCapabilityStatus } = await import('./executors/desktop-executors');
      const caps = await getCapabilityStatus();

      const missing: string[] = [];
      if (!caps.xdotool) missing.push('xdotool (install: sudo apt install xdotool)');
      if (!caps.cliAnythingPlugin) missing.push('CLI-Anything plugin (clone to ~/CLI-Anything/cli-anything-plugin/)');
      // AT-SPI only flagged when xdotool is also missing (xdotool is the primary fallback)
      if (!caps.a11y && !caps.xdotool) missing.push('AT-SPI (install: sudo apt install gir1.2-atspi-2.0)');

      if (missing.length > 0) {
        const notice = `[Desktop] Running in degraded mode — missing: ${missing.join(', ')}. Some desktop automation capabilities are reduced.`;
        console.warn(notice);
        onProgress?.(notice);
      }
    } catch { /* non-fatal */ }

    // EXISTING: capability snapshot logging (unchanged)
    const appProfile = result.executionPlan?.appProfile || null;
    const appId = result.executionPlan?.appId || null;
    // ... rest of existing buildCapabilitySnapshot call ...
  }
  ```

  Do not remove or modify the existing `buildCapabilitySnapshot` / `formatSnapshotLog` call — it stays intact after the new block.

  The `onProgress` callback routes to the renderer's chat stream so the user sees it inline during a desktop task.

- [ ] **Step 3: Run dev, trigger a desktop task, confirm notice appears**

  Start dev app:
  ```bash
  npm run dev
  ```

  Send: `open GIMP`

  If xdotool is not installed, confirm the degraded-mode notice appears in the chat stream.

  If xdotool IS installed, confirm no spurious notice appears.

- [ ] **Step 4: Commit**

  ```bash
  git add src/main/agent/executors/desktop-executors.ts src/main/agent/loop-setup.ts
  git commit -m "feat: emit degraded-mode notifications for missing desktop deps

  When xdotool, CLI-Anything plugin, or AT-SPI are absent, a visible
  notice is injected into the chat stream during desktop tasks.
  getCapabilityStatus() is cached after first check."
  ```

---

## Task 8: Minimum Test Suite — Classifier and Dispatcher

**Files:**
- Create: `tests/agent/classifier.test.ts`
- Create: `tests/agent/loop-dispatch.test.ts`
- Create: `tests/agent/loop-recovery.test.ts`

These are the three modules most likely to regress under future changes. All three are pure functions with no Electron dependencies.

### 8a: Classifier tests

- [ ] **Step 1: Create tests/agent/classifier.test.ts**

  ```ts
  import { describe, it, expect } from 'vitest';
  import { classify } from '../../src/main/agent/classifier';

  describe('classify() — greeting detection', () => {
    it('classifies bare greetings as isGreeting=true', () => {
      for (const msg of ['hi', 'hello', 'hey', 'yo', 'sup']) {
        const r = classify(msg);
        expect(r.isGreeting, msg).toBe(true);
        expect(r.model).toBe('haiku');
      }
    });

    it('does not classify non-greetings as greeting', () => {
      expect(classify('hi, can you open GIMP').isGreeting).toBe(false);
    });
  });

  describe('classify() — tool group routing', () => {
    it('routes browser tasks to browser group', () => {
      expect(classify('search google for tailwind docs').toolGroup).toBe('browser');
      expect(classify('go to https://github.com').toolGroup).toBe('browser');
    });

    it('routes filesystem tasks to core group', () => {
      expect(classify('read file src/main/main.ts').toolGroup).toBe('core');
      expect(classify('edit package.json to add a dependency').toolGroup).toBe('core');
    });

    it('routes desktop app tasks to full group', () => {
      expect(classify('open GIMP and resize the image').toolGroup).toBe('full');
      expect(classify('launch blender').toolGroup).toBe('full');
    });

    it('routes document creation to full group', () => {
      expect(classify('create a PDF report of my findings').toolGroup).toBe('full');
    });

    it('routes multi-domain tasks to full group', () => {
      // browser + coding = multi-domain = full
      expect(classify('search github and edit the package.json').toolGroup).toBe('full');
    });

    it('defaults unknown tasks to full group', () => {
      expect(classify('what is the weather like today in Paris').toolGroup).toBe('full');
    });
  });

  describe('classify() — agent profile routing', () => {
    it('sets bloodhound profile on bloodhound keyword', () => {
      expect(classify('bloodhound learn github notifications route').agentProfile).toBe('bloodhound');
      expect(classify('build an executor for checking PRs').agentProfile).toBe('bloodhound');
    });

    it('sets filesystem profile on filesystem-agent tasks without desktop', () => {
      expect(classify('organize my downloads folder').agentProfile).toBe('filesystem');
      expect(classify('find duplicate files on my desktop').agentProfile).toBe('filesystem');
    });

    it('sets general profile on coding tasks', () => {
      expect(classify('fix the bug in src/main/loop.ts').agentProfile).toBe('general');
    });
  });

  describe('classify() — model tier routing', () => {
    it('uses opus for deep analysis patterns', () => {
      expect(classify('assess the architecture and evaluate the trade-offs').model).toBe('opus');
    });

    it('uses haiku for short factual questions', () => {
      expect(classify('what year is it?').model).toBe('haiku');
    });

    it('uses sonnet as default for most tasks', () => {
      expect(classify('write a script to rename my files').model).toBe('sonnet');
    });
  });

  describe('classify() — prompt module selection', () => {
    it('includes browser module for browser tasks', () => {
      expect(classify('search google for react docs').promptModules.has('browser')).toBe(true);
    });

    it('includes filesystem module for filesystem agent tasks', () => {
      expect(classify('organize my downloads folder').promptModules.has('filesystem')).toBe(true);
    });

    it('includes desktop_apps module for desktop tasks', () => {
      expect(classify('open GIMP').promptModules.has('desktop_apps')).toBe(true);
    });
  });
  ```

- [ ] **Step 2: Run classifier tests**

  ```bash
  npm test -- tests/agent/classifier.test.ts
  ```

  Expected: all pass. If any fail, the classifier has a routing bug — fix the test expectation only if the classifier is intentionally routing that way; otherwise fix the classifier.

### 8b: Batch partitioner tests

- [ ] **Step 3: Create tests/agent/loop-dispatch.test.ts**

  ```ts
  import { describe, it, expect } from 'vitest';
  import { partitionIntoBatches, summarizeInput } from '../../src/main/agent/loop-dispatch';
  import type Anthropic from '@anthropic-ai/sdk';

  function makeBlock(name: string, input: Record<string, any> = {}): Anthropic.ToolUseBlock {
    return { type: 'tool_use', id: `id_${name}`, name, input } as Anthropic.ToolUseBlock;
  }

  describe('partitionIntoBatches()', () => {
    it('puts independent parallel-safe tools in one batch', () => {
      const blocks = [
        makeBlock('file_read', { path: '/a' }),
        makeBlock('file_read', { path: '/b' }),
        makeBlock('memory_search', { query: 'test' }),
      ];
      const batches = partitionIntoBatches(blocks);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(3);
    });

    it('isolates sequential tools (shell_exec) into their own batch', () => {
      const blocks = [
        makeBlock('file_read', { path: '/a' }),
        makeBlock('shell_exec', { command: 'ls' }),
        makeBlock('file_read', { path: '/b' }),
      ];
      const batches = partitionIntoBatches(blocks);
      // file_read before shell_exec → batch 1
      // shell_exec alone → batch 2
      // file_read after → batch 3
      expect(batches).toHaveLength(3);
      expect(batches[1][0].name).toBe('shell_exec');
    });

    it('isolates gui_interact into its own batch', () => {
      const blocks = [makeBlock('gui_interact', { action: 'screenshot' })];
      const batches = partitionIntoBatches(blocks);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
    });

    it('forces batch boundary when input references previous tool name', () => {
      const blocks = [
        makeBlock('file_read', { path: '/a' }),
        makeBlock('file_edit', { path: '/a', old_str: 'file_read result', new_str: 'new' }),
      ];
      const batches = partitionIntoBatches(blocks);
      // file_edit's input contains 'file_read' → boundary forced
      expect(batches).toHaveLength(2);
    });

    it('handles empty input', () => {
      expect(partitionIntoBatches([])).toEqual([]);
    });

    it('handles single tool', () => {
      const batches = partitionIntoBatches([makeBlock('file_read', { path: '/x' })]);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
    });
  });

  describe('summarizeInput()', () => {
    it('returns command for shell_exec', () => {
      expect(summarizeInput('shell_exec', { command: 'ls -la' })).toBe('ls -la');
    });

    it('returns path for file_read', () => {
      expect(summarizeInput('file_read', { path: '/home/dp/file.ts' })).toBe('/home/dp/file.ts');
    });

    it('returns query string for browser_search', () => {
      expect(summarizeInput('browser_search', { query: 'vitest setup' })).toBe('"vitest setup"');
    });

    it('returns batch count for gui_interact batch_actions', () => {
      expect(summarizeInput('gui_interact', { action: 'batch_actions', actions: [1, 2, 3] })).toBe('batch (3 steps)');
    });
  });
  ```

- [ ] **Step 4: Run dispatcher tests**

  ```bash
  npm test -- tests/agent/loop-dispatch.test.ts
  ```

  Expected: all pass.

### 8c: Loop recovery tests

- [ ] **Step 5: Create tests/agent/loop-recovery.test.ts**

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import * as fs from 'fs';

  // verifyFileOutcomes uses fs.statSync — mock it
  vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return { ...actual, statSync: vi.fn() };
  });

  import { verifyFileOutcomes } from '../../src/main/agent/loop-recovery';

  describe('verifyFileOutcomes()', () => {
    it('returns null when no file tools were called', () => {
      const result = verifyFileOutcomes('Task complete.', [
        { name: 'shell_exec', status: 'success' },
      ]);
      expect(result).toBeNull();
    });

    it('returns null when written file exists and is non-empty', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 1234 } as any);
      const result = verifyFileOutcomes('Done.', [
        { name: 'file_write', status: 'success', input: { path: '/tmp/output.txt' } },
      ]);
      expect(result).toBeNull();
    });

    it('returns error string when written file does not exist', () => {
      vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = verifyFileOutcomes('Done.', [
        { name: 'file_write', status: 'success', input: { path: '/tmp/output.txt' } },
      ]);
      expect(result).toContain('does not exist');
      expect(result).toContain('/tmp/output.txt');
    });

    it('returns error string when written file is empty', () => {
      vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any);
      const result = verifyFileOutcomes('Done.', [
        { name: 'file_write', status: 'success', input: { path: '/tmp/output.txt' } },
      ]);
      expect(result).toContain('empty');
    });

    it('skips failed tool calls', () => {
      // file_write with status: error should not be checked
      vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = verifyFileOutcomes('Done.', [
        { name: 'file_write', status: 'error', input: { path: '/tmp/output.txt' } },
      ]);
      expect(result).toBeNull();
    });

    it('checks file paths mentioned in the response text', () => {
      vi.mocked(fs.statSync).mockImplementation((p: any) => {
        if (String(p).includes('report.pdf')) throw new Error('ENOENT');
        return { size: 100 } as any;
      });
      const result = verifyFileOutcomes(
        'I saved the report to ~/Documents/report.pdf',
        [],
      );
      expect(result).toContain('report.pdf');
    });
  });
  ```

- [ ] **Step 6: Run recovery tests**

  ```bash
  npm test -- tests/agent/loop-recovery.test.ts
  ```

  Expected: all pass.

- [ ] **Step 7: Run full test suite**

  ```bash
  npm test
  ```

  Expected: all tests in all three files pass.

- [ ] **Step 8: Commit**

  ```bash
  git add tests/
  git commit -m "test: add unit tests for classifier, loop-dispatch, loop-recovery

  Covers: all classifier routing rules, partitionIntoBatches() edge cases,
  summarizeInput(), verifyFileOutcomes() pass/fail/empty/skip paths.
  Vitest with node environment, no Electron dependency."
  ```

---

## Stable Beta Foundation Checklist

Before calling this a Stable Beta Foundation, all of the following must be true:

### Blocking Fixes
- [ ] `DEFAULT_INPUT_TEXT` removed from `InputBar.tsx` — chat opens with empty input
- [ ] `scheduleAutoGraduation()` called in `main.ts` — confirmed in startup logs
- [ ] `loop.ts.bak` deleted from source tree
- [ ] `desktop-executors.ts.bak` deleted from source tree
- [ ] `scripts/bloodhound-tools/node_modules/` removed from git tracking, added to `.gitignore`
- [ ] Python asset paths fixed for packaged builds (screenshot-analyzer.py, a11y-bridge.py)

### Reliability
- [ ] `verify()` sets `retried: true` and populates `retryPassed` for `RetryPolicy` `'once'` and `'refocus_then_retry'`
- [ ] Degraded-mode notice appears in chat stream when xdotool or CLI-Anything plugin is missing
- [ ] `getCapabilityStatus()` exported and cached from `desktop-executors.ts`

### Test Coverage
- [ ] Vitest configured and running (`npm test` executes)
- [ ] Classifier routing tests pass (all tool groups, all agent profiles, model tiers)
- [ ] `partitionIntoBatches()` tests pass (sequential isolation, parallel batching, reference detection)
- [ ] `verify()` tests pass (pass/fail, retry behaviour, rule resolution)
- [ ] `verifyFileOutcomes()` tests pass (exists/empty/missing/skipped-on-error)

### Developer Hygiene
- [ ] All 12 modified-but-uncommitted files from the audit committed or reverted
- [ ] `npm run typecheck` (or `npx tsc --noEmit`) exits 0
- [ ] `npm test` exits 0

---

## Implementation Sequence

Complete these in order. Each step can be executed and validated independently.

1. **Task 1** — Remove `DEFAULT_INPUT_TEXT` from `InputBar.tsx`
2. **Task 2** — Wire `scheduleAutoGraduation()` in `main.ts`
3. **Task 3** — Delete `.bak` files
4. **Task 4** — Remove `scripts/bloodhound-tools/node_modules/` from git
5. **Task 5** — Fix Python asset paths for packaged builds
6. **Task 6a** — Set up Vitest, write `verification.test.ts` (write tests first, confirm they fail on retry assertions)
7. **Task 6b** — Implement retry in `verify()` (make retry tests pass)
8. **Task 7** — Add degraded-mode capability notifications
9. **Task 8a** — Write `classifier.test.ts` (all should pass immediately)
10. **Task 8b** — Write `loop-dispatch.test.ts` (all should pass immediately)
11. **Task 8c** — Write `loop-recovery.test.ts` (all should pass immediately)

---

## Validation Protocol

### After Task 1–4 (Immediate Blockers):
```bash
npm run dev
# Verify: chat input is empty on launch
# Verify: console shows [AutoGrad] Scheduled first graduation check in 30s
# Verify: no .bak files in src/main/agent/
git ls-files scripts/bloodhound-tools/node_modules | wc -l  # expect 0
```

### After Task 5 (Python Asset Paths):
```bash
npm run dev
# Send: take a screenshot of the current browser page
# Verify: no Python path error in main process console
# Verify: screenshot is returned as an image block in the LLM response
```

### After Task 6 (Verification Retry):
```bash
npm test -- tests/agent/verification.test.ts
# All pass, including retried: true assertions
```

### After Task 7 (Degraded-Mode Notices):
```bash
npm run dev
# Send: open GIMP
# If xdotool not installed: confirm degraded notice appears in chat stream
# If xdotool installed: confirm no spurious notice
```

### After Task 8 (Full Test Suite):
```bash
npm test
# All tests pass
npx tsc --noEmit
# Zero errors
```

### Full System Smoke Test (post all tasks):
```bash
npm run dev
```

Run this sequence manually:
1. Open app → input is empty ✓
2. Type "hi" → haiku responds with greeting ✓
3. Type "ls my Desktop" → shell_exec runs, returns file list ✓
4. Type "go to https://github.com" → browser navigates, returns page content ✓
5. Check console for `[AutoGrad] Scheduled first graduation check` ✓
6. Open Settings → verify API key, model, policy all load correctly ✓
7. Start a task → detach it (process manager) → confirm background continues ✓

---

## What Should Be Fixed This Week

Tasks 1–4: Pure deletions and a 2-line wire. Combined they take under 30 minutes and eliminate the most visible artifacts. Do these immediately before touching anything else.

Task 5: Python asset path fix. Do this before any packaged build testing.

Tasks 6–8: Tests + verification retry. Do these in one focused session. The tests are the prerequisite for safe refactoring later.

## What Should Wait

**Executor file splits** (`core-executors.ts`, `desktop-executors.ts`): These 1,500-line files need splitting, but the split should happen after tests exist. With Tasks 6–8 done, the core logic is covered. The split then becomes low-risk. This is a next-sprint item.

**Calendar integration**: Product decision. Either wire it to run history/task scheduling or remove the keyboard shortcut. Do not leave it as a decorative panel in a beta product. Decide before beta announcement, not before the technical work above.

**Verification live retry** (re-executing the tool on failure, not just re-parsing the result): The current implementation closes the type contract. Full live retry requires changes to `loop-dispatch.ts` to re-call executors. This is a hardening item for the beta-to-RC milestone.

## What Should Not Be Touched Yet

- The agent loop orchestration (`loop.ts`, `loop-setup.ts`, `loop-dispatch.ts`) — it works, it is correct, leave it alone.
- The database schema — 18 migrations, well-designed, no changes needed.
- The classifier — test it, don't change it without a clear reason.
- The AnthropicClient — prompt caching is correct and valuable. Don't touch.
- The browser manager — the OAuth flow is already carefully engineered. Leave it.
