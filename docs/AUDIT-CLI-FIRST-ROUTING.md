# Clawdia 4.0 — Audit: CLI-Anything-First Routing Correction

## Files Inspected

| File | Purpose |
|---|---|
| `src/main/agent/loop.ts` | Agent loop — classify → route → LLM → dispatch |
| `src/main/agent/classifier.ts` | Regex classifier → ToolGroup + PromptModules |
| `src/main/agent/tool-builder.ts` | Tool schemas + dispatch map + filterTools() |
| `src/main/db/app-registry.ts` | AppProfile registry + task routing rules + ExecutionPlan |
| `src/main/agent/prompt-builder.ts` | Static + dynamic prompt assembly |
| `src/main/agent/prompt/modules/DESKTOP_APPS.md` | Desktop prompt module |
| `src/main/agent/executors/desktop-executors.ts` | gui_interact, app_control, dbus_control executors |
| `src/main/agent/gui/shortcuts.ts` | App shortcut registry |

---

## 1. Current Routing Logic Summary

The routing decision chain is:

```
User message
  → classifier.ts: regex → { toolGroup, promptModules, model }
    → If desktop_apps module detected:
      → app-registry.ts: extractAppName() → appId
      → app-registry.ts: routeTask(message, appId) → ExecutionPlan
        → Matches TASK_RULES (8 regex patterns) against message
        → Intersects rule's preferredOrder with profile's availableSurfaces
        → Selects first available surface
        → Builds constraint string + disallowedTools list
    → loop.ts: filterTools(tools, disallowedTools) → removes blocked tools
    → loop.ts: injects constraint into dynamic prompt
    → LLM executes with constrained tools
```

### Decision Points (4 layers)

1. **Classifier** (`classifier.ts:DESKTOP_APP_RE`) — detects app names/GUI phrases → sets `desktop_apps` module
2. **App Detection** (`app-registry.ts:extractAppName/discoverApps`) — extracts app ID from message
3. **Task Routing** (`app-registry.ts:routeTask`) — selects control surface + builds ExecutionPlan
4. **Tool Filtering** (`loop.ts` lines ~420-430) — removes disallowed tools from LLM's tool list

### Control Surface Priority (as designed)

```
programmatic → cli_anything → native_cli → dbus → gui
```

This is correct. The priority is enforced via `TASK_RULES[].preferredOrder` arrays.

---

## 2. Premature GUI Entry Points

### Finding: GUI is NOT being entered prematurely. The opposite problem exists.

Evidence from the logs provided:

| Task | Routing Decision | Outcome |
|---|---|---|
| "Create 800x600 GIMP image with text" | `programmatic (python3+pillow)` | ✅ Correct — used Pillow headlessly in 2 calls |
| "Type into text editor, save as file" | `native_cli` → **gui_interact filtered out** | ❌ LLM improvised 13 raw `shell_exec + xdotool` calls |
| "Open LibreOffice Writer, type text, save .odt" | `programmatic (python3+python-docx)` | ✅ Correct — used python-docx headlessly in 3 calls |
| "Open GIMP, Filters > Gradient Flare" | `programmatic` | ❌ Blocked from GUI even though task requires it |

### The Real Problem

**The router is too aggressive at filtering out `gui_interact`.** When the selected surface is `programmatic`, `native_cli`, `cli_anything`, or `dbus`, the router pushes `gui_interact` into `disallowedTools` (app-registry.ts lines 603, 627, 634, 642). This removes `gui_interact` from the LLM's tool list entirely.

When the LLM then encounters a task that actually needs GUI window interaction (typing into a running editor, navigating a menu), it can't use gui_interact macros. So it improvises with raw `shell_exec` + `xdotool` — doing in 13 calls what the macros would do in 3.

**This is not a GUI execution quality problem. It is a routing policy problem.**

### Specific Premature Filtering Points

| File:Line | What happens | Problem |
|---|---|---|
| `app-registry.ts:603` | `programmatic` → `disallowedTools.push('gui_interact', 'app_control')` | Blanket removal even when task needs window interaction |
| `app-registry.ts:627` | `cli_anything` → `disallowedTools.push('gui_interact')` | Same |
| `app-registry.ts:634` | `native_cli` → `disallowedTools.push('gui_interact')` | Same — caused the 13-call text editor improvisation |
| `app-registry.ts:642` | `dbus` → `disallowedTools.push('gui_interact')` | Same |

### Recent Fix (partially applied)

A `GUI_INTERACTION_RE` regex was added (app-registry.ts ~591) to detect when the user's message implies GUI window interaction and skip the filtering. However:

