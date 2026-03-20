import { getDb } from '../../../db/database';
import {
  loadPersistedTargets,
  isWindowFocused,
  recordFocus,
  recordError,
  recordSkippedFocus,
} from '../../gui/ui-state';
import { run, cmdExists, wait } from './shared';
import { guiState } from './gui-state';

/**
 * Focus a window, but SKIP if the state says it's already focused.
 * On first focus of a known app+window, loads persisted coordinates from the
 * coordinate cache so the LLM can immediately use remembered targets.
 * Returns true if focus was actually performed, false if skipped.
 */
export async function smartFocus(winName: string): Promise<{ focused: boolean; skipped: boolean }> {
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
