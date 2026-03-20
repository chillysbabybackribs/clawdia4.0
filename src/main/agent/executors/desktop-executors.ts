/**
 * Desktop Tool Executors — Application control surfaces.
 * 
 * Control surface priority is PROFILE-DRIVEN, not fixed here.
 * The app-registry (routeTask) selects the surface per-task based on:
 *   - the app's AppProfile.availableSurfaces
 *   - the task type (TASK_RULES regex match)
 *   - whether a CLI-Anything harness is installed (auto-promoted if so)
 * 
 * These executors carry out whichever surface was chosen.
 * NOTE: app_control is bypassed entirely when routeTask selects cli_anything
 * (the LLM calls shell_exec with the harness directly).
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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  a11yGetTree, a11yFind, a11yDoAction, a11ySetValue, a11yGetState, a11yListApps,
  isA11yAvailable,
} from '../gui/a11y';
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
  listProfiles,
  type AppProfile,
  type ControlSurface,
  recordFallback,
} from '../../db/app-registry';
import { getDb } from '../../db/database';

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

/** Resolve path to screenshot-analyzer.py (works in dev + packaged builds). */
function getAnalyzerPath(): string {
  // Packaged: electron-builder copies .py files to resources/gui/ via extraResources
  const resourcePath = path.join(process.resourcesPath, 'gui', 'screenshot-analyzer.py');
  if (fs.existsSync(resourcePath)) return resourcePath;
  // Dev: __dirname is dist/main/agent/executors — traverse up to project root, then into src
  const projectRoot = path.join(__dirname, '..', '..', '..', '..');
  const srcPath = path.join(projectRoot, 'src', 'main', 'agent', 'gui', 'screenshot-analyzer.py');
  if (fs.existsSync(srcPath)) return srcPath;
  // Final fallback alongside dist
  return path.join(__dirname, '..', 'gui', 'screenshot-analyzer.py');
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
        result: `[Skip] GUI surface — not handled by app_control.`,
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
- Use shell_exec to launch it: setsid ${profile.binaryPath || appName} >/dev/null 2>&1 &${harnessBlock}`;
  }

  // No profile — fall back to basic binary check (legacy behavior)
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

// ═══════════════════════════════════
// Macro Step Tracing
//
// Structured logging for GUI macros. Each macro logs the macro name,
// then each expanded primitive step with its result.
// Output is both console-logged and accumulated for the return value.
// ═══════════════════════════════════

interface MacroTrace {
  macro: string;
  steps: { step: number; action: string; detail: string; result: 'ok' | 'skip' | 'fail'; durationMs: number }[];
  totalMs: number;
}

function createMacroTrace(name: string): { trace: MacroTrace; step: (action: string, detail: string, fn: () => Promise<string>) => Promise<string>; finish: () => string } {
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
//
// Runs OCR after high-risk clicks to give the LLM post-action state.
// "High-risk" means: the click likely changed UI state (opened a
// menu, triggered a dialog, submitted a form, navigated). Low-risk
// repetitive clicks (e.g. color picking, canvas drawing) skip this.
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
function shouldVerifyAction(
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
async function postActionVerify(windowTitle?: string): Promise<string> {
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
        const { focused, skipped } = await smartFocus(effectiveWindow);
        if (!focused) return `[Error] Could not focus "${effectiveWindow}" — aborting click to prevent interaction with wrong window.`;
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
      // Conditional post-click verification for high-risk actions
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
      // Conditional verification for high-risk shortcuts (Ctrl+N, Ctrl+S, etc.)
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

    // ═══════════════════════════════════
    // GUI Macros — High-level composite actions
    //
    // Each macro composes existing primitives (focus, key, type, wait, click)
    // into a single action for common multi-step workflows.
    // They reduce tool-call count and eliminate repeated low-level reasoning.
    // ═══════════════════════════════════

    case 'launch_and_focus': {
      // Launch an app, wait for it to appear, focus its window, and capture initial state.
      // Replaces: shell_exec("setsid app &") + wait + gui_interact(focus) + gui_interact(analyze_screenshot)
      const appBinary = input.app || text;
      if (!appBinary) return '[Error] launch_and_focus requires "app" (binary name) or "text".';
      const windowMatch = effectiveWindow || appBinary;
      const m = createMacroTrace(`launch_and_focus("${appBinary}")`);

      // Step 1: Launch in background
      const launchResult = await m.step('launch', appBinary, async () => {
        await run(`setsid ${appBinary} >/dev/null 2>&1 &`);
        return `Launched ${appBinary} in background`;
      });

      // Step 2: Wait for window to appear (poll wmctrl up to 10s)
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

      // Step 3: Focus the window
      await m.step('focus', windowMatch, async () => {
        await smartFocus(windowMatch);
        await wait(500);
        return `Focused "${windowMatch}"`;
      });

      // Step 4: Capture initial state via OCR
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
      // Navigate a menu hierarchy using keyboard (Alt+key → arrow keys → Enter).
      // input.path: array of menu labels, e.g. ["File", "Export As"] or "File > Export As"
      // More reliable than coordinate clicking on menus.
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

      // Open the first menu via Alt+first-letter (standard GTK/Qt convention)
      const firstMenu = menuPath[0].trim();
      const firstLetter = firstMenu[0].toLowerCase();
      await mMenu.step('open_menu', firstMenu, async () => {
        await run(`xdotool key alt+${firstLetter}`);
        await wait(300);
        return `Opened menu "${firstMenu}" via Alt+${firstLetter}`;
      });

      // Navigate to each subsequent submenu item
      for (let i = 1; i < menuPath.length; i++) {
        const item = menuPath[i].trim();
        const isFinal = i === menuPath.length - 1;
        const navResult = await mMenu.step(isFinal ? 'activate' : 'navigate', item, async () => {
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
      // Fill multiple fields in a dialog by tabbing through them, then confirm.
      // input.fields: array of {value: string} in tab order, or [{label, value}]
      // input.confirm: boolean (default true) — press Enter after filling
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
        if (fillResult.startsWith('[Error')) break; // Fail-fast
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
      // Wait briefly for dialog to settle, then press Enter (or click a named button).
      // input.button: optional button label to click instead of Enter
      // input.settle_ms: optional settle time (default 300)
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
      // Full export workflow: trigger export shortcut → fill path → confirm.
      // input.path: output file path (required)
      // input.shortcut: override shortcut (default: ctrl+shift+e for "Export As")
      // input.app: app name for shortcut lookup
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

      // Determine the export shortcut
      let shortcut = input.shortcut as string | undefined;
      if (!shortcut) {
        const app = input.app || guiState.activeApp || '';
        const { resolveShortcut } = require('../gui/shortcuts');
        shortcut = resolveShortcut(app, 'export_as') || resolveShortcut(app, 'save_as') || 'ctrl+shift+e';
      }

      // Step: trigger export shortcut
      await mExport.step('shortcut', shortcut!, async () => {
        await run(`xdotool key ${shortcut}`);
        await wait(800);
        return `Triggered ${shortcut}`;
      });

      // Step: fill the path field
      await mExport.step('fill_path', exportPath, async () => {
        await run('xdotool key ctrl+a');
        await wait(100);
        await run(`xdotool type --delay 10 -- "${exportPath.replace(/"/g, '\\"')}"`);
        await wait(200);
        return `Typed path: ${exportPath}`;
      });

      // Step: confirm export
      await mExport.step('confirm', 'Enter', async () => {
        await run('xdotool key Return');
        await wait(500);
        return 'Pressed Enter to confirm';
      });

      // Step: handle overwrite dialog if present
      const afterExport = await postActionVerify(effectiveWindow);
      if (afterExport.includes('DIALOG') || afterExport.toLowerCase().includes('overwrite') || afterExport.toLowerCase().includes('replace')) {
        await mExport.step('confirm_overwrite', 'Enter', async () => {
          await wait(200);
          await run('xdotool key Return');
          await wait(300);
          return 'Confirmed overwrite dialog';
        });
      }

      // Step: verify file exists
      const resolvedPath = exportPath.replace(/^~\//, os.homedir() + '/');
      const fileStatus = await mExport.step('verify_file', resolvedPath, async () => {
        const fileCheck = await run(`stat --printf="%s bytes" "${resolvedPath}" 2>/dev/null`);
        return fileCheck.startsWith('[Error]') ? '[Error] File NOT found' : `File: ${fileCheck}`;
      });

      recordSuccess(guiState, 'export_file', exportPath);
      return `${mExport.finish()}${afterExport ? '\n' + afterExport : ''}`;
    }

    case 'click_and_type': {
      // Focus window, click a target position, then type text.
      // Replaces: gui_interact(focus) + gui_interact(click) + gui_interact(type)
      // input.x, input.y: click coordinates (required)
      // input.text: text to type (required)
      // input.window: optional window to focus first
      if (x == null || y == null) return '[Error] click_and_type requires x, y coordinates.';
      if (!text) return '[Error] click_and_type requires "text" to type.';
      if (!await cmdExists('xdotool')) return '[Error] xdotool not installed.';

      const m = createMacroTrace(`click_and_type(${x},${y},"${text.slice(0, 30)}")`);

      // Step 1: Focus window if specified
      if (effectiveWindow) {
        await m.step('focus', effectiveWindow, async () => {
          const { skipped } = await smartFocus(effectiveWindow!);
          if (!skipped) await wait(100);
          return skipped ? `Focused "${effectiveWindow}" [cached]` : `Focused "${effectiveWindow}"`;
        });
      }

      // Step 2: Click the target
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

      // Step 3: Type text
      const typeResult = await m.step('type', text.slice(0, 40), async () => {
        await run(`xdotool type --delay 15 -- "${text.replace(/"/g, '\\"')}"`);
        recordSuccess(guiState, 'type', text.slice(0, 30));
        return `Typed "${text.slice(0, 50)}"`;
      });

      recordSuccess(guiState, 'click_and_type', `(${x},${y}) "${text.slice(0, 20)}"`);
      return `${m.finish()}\n\nResult: Clicked (${x},${y}) and typed "${text.slice(0, 50)}"`;
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

    // ═══════════════════════════════════
    // AT-SPI Accessibility Actions (V1)
    //
    // Structured GUI access for menus, buttons, text fields, dialogs.
    // Preferred over raw click/type for standard desktop controls.
    // Falls back to raw gui_interact if AT-SPI is unavailable or fails.
    // ═══════════════════════════════════

    case 'a11y_get_tree': {
      // Get compact accessibility tree for an app/window/dialog
      // Accept app name from: input.app, input.window, input.name, input.text
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
      // Find element by role + name
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
      // Execute semantic action on an element
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
      // Set text/value on a control
      // Accept "value" or "text" (LLM sometimes uses "text" from gui_interact habit)
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
      // Read state/value of an element
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
      return `[Error] Unknown action: "${action}"`;
  }
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
// Capability Status — runs once, cached
// ═══════════════════════════════════

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

  // CLI-Anything harnesses — read from registry (populated by scanHarnesses)
  // instead of running a redundant compgen shell call.
  let harnesses: string[] = [];
  try {
    const profiles = listProfiles();
    harnesses = profiles
      .filter(p => p.cliAnything?.installed)
      .map(p => p.appId);
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

  // AT-SPI availability check
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
