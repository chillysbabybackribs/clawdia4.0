/**
 * Desktop Tool Executors — Application control surfaces.
 * 
 * Control surface priority (highest → lowest):
 *   1. programmatic — shell_exec with Python/ImageMagick/ffmpeg
 *   2. dbus         — dbus_control for MPRIS/DBus-capable apps
 *   3. cli_anything — app_control with CLI-Anything harness
 *   4. native_cli   — shell_exec with app's native CLI/batch mode
 *   5. gui          — gui_interact (last resort)
 * 
 * The app-registry routing layer selects the surface before the LLM acts.
 * These executors carry out whichever surface was chosen.
 *
 * Phase 1 additions:
 *   - UI State integration: skip redundant wmctrl focus in batch when window unchanged
 *   - New actions: verify_window_title, verify_file_exists, screenshot_region
 *   - State updated on focus, screenshot, success, error
 *   - getGuiState() / resetGuiState() exported for agent loop
 *
 * Existing optimizations preserved:
 *   - cmdExists() cached at module level (no repeated `which` forks)
 *   - batch_actions default delay 100ms
 *   - screenshot_and_focus wait 250ms
 *   - Display layout detected once via xrandr
 *   - Python imaging tools detected (Pillow, ImageMagick)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as path from 'path';
import {
  type UIState,
  createUIState,
  isWindowFocused,
  recordFocus,
  recordSuccess,
  recordError,
  recordScreenshot,
  recordSkippedFocus,
  cacheTarget,
  loadPersistedTargets,
  resetUIState,
} from '../gui/ui-state';
import {
  lookupCoordinate,
  storeCoordinate,
  confirmCoordinate,
  invalidateCoordinate,
  getCachedTargetsSummary,
  pruneCoordinateCache,
  upsertCoordinate,
  evictCoordinate,
  warmUIStateFromCache,
} from '../../db/coordinate-cache';
import {
  getAppProfile,
  getHarnessGuidance,
  type AppProfile,
  type ControlSurface,
  recordFallback,
} from '../../db/app-registry';

const execAsync = promisify(exec);
const TIMEOUT = 30_000;

// ═══════════════════════════════════
// Helpers
// ═══════════════════════════════════

async function run(command: string, timeout = TIMEOUT): Promise<string> {
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
async function cmdExists(cmd: string): Promise<boolean> {
  if (cmd in toolCache) return toolCache[cmd];
  try { await execAsync(`which ${cmd} 2>/dev/null`); toolCache[cmd] = true; }
  catch { toolCache[cmd] = false; }
  return toolCache[cmd];
}

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Resolve path to screenshot-analyzer.py (works in dev + dist). */
function getAnalyzerPath(): string {
  // __dirname at runtime is dist/main/agent/executors
  // The .py file lives in src/main/agent/gui/ (not compiled to dist)
  // Go up 4 levels from dist/main/agent/executors → project root, then into src
  const projectRoot = path.join(__dirname, '..', '..', '..', '..');
  const srcPath = path.join(projectRoot, 'src', 'main', 'agent', 'gui', 'screenshot-analyzer.py');

  try {
    require('fs').accessSync(srcPath);
    return srcPath;
  } catch {
    // Fallback: maybe it was copied alongside dist during packaging
    const distPath = path.join(__dirname, '..', 'gui', 'screenshot-analyzer.py');
    return distPath;
  }
}

