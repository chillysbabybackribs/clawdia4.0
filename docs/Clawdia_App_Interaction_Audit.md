# Clawdia 4.0 — App Interaction Audit & Optimization Plan

## Executive Summary

The architecture is **well-designed in theory** — there's a 5-tier control surface hierarchy (`programmatic → cli_anything → native_cli → dbus → gui`) with a pre-LLM routing layer. But in practice, **the LLM still falls back to GUI/improvisation too often** because:

1. **`app_control` (CLI-Anything) is underpowered** — it's just a thin wrapper around `cli-anything-{app}` binaries that probably aren't installed
2. **The routing layer can't enforce constraints hard enough** — it removes tools from the list but the LLM still finds ways to use wrong tools
3. **No fallback chain at the executor level** — if the preferred surface fails, there's no automatic retry with the next surface
4. **Volume control, system settings, and common OS actions have no dedicated surface** — they fall through to gui_interact every time

---

## Problem 1: `app_control` Is a Dead Letter

### Current State
```typescript
// desktop-executors.ts line 271
export async function executeAppControl(input) {
  const harness = `cli-anything-${appName}`;
  const hasHarness = await cmdExists(harness);
  if (!hasHarness) {
    // Falls back to raw CLI — just runs `appName command`
    return await run(`${appName} ${command}`, 60_000);
  }
}
```

