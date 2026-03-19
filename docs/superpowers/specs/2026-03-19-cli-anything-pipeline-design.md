# CLI-Anything Auto-Install + Harness Generation Pipeline

**Date:** 2026-03-19
**Status:** Approved

---

## Overview

When a user asks Clawdia to do something with an app it doesn't have a CLI harness for — or that isn't even installed — Clawdia handles the full pipeline autonomously before executing the task:

1. Install the app (if missing) via system package manager
2. Generate a full CLI-Anything harness (7-phase methodology)
3. Install the harness to PATH
4. Execute the original task using the new harness

The user sees narrated progress throughout. By the time the main agent loop runs, the harness is ready.

---

## Architecture

### Entry Point: `loop-setup.ts`

`runPreLLMSetup` gains two new parameters (`apiKey` and `onProgress`) and two new checks after app detection:

```
detect app name
  → if app binary missing → installApp(appId, onProgress)
  → if no cli_anything harness → runHarnessPipeline(appId, { apiKey, onProgress })
  → call updateAppProfile() directly (NOT scanHarnesses — see below)
  → re-route execution plan via routeTask() — reads updated profile from SQLite
  → continue as normal
```

Both checks narrate progress via `onProgress(text)` → `onStreamText` so the user sees what's happening in real time.

### Signature Change: `runPreLLMSetup`

```typescript
// Before
export async function runPreLLMSetup(
  userMessage: string,
  profile: TaskProfile,
): Promise<SetupResult>

// After
export async function runPreLLMSetup(
  userMessage: string,
  profile: TaskProfile,
  apiKey: string,
  onProgress?: (text: string) => void,
): Promise<SetupResult>
```

The call site in `loop.ts` must pass `apiKey` and `options.onProgress` through.

### New File: `src/main/agent/loop-harness.ts`

Single exported function:

```typescript
export async function runHarnessPipeline(
  appId: string,
  options: HarnessPipelineOptions,
): Promise<boolean>  // true = harness installed successfully

interface HarnessPipelineOptions {
  apiKey: string;
  onProgress: (text: string) => void;
  onRegisterCancel: (fn: () => void) => void;  // loop-harness calls this with its private abort fn
}
```

Internally this runs a **nested agent loop** using `AnthropicClient` with the `sonnet` model (hardcoded — generation quality is more important than user model preference here; this is an explicit, deliberate choice). It does NOT call `runAgentLoop` recursively and does NOT touch the module-level abort/pause state in `loop.ts`.

### New File: `src/main/agent/loop-app-install.ts`

```typescript
export async function installApp(
  appId: string,
  onProgress: (text: string) => void,
): Promise<boolean>  // true = installed successfully
```

---

## Abort Controller Isolation

The nested loop in `loop-harness.ts` maintains a **private, non-exported** `AbortController`. It never reads or writes `activeAbortController` from `loop.ts`.

To support user cancellation during harness generation, `loop.ts` exposes a registration hook:

```typescript
// In loop.ts — alongside existing cancelLoop()
type NestedCancelFn = () => void;
let nestedCancelFn: NestedCancelFn | null = null;

export function registerNestedCancel(fn: NestedCancelFn): void {
  nestedCancelFn = fn;
}
export function clearNestedCancel(): void {
  nestedCancelFn = null;
}

// cancelLoop() extended:
export function cancelLoop(): void {
  activeAbortController?.abort();
  nestedCancelFn?.();          // cancel harness loop if running
  nestedCancelFn = null;
  if (pauseResolve) { pauseResolve(); pauseResolve = null; }
  isPaused = false;
}
```

`loop-harness.ts` calls `registerNestedCancel` when it starts and `clearNestedCancel` when it finishes.

---

## Wall-Time Budget

`startTime` in `loop.ts` is moved to **after** `runPreLLMSetup` returns:

```typescript
// In loop.ts
const setup = await runPreLLMSetup(userMessage, profile, apiKey, options.onProgress);
const startTime = Date.now();  // ← moved here, was before setup
```