/** Run the screenshot analyzer and return parsed JSON or null. */
async function runScreenshotAnalyzer(
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

// ═══════════════════════════════════
// GUI State — Module-level singleton per conversation
// ═══════════════════════════════════

let guiState: UIState = createUIState();

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

/**
 * Focus a window, but SKIP if the state says it's already focused.
 * On first focus of a known app+window, loads persisted coordinates from the
 * coordinate cache so the LLM can immediately use remembered targets.
 * Returns true if focus was actually performed, false if skipped.
 */
async function smartFocus(winName: string): Promise<{ focused: boolean; skipped: boolean }> {
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

  recordFocus(guiState, winName, '');

  // ── Phase 2: Load persisted coordinates from cross-session cache ──
  const app = guiState.focusedWindow?.app || 'unknown';
  if (app !== 'unknown') {
    try {
      const db = (await import('../../db/coordinate-cache')).getCachedTargetsSummary;
      // Load rows directly for in-memory population
      const { getDb } = await import('../../db/database');
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

// ═══════════════════════════════════
// Unified App Control — app_control
//
// Smart dispatcher that reads the app’s registry profile and tries each
// available control surface in priority order with automatic fallback.
// The LLM calls ONE tool; the system figures out the surface.
// ═══════════════════════════════════

/**
 * Try to execute a command via a specific control surface.
 * Returns { ok: true, result } on success, { ok: false, error } on failure.
 */
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

      // Check if the service is actually running before attempting a call
      const ping = await run(
        `dbus-send --session --dest=${profile.dbusService} --type=method_call --print-reply /org/mpris/MediaPlayer2 org.freedesktop.DBus.Properties.Get string:"org.mpris.MediaPlayer2" string:"Identity"`,
        5000,
      );
      if (ping.startsWith('[Error]')) {
        return { ok: false, result: `[Skip] DBus service "${profile.dbusService}" not running` };
      }
      // Service is alive — return a hint for the LLM to use dbus_control directly
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
      // Use a tighter timeout for apps with known batch-mode hang risks
      const helpHint = profile.nativeCli?.helpSummary || '';
      const timeout = /hang|block|timeout/i.test(helpHint) ? 15_000 : 60_000;
      console.log(`[app_control] Native CLI: ${bin} ${command} (timeout: ${timeout / 1000}s)`);
      const result = await run(`${bin} ${command}`, timeout);
      if (result.startsWith('[Error]')) return { ok: false, result };
      return { ok: true, result };
    }

    case 'programmatic': {
      // Programmatic tasks are better handled by shell_exec, not app_control.
      // Return ok: false so the fallback chain continues to try cli_anything
      // and native_cli — those can interact with the running app.
      // The suggestion is included so the LLM knows it has this option.
      const alts = profile.programmaticAlternatives?.join(', ') || 'python3';
      return {
        ok: false,
        result: `[Hint] For file-level operations (resize, convert, create), use shell_exec with ${alts} instead of app_control. Continuing fallback chain for app-level operations...`,
      };
    }

    case 'gui': {
      // GUI is gui_interact's domain, not app_control's.
      return {
        ok: false,
        result: `[Skip] GUI surface — use gui_interact directly if needed.`,
      };
    }

    default:
      return { ok: false, result: `[Skip] Unknown surface: ${surface}` };
  }
}

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

export async function executeAppControl(input: Record<string, any>): Promise<string> {
  const { app, command, json = true } = input;
  if (!app || !command) return '[Error] app and command are required.';

  const appName = app.toLowerCase().replace(/[^a-z0-9-]/g, '');

  // Load profile from the registry
  const profile = getAppProfile(appName);

  if (profile) {
    // Try each surface in the profile’s priority order
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

    // All surfaces failed — provide harness guidance
    recordFallback();
    const guidance = getHarnessGuidance(appName);
    const harnessBlock = guidance.alreadySuggested
      ? '' // Don't repeat install instructions
      : `\n\n${guidance.installSteps}`;
    return `[Error] All control surfaces failed for "${profile.displayName}".
Tried: ${tried.join(' → ')}

Fallback options:
- Use gui_interact if the app is visually open
- Use shell_exec to launch it: setsid ${profile.binaryPath || appName} >/dev/null 2>&1 &${harnessBlock}`;
  }

  // No profile — fall back to basic binary check (legacy behavior)
  const hasNative = await cmdExists(appName);
  if (!hasNative) {
    const guidance = getHarnessGuidance(appName);
    const harnessBlock = guidance.alreadySuggested ? '' : `\n\n${guidance.installSteps}`;
    return `[No profile or binary found for "${app}"]

This app is not in the registry and is not installed. Try:
- shell_exec to check: which ${appName}
- gui_interact to interact with a running window${harnessBlock}`;
  }

  console.log(`[app_control] No profile for ${app}, using raw native CLI`);
  return await run(`${appName} ${command}`, 60_000);
}

// ═══════════════════════════════════
// GUI Automation — gui_interact (State-Aware)
// ═══════════════════════════════════

async function execSingleAction(input: Record<string, any>, batchWindow?: string): Promise<string> {
  const { action, window: winName, x, y, text, delay: inputDelay } = input;
  const delayMs = inputDelay || 0;
  // In batch mode, use the batch-level window if the step doesn't specify one
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
        const { skipped } = await smartFocus(effectiveWindow);
        if (!skipped) await wait(100);
      }
      if (delayMs) await wait(delayMs);
      const clickResult = await run(`xdotool mousemove ${x} ${y} click 1`);
      if (clickResult.startsWith('[Error]')) {
        // Evict from coordinate cache if we had a named target at this position
        if (effectiveWindow && guiState.activeApp) {
          const hitTarget = Object.entries(guiState.knownTargets)
            .find(([, t]) => t.x === x && t.y === y);
          if (hitTarget) invalidateCoordinate(guiState.activeApp, effectiveWindow, hitTarget[0]);
        }
        recordError(guiState, 'click', `(${x},${y})`);
        return clickResult;
      }
      recordSuccess(guiState, 'click', `(${x},${y})`);
      // Persist named targets to coordinate cache (named by the LLM or from OCR)
      if (effectiveWindow && guiState.activeApp) {
        const hitTarget = Object.entries(guiState.knownTargets)
          .find(([, t]) => t.x === x && t.y === y);
        if (hitTarget) {
          storeCoordinate(guiState.activeApp, effectiveWindow, hitTarget[0], x, y, guiState.confidence);
        }
      }
      return `Clicked (${x}, ${y})`;
    }

    case 'type': {
      if (!text) return '[Error] text required.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';
      if (effectiveWindow) {
        const { skipped } = await smartFocus(effectiveWindow);
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
        const { skipped } = await smartFocus(effectiveWindow);
        if (!skipped) await wait(100);
      }
      if (delayMs) await wait(delayMs);
      await run(`xdotool key ${text}`);
      recordSuccess(guiState, 'key', text);
      return `Key: ${text}`;
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

      // Run OCR analysis if tesseract is available (adds ~1-2s but provides text + targets)
      let ocrBlock = '';
      if (await cmdExists('tesseract')) {
        const analysis = await runScreenshotAnalyzer(filename, { title: effectiveWindow });
        if (analysis) {
          ocrBlock = '\n\n[OCR Analysis]\n' + analysis.summary;
          // Cache detected click targets in UI state
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
      // Explicit delay/wait action for batch sequences
      const waitMs = inputDelay || (input.ms as number) || 500;
      await wait(waitMs);
      return `Waited ${waitMs}ms`;
    }

    // ── New Phase 1 actions ──────────────────────

    case 'verify_window_title': {
      // Lightweight verification: check active window title without screenshot
      const title = await run('xdotool getactivewindow getwindowname 2>/dev/null');
      if (title.startsWith('[Error]')) return title;
      const trimmed = title.trim();
      // Update state with what we found
      if (trimmed) recordFocus(guiState, trimmed, '');
      return `Active window: "${trimmed}"`;
    }

    case 'verify_file_exists': {
      // Verify a file was created/exported without screenshot
      const filePath = input.path || text;
      if (!filePath) return '[Error] path or text (filepath) required.';
      const stat = await run(`stat --printf="%s bytes, modified %y" "${filePath}" 2>/dev/null`);
      if (stat.startsWith('[Error]')) return `File not found: ${filePath}`;
      return `File exists: ${filePath} (${stat})`;
    }

    case 'analyze_screenshot': {
      // Capture screenshot + run OCR analysis — returns structured text, NOT raw image
      // This is the PREFERRED way to "see" the screen (~400-600 tokens vs 50K for raw vision)
      const filename = `/tmp/clawdia-screenshot-${Date.now()}.png`;

      // Auto-populate window from UI state if LLM didn't specify one.
      // Capturing a full multi-monitor desktop produces noisy OCR and takes ~11s.
      // Capturing a focused window produces clean OCR and takes ~2-3s.
      let analyzeWindow = effectiveWindow;
      if (!analyzeWindow && guiState.focusedWindow) {
        analyzeWindow = guiState.focusedWindow.title;
        console.log(`[Desktop] analyze_screenshot: auto-using focused window "${analyzeWindow}"`);
      }

      if (analyzeWindow) {
        await smartFocus(analyzeWindow);
        await wait(250);
      }

      // Capture (focused window if available, full screen as fallback)
      if (await cmdExists('scrot')) {
        await run(`scrot ${analyzeWindow ? '-u ' : ''}${filename}`);
      } else {
        return '[Error] No screenshot tool installed. Run: sudo apt install scrot';
      }
      recordScreenshot(guiState);

      // Run OCR analyzer
      if (!await cmdExists('tesseract')) {
        return `[Screenshot: ${filename}]\n[Warning] tesseract not installed — OCR unavailable. Run: sudo apt install tesseract-ocr`;
      }

      const analysis = await runScreenshotAnalyzer(filename, { title: analyzeWindow || '' });
      if (!analysis) {
        return `[Screenshot: ${filename}]\n[OCR analysis failed — raw screenshot available at path above]`;
      }

      // Cache detected targets in UI state AND persist to SQLite coordinate cache
      for (const t of analysis.targets) {
        cacheTarget(guiState, t.label, t.x, t.y);
        // Persist to coordinate cache so next conversation skips orientation
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
      // Capture only a specific region (saves bandwidth + processing time)
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
      return `[Error] Unknown action: "${action}"`;
  }
}

export async function executeGuiInteract(input: Record<string, any>): Promise<string> {
  const { action } = input;
  if (!action) return '[Error] action is required.';

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

    // Detect if all steps target the same window — enables focus skip optimization
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

    // Append state summary to batch result for LLM awareness
    const stateNote = guiState.skippedFocusCalls > 0
      ? `\n[State] Skipped ${guiState.skippedFocusCalls} redundant focus calls (window already focused)`
      : '';
    return results.join('\n') + stateNote;
  }

  return await execSingleAction(input);
}

// ═══════════════════════════════════
// DBus Control — dbus_control
// ═══════════════════════════════════

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

// ═══════════════════════════════════
// Capability Discovery — runs once, cached
// ═══════════════════════════════════

let cachedCapabilities: string | null = null;

export async function getDesktopCapabilities(): Promise<string> {
  if (cachedCapabilities) return cachedCapabilities;

  // Check all tools in parallel
  const [xdotool, wmctrl, scrot, dbus, python3, convert] = await Promise.all([
    cmdExists('xdotool'), cmdExists('wmctrl'), cmdExists('scrot'),
    cmdExists('dbus-send'), cmdExists('python3'), cmdExists('convert'),
  ]);

  // Check Python imaging libraries
  let hasPillow = false;
  if (python3) {
    try {
      await execAsync('python3 -c "from PIL import Image" 2>/dev/null', { timeout: 3000 });
      hasPillow = true;
    } catch {}
  }

  // CLI-Anything harnesses
  let harnesses: string[] = [];
  try {
    const { stdout } = await execAsync('bash -c "compgen -c cli-anything-" 2>/dev/null || echo ""', { timeout: 3000 });
    harnesses = stdout.trim().split('\n').map(s => s.replace(/.*cli-anything-/, '').trim()).filter(Boolean);
  } catch {}

  // Display layout via xrandr — critical for multi-monitor coordinate translation
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
  if (!xdotool && !wmctrl) lines.push('Install GUI tools: sudo apt install xdotool wmctrl scrot');

  cachedCapabilities = lines.join('\n');
  console.log(`[Desktop] ${cachedCapabilities}`);
  return cachedCapabilities;
}