The `app_control` tool is **entirely dependent on CLI-Anything harnesses being installed**. On most systems, `compgen -c cli-anything-` returns nothing. So `app_control` degrades to running `spotify play` (which doesn't work) or `gimp --batch` (which requires Script-Fu knowledge).

### Fix
**Make `app_control` a smart dispatcher, not just a harness wrapper.** It should contain built-in command maps for common apps:

```typescript
const BUILTIN_COMMANDS: Record<string, Record<string, (args: string) => string>> = {
  spotify: {
    'play': (args) => `dbus-send --session --dest=org.mpris.MediaPlayer2.spotify --type=method_call --print-reply /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player.OpenUri string:"spotify:artist:${resolveSpotifyUri(args)}"`,
    'pause': () => `dbus-send ... Player.Pause`,
    'next': () => `dbus-send ... Player.Next`,
    'volume': (args) => `pactl set-sink-volume @DEFAULT_SINK@ ${args}%`,
  },
  vlc: {
    'play': (args) => `dbus-send ... org.mpris.MediaPlayer2.Player.OpenUri string:"${args}"`,
    'pause': () => `dbus-send ... Player.Pause`,
  },
  gimp: {
    'resize': (args) => `python3 -c "from PIL import Image; ..."`,
    'convert': (args) => `convert ${args}`,
  },
};
```

This way `app_control({app: "spotify", command: "play Beatles"})` **actually works** without any harness installed.

---

## Problem 2: The Routing Constraint Is a Suggestion, Not Enforcement

### Current State
The `routeTask()` function in `app-registry.ts` returns a constraint string like:
```
[EXECUTION PLAN] Use dbus_control to interact with Spotify via DBus...
```

And it removes `gui_interact` from the tool list. But:

- The LLM can still call `shell_exec` with `xdotool` commands (bypassing the GUI tool removal)
- The constraint is just text — the LLM can ignore it
- There's **no validation that the LLM actually used the recommended tool**

### Fix
**Add a post-execution validator in the loop:**

```typescript
// In loop.ts, after tool execution
if (executionPlan && toolUse.name !== expectedTool(executionPlan)) {
  // Log the deviation, update metrics
  recordSurfaceDeviation(executionPlan.selectedSurface, toolUse.name);
  // Optionally inject a correction message
}
```

Also, when `gui_interact` is disallowed, also block `shell_exec` commands containing `xdotool|wmctrl|xwininfo`:
```typescript
// In executeShellExec, add a constraint check
if (disallowedSurfaces.includes('gui') && /xdotool|wmctrl|xwininfo/.test(command)) {
  return '[Error] GUI tools blocked by execution plan. Use the recommended control surface.';
}
```

---

## Problem 3: No Automatic Fallback Chain

### Current State
If `dbus_control` fails (e.g., Spotify not running), the LLM has to figure out the fallback itself. Sometimes it retries DBus, sometimes it pivots to GUI, sometimes it gives up.

### Fix
**Implement a fallback chain at the executor level:**

```typescript
// New: executors/surface-chain.ts
export async function executeWithFallback(
  plan: ExecutionPlan,
  input: Record<string, any>,
): Promise<{ result: string; surfaceUsed: ControlSurface }> {
  for (const surface of plan.allowedSurfaces) {
    const result = await executeSurface(surface, input);
    if (!result.startsWith('[Error]')) {
      return { result, surfaceUsed: surface };
    }
    console.log(`[Fallback] ${surface} failed, trying next...`);
  }
  return { result: '[Error] All control surfaces failed.', surfaceUsed: 'gui' };
}
```

This means the LLM calls ONE tool (e.g., `app_control`) and the system automatically tries `cli_anything → dbus → native_cli → gui` under the hood.

---

## Problem 4: Common OS Actions Have No Surface

### Current State
"Raise the volume" has no routing rule. It doesn't match any app name (no `pactl` or `amixer` in the registry). So the classifier either misses it entirely or routes it to `gui` where the LLM tries to find a volume slider with screenshots.

### Fix
**Add system-level profiles to the registry:**

```typescript
const SYSTEM_PROFILES: AppProfile[] = [
  {
    appId: 'system-audio',
    displayName: 'System Audio',
    availableSurfaces: ['native_cli', 'dbus'],
    nativeCli: { 
      command: 'pactl', 
      supportsBatch: true,
      helpSummary: 'pactl set-sink-volume @DEFAULT_SINK@ +5% | pactl get-sink-volume @DEFAULT_SINK@'
    },
    dbusService: 'org.PulseAudio.Server',
    confidence: 1.0,
  },
  {
    appId: 'system-display',
    displayName: 'Display Settings',
    availableSurfaces: ['native_cli'],
    nativeCli: { command: 'xrandr', supportsBatch: true },
    confidence: 0.9,
  },
  {
    appId: 'system-notifications',
    displayName: 'Notifications',
    availableSurfaces: ['native_cli'],
    nativeCli: { command: 'notify-send', supportsBatch: true },
    confidence: 1.0,
  },
];
```

And update `extractAppName()` to detect system intents:
```typescript
// In extractAppName()
if (/volume|mute|unmute|louder|quieter|sound/i.test(lower)) return 'system-audio';
if (/brightness|display|screen|resolution/i.test(lower)) return 'system-display';
if (/notification|alert|notify/i.test(lower)) return 'system-notifications';
```

---

## Problem 5: The 3-Tier Labeling Is Misleading

### Current State
The code labels the tiers as:
```
Tier 1: app_control (CLI-Anything)
Tier 2: gui_interact (xdotool)
Tier 3: dbus_control (DBus)
```

But DBus is **more reliable than GUI** for supported apps. The actual priority should be:

```
Tier 1: Programmatic (shell_exec + python/ffmpeg/imagemagick)
Tier 2: DBus (structured, reliable, no coordinates needed)
Tier 3: CLI-Anything / Native CLI (structured if harness exists)
Tier 4: GUI (last resort — fragile, screenshot-dependent)
```

### Fix
The `app-registry.ts` already has the correct priority order internally (`programmatic → cli_anything → native_cli → dbus → gui`), but the **executor file comments and prompt descriptions contradict this**. Align all documentation to match the actual routing order.

---

## Problem 6: The Prompt Module Tells the LLM the Wrong Order

### Current State (`DESKTOP_APPS.md`):
```markdown
## Desktop App Control — 3-Tier Fallback
### 1. app_control — CLI-Anything harness (PREFERRED for supported apps)
### 2. gui_interact — xdotool/wmctrl/scrot (ANY visible window)
### 3. dbus_control — DBus (Spotify MPRIS, media players, GNOME services)
```

This tells the LLM to try `app_control` first (which usually fails) and `gui_interact` **before** `dbus_control`. That's exactly backwards for media players.

### Fix — Rewrite `DESKTOP_APPS.md`:
```markdown
## App Control — Priority Order

1. **Programmatic** (shell_exec + Python/ImageMagick/ffmpeg) — for creation, conversion, batch ops
2. **DBus** (dbus_control) — for running apps with MPRIS/DBus interfaces (Spotify, VLC, system audio)
3. **CLI-Anything** (app_control) — for apps with installed harnesses
4. **Native CLI** (shell_exec) — for apps with --headless/--batch modes (GIMP, LibreOffice, Inkscape)
5. **GUI** (gui_interact) — LAST RESORT only when no other surface works

The [EXECUTION PLAN] in the dynamic prompt tells you which to use. Follow it.
```

---

## Problem 7: `app_control` Should Absorb DBus and Native CLI

### Current State
The LLM must choose between 3 different tools (`app_control`, `dbus_control`, `shell_exec`) to control one app. This creates decision overhead and errors.

### Proposed Architecture — Unified `app_control`

Merge the intelligence into `app_control` so it becomes the **single entry point** for all app interaction:

```typescript
// New executeAppControl()
export async function executeAppControl(input: Record<string, any>): Promise<string> {
  const { app, command, json = true } = input;
  
  // 1. Load profile from registry
  const profile = getAppProfile(app);
  
  // 2. Parse intent from command string
  const intent = parseIntent(command); // "play Beatles" → {action: "play", args: "Beatles"}
  
  // 3. Try surfaces in priority order
  for (const surface of profile.availableSurfaces) {
    try {
      switch (surface) {
        case 'dbus':
          return await executeViaDbus(profile, intent);
        case 'cli_anything':
          return await executeViaHarness(profile, intent);
        case 'native_cli':
          return await executeViaNativeCli(profile, intent);
        case 'programmatic':
          return await executeViaProgrammatic(profile, intent);
        default:
          continue; // Skip GUI — that's gui_interact's job
      }
    } catch (e) {
      console.log(`[app_control] ${surface} failed for ${app}: ${e.message}`);
      continue;
    }
  }
  
  return `[Error] No control surface succeeded for "${app}". Try gui_interact as fallback.`;
}
```

This means the LLM just calls:
```json
{"tool": "app_control", "input": {"app": "spotify", "command": "play Beatles"}}
```

And `app_control` internally tries DBus → CLI-Anything → native CLI, with automatic fallback.

**Benefits:**
- LLM makes ONE decision instead of three
- Fallback chain is automatic
- Registry knowledge is leveraged at execution time, not just prompt time
- `dbus_control` and `gui_interact` remain available as escape hatches for edge cases

---

## Implementation Priority

| Priority | Change | Effort | Impact |
|----------|--------|--------|--------|
| 🔴 P0 | Rewrite `DESKTOP_APPS.md` prompt to correct the priority order | 10 min | Fixes LLM choosing GUI over DBus |
| 🔴 P0 | Add system-level profiles (volume, display, notifications) to registry | 30 min | Fixes "raise volume" routing to GUI |
| 🟡 P1 | Add built-in command maps to `app_control` for top 5 apps | 2 hrs | Makes `app_control` actually useful without harnesses |
| 🟡 P1 | Implement automatic fallback chain in `app_control` executor | 2 hrs | Eliminates LLM needing to manually retry surfaces |
| 🟢 P2 | Unify `app_control` to absorb DBus/native CLI internally | 4 hrs | Simplifies tool selection from 3 choices to 1 |
| 🟢 P2 | Add post-execution validation in loop.ts | 1 hr | Metrics + correction for surface deviations |
| 🟢 P3 | Block `xdotool` in `shell_exec` when GUI is disallowed | 30 min | Prevents LLM from bypassing tool filtering |

---

## Summary

The routing layer (`app-registry.ts`) is the strongest part of the architecture — it correctly prioritizes programmatic and DBus surfaces over GUI. But the execution layer doesn't follow through:

- `app_control` is an empty shell without CLI-Anything harnesses
- The prompt tells the LLM the wrong priority order
- There's no fallback chain — the LLM must improvise on failure
- System-level actions (volume, brightness) have no routing at all

The **single highest-impact change** is making `app_control` a smart unified dispatcher with built-in command maps and automatic fallback. This transforms it from "check if a harness exists" to "I know how to control Spotify/VLC/GIMP/system-audio natively."
