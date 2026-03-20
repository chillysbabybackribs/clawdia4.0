import {
  cacheTarget,
  recordScreenshot,
} from '../../gui/ui-state';
import {
  storeCoordinate,
} from '../../../db/coordinate-cache';
import { run, cmdExists, wait } from './shared';
import { guiState } from './gui-state';
import { runScreenshotAnalyzer } from './screenshot-analyzer';

// ═══════════════════════════════════
// Macro Step Tracing
// ═══════════════════════════════════

export interface MacroTrace {
  macro: string;
  steps: { step: number; action: string; detail: string; result: 'ok' | 'skip' | 'fail'; durationMs: number }[];
  totalMs: number;
}

export function createMacroTrace(name: string): { trace: MacroTrace; step: (action: string, detail: string, fn: () => Promise<string>) => Promise<string>; finish: () => string } {
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
export function shouldVerifyAction(
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
export async function postActionVerify(windowTitle?: string): Promise<string> {
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