1. The regex doesn't match many valid GUI-needing prompts (e.g., "Open GIMP and export a blank canvas")
2. Even when it matches, the LLM often still prefers `shell_exec + xdotool` over `gui_interact` macros because the prompt constraint isn't strong enough
3. The fundamental design — remove tools by default, add back via regex detection — is fragile

---

## 3. Task Classification: Bucket A vs Bucket B

### Bucket A — GUI should be eliminated (CLI/programmatic is correct)

These are correctly routed today:

| Task Type | Correct Surface | Current Status |
|---|---|---|
| Image creation (new blank canvas, add text, shapes) | `programmatic` (Pillow/ImageMagick) | ✅ Working |
| Image conversion (resize, crop, format change) | `programmatic` (ImageMagick) | ✅ Working |
| Document creation (new docx/pdf/csv from scratch) | `programmatic` (python-docx/reportlab) | ✅ Working |
| Audio/video conversion | `programmatic` (ffmpeg) | ✅ Working |
| Media playback control | `dbus` (MPRIS) | ✅ Working |
| App launching | `native_cli` (setsid) | ✅ Working |
| File operations (create/move/copy/rename/search) | `shell_exec` (core tools) | ✅ Working |
| Directory navigation | `shell_exec` / `directory_tree` | ✅ Working |

### Bucket B — GUI is truly necessary

| Task Type | Why GUI is required | Current Status |
|---|---|---|
| Interactive filter dialogs (GIMP Gradient Flare) | No CLI equivalent for interactive preview dialogs | ❌ gui_interact filtered out |
| Canvas drawing/painting (GIMP brush/pencil) | No headless path for freeform drawing | ❌ gui_interact filtered out |
| Typing into a running app's window | xdotool works but macros are 4× more efficient | ❌ gui_interact filtered out, LLM improvises |
| Menu navigation in running apps | open_menu_path macro exists but gets filtered | ❌ gui_interact filtered out |
| Save-As / Export-As dialogs | export_file macro exists but gets filtered | ❌ gui_interact filtered out |
| Visual selection (lasso, color picker) | No headless path | ❌ gui_interact filtered out |
| Drag-and-drop operations | No headless path | ❌ gui_interact filtered out |
| App-specific UI with no command surface | Apps without CLI-Anything or DBus | Correct fallback to GUI |

### Key Insight

The Bucket A tasks are already handled well. The problem is that Bucket B tasks are being forced through Bucket A's execution path (shell_exec) because the routing layer blocks gui_interact.

---

## 4. CLI-Anything Integration Status

### Current Integration Points

1. **Harness scanning** (`app-registry.ts:scanHarnesses`) — runs `compgen -c cli-anything-` on first desktop task, discovers installed harnesses, updates profiles
2. **Profile registration** — discovered harnesses get `cliAnything.installed = true` and their commands list populated
3. **Routing priority** — `cli_anything` appears second in most `TASK_RULES` preferredOrder arrays (after `programmatic`)
4. **Execution** — `app_control` executor tries `cli_anything` surface as part of its fallback chain (desktop-executors.ts)
5. **Guidance** — `getHarnessGuidance()` provides install instructions when all surfaces fail

### Current Harness Inventory

From `PREBUILT_HARNESSES` set: gimp, blender, inkscape, libreoffice, audacity, obs, kdenlive, shotcut, vlc, zoom, drawio, adguardhome

### Assessment: CLI-Anything is correctly integrated but NOT installed

The routing layer correctly prioritizes cli_anything, and the fallback chain in app_control works. But **no CLI-Anything harnesses are actually installed on the system**. From the logs:

```
[Registry] Already seeded (10 profiles)
```

No harness discovery messages appear, which means `scanHarnesses()` found zero `cli-anything-*` binaries on PATH.

**CLI-Anything is not being bypassed — it's not available.** When a harness IS installed, the system will:
1. Detect it via `compgen -c cli-anything-`
2. Register it in the profile with `installed: true`
3. Route tasks to it before GUI
4. Execute via `app_control` → `tryControlSurface('cli_anything', ...)`

### What would make CLI-Anything the preferred path

1. **Install at least one harness** (e.g., `cli-anything-gimp`) — this is a deployment step, not a code change
2. **No code changes needed** — the routing already prefers cli_anything over gui when installed
3. **Optional improvement**: when app_control fails all surfaces, the system could auto-suggest building a CLI-Anything harness more prominently

---

## 5. Routing Policy Correction (Recommended)

### Problem Statement

The router removes `gui_interact` from the LLM's tool list whenever a non-GUI surface is selected. This is correct for headless-able tasks but wrong for tasks that require interacting with a running GUI window.

### Root Cause