The nested harness loop has its own wall-time limit of **12 minutes** (kept under `MAX_WALL_MS` = 10 min outer limit, which now starts after setup). If harness generation exceeds 12 minutes, it aborts and returns `false`.

---

## App Installation (`loop-app-install.ts`)

Install strategy: **user-space first, then GUI-authenticated system install**. Never use bare `sudo` — it blocks on stdin with no TTY in the Electron main process.

```
1. Check if binary already on PATH — return true immediately if so
2. Try flatpak (user-space, no auth needed):
     flatpak install --user -y flathub <appId>   (timeout: 120s)
   → verify binary on PATH (also check `flatpak run <appId>` variant)
   → return true if successful
3. Try apt via pkexec (pops native GUI PolicyKit auth dialog):
     pkexec apt install -y <appId>               (timeout: 120s)
   → narrate: "A password dialog has appeared — please authenticate to install <appId>"
   → verify binary on PATH after install
   → return true if successful
4. Try snap via pkexec:
     pkexec snap install <appId>                 (timeout: 120s)
   → same narration pattern
5. If all fail: narrate with manual install command, return false
```

**`flatpak --user`** installs into `~/.local/share/flatpak` with no authentication. Try this first.

**`pkexec`** spawns a native GUI PolicyKit dialog — appropriate for a desktop Electron app. One auth prompt per install. Skip if `pkexec` not available (`which pkexec` fails).

Package manager availability (`which flatpak`, `which pkexec`, `which apt`, `which snap`) checked once and cached. All PM calls have explicit 120s timeouts. A failed install is non-fatal.

---

## Harness Generation Pipeline (`loop-harness.ts`)

### Pre-flight Check

Before starting the nested loop, verify:
- `HARNESS.md` exists at `~/CLI-Anything/cli-anything-plugin/HARNESS.md`
- `repl_skin.py` exists at `~/CLI-Anything/cli-anything-plugin/repl_skin.py`

If either is missing, return `false` immediately with a narrated message. Do not start a nested LLM loop with an empty system prompt.

### System Prompt

Built from:
- Full content of `HARNESS.md`
- Target app info (name, binary path, detected version from `--version`)
- Output directory: `~/CLI-Anything/<appId>/agent-harness/`
- Instruction to narrate each phase completion as a text response before proceeding

### The 7 Phases

The nested LLM runs these phases over multiple iterations, narrating each:

| Phase | What happens | Narration |
|-------|-------------|-----------|
| 1. Analyze | `shell_exec --help`, `man <app>`, inspect source if available | "Analyzing `<app>` architecture..." |
| 2. Design | LLM designs command groups, state model, output format | "Designing CLI structure..." |
| 3. Implement | LLM writes all Python modules via `file_write` | "Implementing core modules..." |
| 4. Test plan | LLM writes TEST.md part 1 | "Writing test plan..." |
| 5. Tests | LLM writes test files, runs `pytest` | "Writing and running tests..." |
| 6. SKILL.md | Runs `skill_generator.py`, writes SKILL.md | "Generating SKILL.md..." |
| 7. Install | `pip install -e .`, verifies `which cli-anything-<app>` | "Installing harness..." |

### Output Structure

Follows the existing CLI-Anything convention exactly:

```
~/CLI-Anything/<appId>/agent-harness/
  setup.py
  cli_anything/<appId>/
    __init__.py
    __main__.py
    <appId>_cli.py
    core/
    utils/
      repl_skin.py  (copied from plugin dir)
    skills/
      SKILL.md
    tests/
      TEST.md
      test_core.py
      test_full_e2e.py
```

### Nested Loop Tools

- Allowed: `shell_exec`, `file_write`, `file_read`, `file_edit`, `directory_tree`
- Not allowed: browser tools, memory tools, desktop tools, `app_control`, `gui_interact`
- Max 40 iterations, 12 min wall time
- Each LLM text response forwarded to `onProgress`

### Registry Update

