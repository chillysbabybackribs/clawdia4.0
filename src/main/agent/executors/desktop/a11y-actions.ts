import {
  a11yGetTree, a11yFind, a11yDoAction, a11ySetValue, a11yGetState, a11yListApps,
  isA11yAvailable,
} from '../../gui/a11y';
import {
  recordSuccess,
} from '../../gui/ui-state';
import { guiState } from './gui-state';

/**
 * Handle AT-SPI accessibility actions.
 * Returns null for any action this handler does not own.
 */
export async function execA11yAction(
  input: Record<string, any>,
  batchWindow?: string,
): Promise<string | null> {
  const { action, window: winName, text } = input;
  const effectiveWindow = winName || batchWindow;

  switch (action) {
    case 'a11y_get_tree': {
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
      return null;
  }
}
