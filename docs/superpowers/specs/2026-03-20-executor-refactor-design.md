# Executor Layer Refactor Design

**Date:** 2026-03-20
**Status:** Approved
**Scope:** `src/main/agent/executors/core-executors.ts` and `src/main/agent/executors/desktop-executors.ts`

---

## Problem

Both primary executor files have grown to ~1500 lines each, mixing unrelated responsibilities in a single module. This makes them hard to navigate, review, and extend safely.

- `core-executors.ts` (1516 lines): shell process management, direct file I/O, filesystem planning tools, and filesystem search/indexing — four distinct domains in one file
- `desktop-executors.ts` (1508 lines): shared helpers, screenshot analysis, GUI state management, window focus logic, action verification, macro tracing, primitive GUI actions, high-level GUI macros, AT-SPI accessibility actions, app control, DBus control, and capability detection — twelve distinct responsibilities in one file

---

## Goal

Split both files into small domain-owned modules with thin composition entrypoints. Preserve all external behavior, public API, tool names, tool schemas, and consumer import paths exactly.

---

## Non-Goals

- No changes to tool behavior, tool names, or tool schemas
- No changes to `tool-builder.ts`, `main.ts`, or `loop-setup.ts` import paths
- No redesign of approval system, verification system, policy engine, or loop orchestration
- No new capabilities
- No stylistic rewrites or gratuitous renaming

---

## Architecture

### Public API Preservation Strategy

`core-executors.ts` and `desktop-executors.ts` become **thin re-export wrappers**. They import everything from their respective subfolders and re-export it. All external consumers (`tool-builder.ts`, `main.ts`, `loop-setup.ts`) continue to import from the same paths with zero changes.

```
// core-executors.ts (after refactor)
export * from './core';

// desktop-executors.ts (after refactor)
export * from './desktop';
```

### Core Executor Split

```
src/main/agent/executors/core/
  shell-executor.ts      Shell process lifecycle, sentinel parsing, GUI auto-detach
  file-executors.ts      executeFileRead, executeFileWrite, executeFileEdit, executeDirectoryTree
  fs-planning.ts         executeFsFolderSummary, executeFsReorgPlan, executeFsDuplicateScan, executeFsApplyPlan
  fs-search.ts           executeFsQuoteLookup, PDF extraction, text indexing, semantic search engine
  index.ts               Re-exports all public symbols from the four modules above
```

**Exports preserved (all from `core-executors.ts`):**
- `destroyShell`
- `executeShellExec`
- `executeFileRead`, `executeFileWrite`, `executeFileEdit`, `executeDirectoryTree`
- `executeFsFolderSummary`, `executeFsReorgPlan`, `executeFsDuplicateScan`, `executeFsApplyPlan`
- `executeFsQuoteLookup`

