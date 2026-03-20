import { execPrimitiveAction } from './gui-primitives';
import { execMacroAction } from './gui-macros';
import { execA11yAction } from './a11y-actions';
import { guiState } from './gui-state';
import {
  recordError,
} from '../../gui/ui-state';

async function execSingleAction(input: Record<string, any>, batchWindow?: string): Promise<string> {
  const result = await execPrimitiveAction(input, batchWindow)
               ?? await execMacroAction(input, batchWindow)
               ?? await execA11yAction(input, batchWindow);
  return result ?? `[Error] Unknown action: "${input.action}"`;
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

    const stateNote = guiState.skippedFocusCalls > 0
      ? `\n[State] Skipped ${guiState.skippedFocusCalls} redundant focus calls (window already focused)`
      : '';
    return results.join('\n') + stateNote;
  }

  return await execSingleAction(input);
}