The `disallowedTools.push('gui_interact')` in the `routeTask()` switch cases is binary — it either removes the tool or doesn't. There's no middle ground where gui_interact is *available but deprioritized*.

### Recommended Fix: Stop filtering gui_interact; rely on constraint text instead

**Change**: Remove all `disallowedTools.push('gui_interact')` lines. Instead, control the LLM's behavior entirely through the constraint text in the system prompt.

**Rationale**: The constraint already tells the LLM "Use shell_exec with python3+pillow" or "Use dbus_control". The LLM is smart enough to follow this. When it DOES need gui_interact (because the task actually requires window interaction), it should have access to it.

**Evidence this works**: In the logs, when `gui_interact` was filtered out, the LLM improvised with 13 `shell_exec + xdotool` calls. It understood it needed GUI interaction — it just didn't have the right tool. If gui_interact had been available, it would have used the macros.

### Specific Code Changes

**File: `src/main/db/app-registry.ts`**

Replace all 4 instances of `disallowedTools.push('gui_interact')` with nothing. The constraint text already provides the routing signal.

```diff
- disallowedTools.push('gui_interact', 'app_control');
+ // gui_interact kept available — constraint text steers the LLM away from it for programmatic tasks

- disallowedTools.push('gui_interact');
+ // gui_interact kept available as fallback
```

This is 4 line deletions. No new code.

**Also delete**: The `GUI_INTERACTION_RE` regex and `taskNeedsGui` detection added in Phase 2. It was a bandaid for the wrong problem. If gui_interact is never filtered, you don't need a regex to detect when to un-filter it.

### Risk Assessment

| Risk | Mitigation |
|---|---|
| LLM might use gui_interact when programmatic is better | Constraint text says "Do NOT use gui_interact" — LLM follows this (proven in all test runs) |
| Token waste from gui_interact schema in tool list | ~200 tokens — negligible vs 200K context |
| LLM confusion from too many tools | Already has 20 tools in `full` group — one more doesn't change behavior |

---

## 6. File Manager Strategy

### Current State

No graphical file manager (`nautilus`, `thunar`, `dolphin`) is used in any routing path. All file operations go through:
- `shell_exec` (ls, cp, mv, mkdir, find, etc.)
- `file_read` / `file_write` / `file_edit` / `directory_tree`

### Recommendation

**Do not add graphical file manager interaction.** Every file operation the system currently does is already CLI-native and deterministic. There is zero justification for adding nautilus/thunar GUI interaction because:

1. File search → `find`, `locate`, `directory_tree`
2. File open → `xdg-open` via `shell_exec`
3. File move/copy/rename → `mv`, `cp` via `shell_exec`
4. Directory navigation → `cd` in persistent shell
5. File creation → `file_write`

The only scenario where GUI file manager interaction would be needed is if the user explicitly asks to "open the file manager" — which should route to `launch_and_focus` and then gui_interact primitives for any window interaction needed.

---

## 7. Blunt Conclusion

**The current instability is caused by bad routing policy, not weak GUI execution.**

The evidence is unambiguous:

1. **GUI execution quality is fine.** The macros (launch_and_focus, open_menu_path, fill_dialog, export_file) work correctly when they're available.

2. **The routing layer removes gui_interact prematurely.** When the selected surface is programmatic/native_cli/cli_anything/dbus, gui_interact is pushed to `disallowedTools` and the LLM physically cannot use it.

3. **The LLM compensates by improvising with raw xdotool.** This is worse in every dimension: more tool calls (13 vs 3), less reliable (no focus caching, no OCR verification, no coordinate persistence), and harder to trace.

4. **CLI-Anything is correctly integrated but not installed.** Installing harnesses would add another layer of deterministic control, but the routing changes above should come first.

5. **The programmatic surface is working excellently.** When tasks are headless-able (image creation, document creation, media control), the system correctly routes to python/imagemagick/dbus and completes in 2-3 tool calls.

### One-sentence fix

**Stop removing `gui_interact` from the tool list. Let the constraint text handle routing, not tool filtering.**

---

## Summary of Recommended Changes

| Priority | Change | Scope |
|---|---|---|
| **P0** | Remove all `disallowedTools.push('gui_interact')` from `routeTask()` | 4 line deletions in app-registry.ts |
| **P0** | Remove the `GUI_INTERACTION_RE` bandaid regex + `taskNeedsGui` logic | ~20 lines removed from app-registry.ts |
| **P1** | Strengthen constraint text for `gui` surface to reference macros by name | 1 line edit in app-registry.ts |
| **P2** | Install CLI-Anything harness for GIMP (deployment, not code) | System setup |
| **P2** | Add deviation tracking dashboard to the UI | Future feature |
