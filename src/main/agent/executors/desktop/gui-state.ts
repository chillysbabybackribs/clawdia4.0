import {
  type UIState,
  createUIState,
  resetUIState,
} from '../../gui/ui-state';
import {
  pruneCoordinateCache,
  warmUIStateFromCache,
} from '../../../db/coordinate-cache';

// ═══════════════════════════════════
// GUI State — Module-level singleton per conversation
// ═══════════════════════════════════

export let guiState: UIState = createUIState();

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
