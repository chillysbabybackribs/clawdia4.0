/**
 * UI State — Persistent per-conversation GUI state cache.
 *
 * Eliminates redundant window focus calls, screenshot-based orientation,
 * and coordinate re-discovery between tool calls. The state is held in
 * the agent loop and threaded through gui_interact executions.
 *
 * Invalidation rules:
 *   - Confidence decays on errors (×0.6)
 *   - Confidence boosts on success (min(1, +0.15))
 *   - State goes stale after STALE_AFTER_MS (30s)
 *   - focusedWindow cleared when a different window is focused
 *   - Full reset on explicit `reset_state` or conversation change
 */

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export interface FocusedWindow {
  title: string;
  id: string;             // xdotool window id (may be empty if found via wmctrl)
  app: string;            // detected app name (e.g., "gimp", "libreoffice")
  lastFocusedAt: number;  // Date.now()
}

export interface KnownTarget {
  x: number;
  y: number;
  confidence: number;     // 0-1
  discoveredAt: number;
}

export interface ActionRecord {
  action: string;
  target?: string;        // window name or coordinates
  result: 'success' | 'error';
  timestamp: number;
}

export interface UIState {
  focusedWindow: FocusedWindow | null;
  activeApp: string | null;

  // Cached click/element targets: "File menu" → {x, y}
  knownTargets: Record<string, KnownTarget>;

  // Sliding window of recent actions (max 20)
  actionHistory: ActionRecord[];

  // Confidence in current state (0-1)
  confidence: number;

  // Timestamp of last validated state (screenshot or successful action)
  lastValidatedAt: number;

  // Count of screenshots taken this conversation (for metrics)
  screenshotCount: number;

  // Count of skipped focus calls (for metrics)
  skippedFocusCalls: number;
}

// ═══════════════════════════════════
// Constants
// ═══════════════════════════════════

const STALE_AFTER_MS = 30_000;
const MAX_ACTION_HISTORY = 20;
const CONFIDENCE_BOOST = 0.15;
const CONFIDENCE_DECAY = 0.6;   // multiply on error
const MIN_CONFIDENCE_FOR_SKIP = 0.4;

// ═══════════════════════════════════
// Factory
// ═══════════════════════════════════

export function createUIState(): UIState {
  return {
    focusedWindow: null,
    activeApp: null,
    knownTargets: {},
    actionHistory: [],
    confidence: 0,
    lastValidatedAt: 0,
    screenshotCount: 0,
    skippedFocusCalls: 0,
  };
}

// ═══════════════════════════════════
// Queries
// ═══════════════════════════════════

/** Is the given window already focused (and state is fresh)? */
export function isWindowFocused(state: UIState, windowName: string): boolean {
  if (!state.focusedWindow) return false;
  if (state.confidence < MIN_CONFIDENCE_FOR_SKIP) return false;
  if (Date.now() - state.focusedWindow.lastFocusedAt > STALE_AFTER_MS) return false;

  const current = state.focusedWindow.title.toLowerCase();
  const target = windowName.toLowerCase();

  // Direct title substring match (either direction)
  if (current.includes(target) || target.includes(current)) return true;

  // Match against detected app name (handles "GIMP" matching a window titled
  // "*Untitled – GNU Image Manipulation Program" because app was detected as "gimp")
  if (state.focusedWindow.app && state.focusedWindow.app !== 'unknown') {
    if (target === state.focusedWindow.app || state.focusedWindow.app.includes(target)) return true;
  }

  return false;
}

/** Is the state stale (needs re-orientation)? */
export function isStateStale(state: UIState): boolean {
  if (state.confidence < MIN_CONFIDENCE_FOR_SKIP) return true;
  if (state.lastValidatedAt === 0) return true;
  return Date.now() - state.lastValidatedAt > STALE_AFTER_MS;
}