On successful install (Phase 7 verified), call `updateAppProfile()` directly — **not** `scanHarnesses()`. The `scanHarnesses()` function has a session-level idempotency guard (`harnessScanned = true`) that is set during the initial `runPreLLMSetup` parallel phase. A subsequent call to `scanHarnesses()` will return immediately without scanning anything. `updateAppProfile()` writes directly to SQLite via `better-sqlite3` (synchronous), so the profile is immediately visible to the subsequent `routeTask()` call.

---

## Integration in `loop-setup.ts`

```typescript
// After targetApp is detected, inside the desktop setup branch:
if (targetApp) {
  // 1. Install app if binary missing
  const binaryMissing = !(await cmdExists(targetApp));
  if (binaryMissing) {
    onProgress?.(`Installing ${targetApp}...`);
    await installApp(targetApp, onProgress ?? (() => {}));
  }

  // 2. Generate harness if none exists
  // Note: getAppProfile returns null for unknown apps — hasHarness will be false,
  // which is the correct trigger. This check is only for generation gating,
  // not for routing (routing is owned entirely by routeTask below).
  const profile = getAppProfile(targetApp);
  const hasHarness = profile?.cliAnything?.installed === true;
  if (!hasHarness) {
    onProgress?.(`No CLI harness found for ${targetApp} — building one now. This takes a few minutes...`);
    // runHarnessPipeline creates its own private AbortController internally.
    // registerNestedCancel gives cancelLoop() a handle to abort it.
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

  // 3. Route — routeTask reads the updated profile from SQLite directly
  result.executionPlan = routeTask(userMessage, targetApp);
  console.log(`[Router] App: ${targetApp} → surface: ${result.executionPlan.selectedSurface}`);

  recordSurfaceUsage(result.executionPlan.selectedSurface);
  result.shortcutContext = getShortcutPromptBlock(targetApp);
  warmCoordinatesForApp(targetApp);
}
```

---

## `LoopOptions` Change

Add one field to the existing interface in `loop.ts`:

```typescript
export interface LoopOptions {
  // ... existing fields ...
  onProgress?: (text: string) => void;  // narration during pre-LLM setup phases
}
```

The renderer already handles `onStreamText` for streaming — `onProgress` maps to the same IPC channel, fired during setup instead of during LLM response.

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| HARNESS.md missing | Narrate, skip generation, fall back to native surface |
| App install fails (flatpak + pkexec both fail) | Narrate, advise manual install, continue with degraded surface |
| App install times out | Narrate timeout, continue |
| Harness generation fails or times out | Narrate failure, fall back |
| Harness installs but tests fail | Log warning, continue — harness is still usable |
| Nested loop hits iteration limit | Treat as failure, fall back |

All failures are non-fatal. The main loop always runs.

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/main/agent/loop-harness.ts` | **New** — nested agent loop for 7-phase generation, private abort controller, `registerNestedCancel`/`clearNestedCancel` calls |
| `src/main/agent/loop-app-install.ts` | **New** — package manager install: flatpak --user first, then pkexec apt/snap; explicit 120s timeouts; never bare sudo |
| `src/main/agent/loop-setup.ts` | Add `apiKey` + `onProgress` params to `runPreLLMSetup`; add install + harness checks after app detection |
| `src/main/agent/loop.ts` | Add `onProgress` to `LoopOptions`; add `registerNestedCancel`/`clearNestedCancel`/`nestedCancelFn` alongside existing `cancelLoop()`; extend `cancelLoop()` to fire nested cancel; move `startTime` to after `runPreLLMSetup` returns; update `runPreLLMSetup` call site to pass `apiKey` and `options.onProgress` |
| `src/main/db/app-registry.ts` | No change |

---

## Success Criteria

- "Install Kdenlive and create a project" → Clawdia installs Kdenlive, builds harness, executes task, all narrated
- "Use Shotcut to trim my video" (installed, no harness) → harness built, task executed
- "Open GIMP and resize this image" (harness already installed) → existing fast path, no change to behavior
- Harness generation failure → graceful fallback, user informed, task still attempted
- User cancels mid-harness → `cancelLoop()` fires nested cancel, both loops abort cleanly
