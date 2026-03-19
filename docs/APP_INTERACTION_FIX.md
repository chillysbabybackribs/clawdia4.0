# Clawdia 4.0 — App Interaction Fix (Phases 1–3)

## What was wrong

Adding GUI/screenshot tools broke previously-working CLI pipelines because:

1. **The `DESKTOP_APPS.md` prompt told the LLM the wrong priority order** — it listed `gui_interact` as Tier 2 (above DBus), making the LLM reach for GUI automation before trying programmatic or DBus surfaces.

2. **Tool descriptions reinforced the wrong behavior** — `gui_interact` was described as a general-purpose tool ("ANY visible window"), while `dbus_control` was buried as a niche option. The LLM chose the tool that *looked* most capable.

3. **App detection was hardcoded to 30 names** — any app not in `APP_NAMES` got zero routing, falling through to unguided LLM improvisation (which defaulted to GUI).

4. **`app_control` was a dead-end** — it only checked for CLI-Anything harnesses (rarely installed), then tried raw `{app} {command}` (rarely works). No DBus awareness, no fallback chain.

## What changed

### Phase 1 — Prompt & Description Alignment (P0)

**`src/main/agent/prompt/modules/DESKTOP_APPS.md`** — Complete rewrite.
- Removed the "3-Tier Fallback" framing entirely
- New priority: Programmatic → DBus → CLI → GUI (last resort)
- Lead instruction: "Follow the [EXECUTION PLAN]"
- Removed app-specific examples (system is agnostic)

**`src/main/agent/executors/desktop-executors.ts`** — Header comments.
- Replaced "Tier 1/2/3" labels with correct surface priority order

**`src/main/agent/tool-builder.ts`** — Tool descriptions.
- `gui_interact`: Added "LAST RESORT"
- `dbus_control`: Added "PREFERRED over gui_interact"
- `app_control`: Updated to reflect unified dispatcher role

**`src/main/agent/CLASSIFIER.md`** — Documentation updated.

### Phase 2 — Dynamic App Discovery (P0)

**`src/main/db/app-registry.ts`** — Replaced hardcoded detection.

Old: `APP_NAMES` = hardcoded Set of 30 app names, sync-only `extractAppName()`.

New: 3-layer detection with auto-registration:
1. **`extractAppName()` (sync)** — programmatic aliases → registry DB → binary cache
2. **`discoverApps()` (async)** — `which` checks → MPRIS service enumeration → `wmctrl -l` window matching
3. Every discovery auto-registers in the registry for instant future lookups

**`src/main/agent/loop.ts`** — Uses `extractAppName() || await discoverApps()`.

### Phase 3 — Unified `app_control` Dispatcher (P1)

**`src/main/agent/executors/desktop-executors.ts`** — Complete rewrite of `executeAppControl()`.

Old: Check for `cli-anything-{app}` → raw `{app} {command}` → error.

New: Smart dispatcher with automatic fallback:
1. Load app profile from registry
2. Iterate `profile.availableSurfaces` in priority order
3. `tryControlSurface()` attempts each:
   - **dbus**: Pings the service, returns MPRIS guidance if alive
   - **cli_anything**: Runs harness if installed
   - **native_cli**: Runs app's native CLI
   - **programmatic**: Returns redirect hint to `shell_exec`
   - **gui**: Skips (that's `gui_interact`'s domain)
4. First success returns immediately
5. All-fail returns structured error with tried surfaces + fallback suggestions

## Test Results

All 5 test scenarios passed:
1. ✅ "Play some music" → MPRIS auto-detected → DBus routed
2. ✅ "Resize image" → Programmatic (Pillow/ImageMagick)
3. ✅ "Pause Spotify" → DBus surface, no GUI
4. ✅ "Open Nautilus" → Dynamic discovery → native_cli
5. ✅ "Create gradient banner" → Programmatic, never touches GUI

## Remaining phases

- **Phase 4**: CLI-Anything build trigger for unknown apps
- **Phase 5**: Post-execution surface deviation metrics in loop.ts