/** Get a compact summary for injection into the dynamic prompt. */
export function getStateSummary(state: UIState): string {
  if (!state.focusedWindow && !state.activeApp) return '';

  const lines: string[] = ['[GUI State]'];
  if (state.focusedWindow) {
    lines.push(`Focused: "${state.focusedWindow.title}" (app: ${state.focusedWindow.app || 'unknown'})`);
  }
  if (state.activeApp) {
    lines.push(`Active app: ${state.activeApp}`);
  }
  lines.push(`Confidence: ${(state.confidence * 100).toFixed(0)}%`);

  const targetKeys = Object.keys(state.knownTargets);
  if (targetKeys.length > 0) {
    lines.push(`Known targets: ${targetKeys.slice(0, 5).join(', ')}${targetKeys.length > 5 ? ` (+${targetKeys.length - 5} more)` : ''}`);
  }

  if (state.skippedFocusCalls > 0) {
    lines.push(`[Perf] Skipped ${state.skippedFocusCalls} redundant focus calls`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════
// Mutations
// ═══════════════════════════════════

/** Record that a window was focused. */
export function recordFocus(state: UIState, title: string, app: string, windowId = ''): void {
  // If switching to a different window, clear known targets (they're window-relative)
  // Use a direct title comparison here to avoid the confidence gate in isWindowFocused
  const isSameWindow = state.focusedWindow &&
    (state.focusedWindow.title.toLowerCase().includes(title.toLowerCase()) ||
     title.toLowerCase().includes(state.focusedWindow.title.toLowerCase()));

  if (state.focusedWindow && !isSameWindow) {
    state.knownTargets = {};
  }

  state.focusedWindow = {
    title,
    id: windowId,
    app: app || detectAppFromTitle(title),
    lastFocusedAt: Date.now(),
  };
  state.activeApp = state.focusedWindow.app;
  // Focusing a window is a strong signal — set confidence to at least the
  // skip threshold so the very next action can benefit from the cache.
  state.confidence = Math.max(MIN_CONFIDENCE_FOR_SKIP, Math.min(1, state.confidence + CONFIDENCE_BOOST));
  state.lastValidatedAt = Date.now();
}

/** Record a successful action — boosts confidence. */
export function recordSuccess(state: UIState, action: string, target?: string): void {
  state.confidence = Math.min(1, state.confidence + CONFIDENCE_BOOST);
  state.lastValidatedAt = Date.now();
  pushAction(state, action, target, 'success');
}

/** Record a failed action — decays confidence. */
export function recordError(state: UIState, action: string, target?: string): void {
  state.confidence *= CONFIDENCE_DECAY;
  pushAction(state, action, target, 'error');
}

/** Record a screenshot was taken (counts for metrics, also validates state). */
export function recordScreenshot(state: UIState): void {
  state.screenshotCount++;
  state.lastValidatedAt = Date.now();
  state.confidence = Math.min(1, state.confidence + CONFIDENCE_BOOST);
}

/**
 * Cache a known target position in-memory.
 * For cross-session persistence, call storeCoordinate() from coordinate-cache.ts
 * with the current app + window title after calling this.
 */
export function cacheTarget(state: UIState, name: string, x: number, y: number): void {
  state.knownTargets[name] = { x, y, confidence: state.confidence, discoveredAt: Date.now() };
}

/**
 * Bulk-load previously persisted coordinates into in-memory state.
 * Called when focus is established on a known app+window combo so that
 * the LLM can immediately use remembered coordinates without a screenshot.
 */
export function loadPersistedTargets(
  state: UIState,
  targets: Array<{ element: string; x: number; y: number; confidence: number }>,
): void {
  for (const t of targets) {
    // Only load if we don't already have a fresher in-memory entry
    const existing = state.knownTargets[t.element];
    if (!existing || existing.confidence < t.confidence) {
      state.knownTargets[t.element] = {
        x: t.x,
        y: t.y,
        confidence: t.confidence,
        discoveredAt: Date.now(),
      };
    }
  }
}

/** Record a skipped focus call (metrics). */
export function recordSkippedFocus(state: UIState): void {
  state.skippedFocusCalls++;
}

/** Full state reset (new conversation or explicit reset). */
export function resetUIState(state: UIState): void {
  state.focusedWindow = null;
  state.activeApp = null;
  state.knownTargets = {};
  state.actionHistory = [];
  state.confidence = 0;
  state.lastValidatedAt = 0;
  state.screenshotCount = 0;
  state.skippedFocusCalls = 0;
}

// ═══════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════

function pushAction(state: UIState, action: string, target: string | undefined, result: 'success' | 'error'): void {
  state.actionHistory.push({ action, target, result, timestamp: Date.now() });
  if (state.actionHistory.length > MAX_ACTION_HISTORY) {
    state.actionHistory.shift();
  }
}

/** Best-effort app detection from window title. */
function detectAppFromTitle(title: string): string {
  const lower = title.toLowerCase();
  const patterns: [RegExp, string][] = [
    [/gimp|gnu image/i, 'gimp'],
    [/libreoffice|soffice/i, 'libreoffice'],
    [/blender/i, 'blender'],
    [/inkscape/i, 'inkscape'],
    [/audacity/i, 'audacity'],
    [/obs/i, 'obs'],
    [/kdenlive/i, 'kdenlive'],
    [/vlc/i, 'vlc'],
    [/spotify/i, 'spotify'],
    [/firefox/i, 'firefox'],
    [/chrom/i, 'chrome'],
    [/code.*oss|visual studio/i, 'vscode'],
    [/krita/i, 'krita'],
    [/darktable/i, 'darktable'],
    [/nautilus|files/i, 'nautilus'],
    [/settings/i, 'gnome-settings'],
    [/terminal|konsole|gnome-terminal/i, 'terminal'],
  ];
  for (const [re, app] of patterns) {
    if (re.test(lower)) return app;
  }
  return 'unknown';
}