**Internal state:**
- `shellProcess`, `shellAlive`, `GUI_APP_BINARIES` stay in `shell-executor.ts`
- `FS_QUOTE_IGNORE`, `FS_TEXT_EXTENSIONS`, `extractedTextCache`, `pdftotextAvailable`, `extractionWritesSincePrune` stay in `fs-search.ts`
- `FS_REORG_CATEGORY_RULES`, `FS_DOC_STRUCTURE_FOLDERS`, `FS_PROJECT_MARKER_FILES`, and classification helpers stay in `fs-planning.ts`
- `FS_QUOTE_IGNORE` is also needed by `fs-planning.ts` — it will be duplicated (it's a 6-item constant) rather than creating a shared dependency

**Note on `FS_QUOTE_IGNORE`:** In the current file this constant is defined at line 1023 but used as early as line 344 (inside `executeFsFolderSummary`). This works at runtime because the functions close over the module scope and `const` is initialized before any exported function is called. When split into separate files, each file gets its own copy of the constant — no behavioral change, no shared-state risk.

### Desktop Executor Split

```
src/main/agent/executors/desktop/
  shared.ts              run(), cmdExists(), wait(), toolCache, TIMEOUT constant
  screenshot-analyzer.ts getAnalyzerPath(), runScreenshotAnalyzer()
  gui-state.ts           guiState singleton, getGuiState(), resetGuiStateForNewConversation(), warmCoordinatesForApp()
  smart-focus.ts         smartFocus()
  action-verify.ts       shouldVerifyAction(), postActionVerify(), createMacroTrace(), MacroTrace interface, HIGH_RISK_* constants
  gui-primitives.ts      execPrimitiveAction() — handles: list_windows, find_window, focus, click, type, key, screenshot, screenshot_and_focus, wait/delay, verify_window_title, verify_file_exists, analyze_screenshot, screenshot_region
  gui-macros.ts          execMacroAction() — handles: launch_and_focus, open_menu_path, fill_dialog, confirm_dialog, export_file, click_and_type
  a11y-actions.ts        execA11yAction() — handles: a11y_get_tree, a11y_find, a11y_do_action, a11y_set_value, a11y_get_state, a11y_list_apps
  gui-executor.ts        executeGuiInteract(), batch_actions dispatcher — calls execPrimitiveAction, execMacroAction, execA11yAction in sequence
  app-control.ts         executeAppControl(), tryControlSurface(), guessDbusMethod()
  dbus-executor.ts       executeDbusControl()
  capabilities.ts        getCapabilityStatus(), getDesktopCapabilities(), DesktopCapabilityStatus interface
  index.ts               Re-exports all public symbols from the modules above
```

**Exports preserved (all from `desktop-executors.ts`):**
- `getGuiState`, `resetGuiStateForNewConversation`, `warmCoordinatesForApp`
- `executeGuiInteract`
- `executeAppControl`
- `executeDbusControl`
- `getCapabilityStatus`, `DesktopCapabilityStatus`
- `getDesktopCapabilities`

**`execSingleAction` dispatch strategy:**

The current monolithic `execSingleAction(input, batchWindow?)` is replaced by three domain handlers plus a top-level dispatcher:

```typescript
// gui-executor.ts
async function execSingleAction(input, batchWindow?) {
  const result = await execPrimitiveAction(input, batchWindow)
               ?? await execMacroAction(input, batchWindow)
               ?? await execA11yAction(input, batchWindow);
  return result ?? `[Error] Unknown action: "${input.action}"`;
}
```

Each handler has return type `Promise<string | null>` — TypeScript-enforced. `null` (not `undefined`) means "this action is not mine, try the next handler." Every `switch` in each handler must have a `default: return null` arm. The final fallthrough produces the unknown-action error that currently lives in the `default` case.

**`guiState` singleton:** Lives exclusively in `gui-state.ts`. All other desktop modules that read or write GUI state import it from there. This is the most critical coupling point — all imports must flow through `gui-state.ts` to prevent multiple instances.

---

## Risk Areas

### 1. `guiState` singleton coherence
`guiState` is a module-level `let` binding. If any module accidentally re-declares it or imports it incorrectly, two independent state objects could exist. Mitigation: `gui-state.ts` is the single source of truth; all other modules import the object (not a copy of it) from there.

### 2. `FS_QUOTE_IGNORE` out-of-order definition
Described above — resolved by moving the constant to the top of each file that uses it.

### 3. `execSingleAction` null-return dispatch
The new `null`-return pattern must be applied consistently. Each handler must return `null` for any action it does not own — not `undefined` or an error string — so the dispatcher falls through correctly.

### 4. Circular imports
No circular dependencies are introduced. The dependency graph is strictly layered:
- `shared.ts` ← no local deps
- `screenshot-analyzer.ts` ← `shared.ts`
- `gui-state.ts` ← coordinate-cache db
- `smart-focus.ts` ← `shared.ts`, `gui-state.ts`, db
- `action-verify.ts` ← `shared.ts`, `gui-state.ts`, `screenshot-analyzer.ts`, coordinate-cache db
- `gui-primitives.ts` ← `shared.ts`, `gui-state.ts`, `smart-focus.ts`, `action-verify.ts`, `screenshot-analyzer.ts`, coordinate-cache db
- `gui-macros.ts` ← `shared.ts`, `gui-state.ts`, `smart-focus.ts`, `action-verify.ts`, `screenshot-analyzer.ts`, coordinate-cache db
- `a11y-actions.ts` ← `shared.ts`, `gui-state.ts`, a11y module
- `gui-executor.ts` ← `gui-primitives.ts`, `gui-macros.ts`, `a11y-actions.ts`, `gui-state.ts`
- `app-control.ts` ← `shared.ts`, db modules
- `dbus-executor.ts` ← `shared.ts`
- `capabilities.ts` ← `shared.ts`, a11y module, db modules

---

## Validation

After implementation:

1. **TypeScript:** `npx tsc --noEmit` — must pass with zero errors
2. **Tests:** `npm test` — all existing tests must pass
3. **Import integrity:** Verify `core-executors.ts` and `desktop-executors.ts` export all previously-exported symbols
4. **Shell behavior:** Confirm `destroyShell` and `executeShellExec` are importable from the original path
5. **Desktop behavior:** Confirm `executeGuiInteract`, `getGuiState`, `getCapabilityStatus` are importable from the original path
6. **`loop-setup.ts` consumers:** Confirm `getDesktopCapabilities`, `getGuiState`, and `warmCoordinatesForApp` resolve correctly via the wrapper — these are imported in `loop-setup.ts` which is not modified
7. **Symbol collision audit:** Before writing `core/index.ts` and `desktop/index.ts`, verify no two submodules export the same name — required for `export *` to compile cleanly

---

## Files Changed

| File | Change |
|------|--------|
| `executors/core-executors.ts` | Replaced with thin re-export wrapper |
| `executors/desktop-executors.ts` | Replaced with thin re-export wrapper |
| `executors/core/shell-executor.ts` | New — shell logic extracted |
| `executors/core/file-executors.ts` | New — file tool logic extracted |
| `executors/core/fs-planning.ts` | New — FS planning tools extracted |
| `executors/core/fs-search.ts` | New — FS search/quote tools extracted |
| `executors/core/index.ts` | New — re-exports core sub-modules |
| `executors/desktop/shared.ts` | New — shared helpers extracted |
| `executors/desktop/screenshot-analyzer.ts` | New — OCR/analyzer helpers extracted |
| `executors/desktop/gui-state.ts` | New — GUI state singleton extracted |
| `executors/desktop/smart-focus.ts` | New — smart focus logic extracted |
| `executors/desktop/action-verify.ts` | New — verification + macro trace extracted |
| `executors/desktop/gui-primitives.ts` | New — primitive action handler extracted |
| `executors/desktop/gui-macros.ts` | New — macro action handler extracted |
| `executors/desktop/a11y-actions.ts` | New — AT-SPI action handler extracted |
| `executors/desktop/gui-executor.ts` | New — public executor + dispatcher |
| `executors/desktop/app-control.ts` | New — app control extracted |
| `executors/desktop/dbus-executor.ts` | New — DBus executor extracted |
| `executors/desktop/capabilities.ts` | New — capability detection extracted |
| `executors/desktop/index.ts` | New — re-exports desktop sub-modules |
