/**
 * AT-SPI Accessibility Adapter — V1
 *
 * TypeScript wrapper around a11y-bridge.py.
 * Provides structured GUI access for menus, buttons, text fields, and dialogs
 * before falling back to raw gui_interact.
 *
 * This is surface #4 in the execution priority:
 *   1. native CLI → 2. CLI-Anything → 3. browser/session → 4. AT-SPI → 5. raw gui_interact
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);
const TIMEOUT = 10_000;

// ═══════════════════════════════════
// Availability Check
// ═══════════════════════════════════

let a11yAvailable: boolean | null = null; // null = not checked yet

/**
 * Check if AT-SPI bridge is available (gir1.2-atspi-2.0 installed).
 * Result is cached after first check.
 */
export async function isA11yAvailable(): Promise<boolean> {
  if (a11yAvailable !== null) return a11yAvailable;

  try {
    await execAsync(
      'python3 -c "import gi; gi.require_version(\'Atspi\', \'2.0\')" 2>/dev/null',
      { timeout: 3000 },
    );
    a11yAvailable = true;
    console.log('[a11y] AT-SPI bridge available');
  } catch {
    a11yAvailable = false;
    console.log('[a11y] AT-SPI not available (install: sudo apt install gir1.2-atspi-2.0)');
  }
  return a11yAvailable;
}

// ═══════════════════════════════════
// Bridge Execution
// ═══════════════════════════════════

/** Resolve path to a11y-bridge.py (works in dev + dist). */
function getBridgePath(): string {
  const projectRoot = path.join(__dirname, '..', '..', '..', '..');
  const srcPath = path.join(projectRoot, 'src', 'main', 'agent', 'gui', 'a11y-bridge.py');
  if (fs.existsSync(srcPath)) return srcPath;
  // Fallback for dist
  return path.join(__dirname, '..', 'gui', 'a11y-bridge.py');
}

interface A11yResult {
  error?: string;
  [key: string]: any;
}

/**
 * Call the AT-SPI bridge with the given operation and arguments.
 * Returns parsed JSON result or error object.
 */
async function callBridge(operation: string, args: Record<string, string | number>): Promise<A11yResult> {
  if (!await isA11yAvailable()) {
    return { error: 'AT-SPI not available' };
  }

  const bridgePath = getBridgePath();
  const argParts = [operation];
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null && value !== '') {
      argParts.push(`--${key}`, `"${String(value).replace(/"/g, '\\"')}"`);
    }
  }

  const cmd = `python3 "${bridgePath}" ${argParts.join(' ')}`;
  console.log(`[a11y] ${cmd.slice(0, 120)}`);

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: TIMEOUT,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    });

    if (stderr.trim()) {
      console.log(`[a11y] stderr: ${stderr.trim().slice(0, 200)}`);
    }

    if (!stdout.trim()) {
      return { error: 'Bridge returned no output' };
    }

    try {
      return JSON.parse(stdout);
    } catch {
      return { error: `Failed to parse bridge output: ${stdout.slice(0, 200)}` };
    }
  } catch (err: any) {
    return { error: `Bridge execution failed: ${err.message?.slice(0, 200)}` };
  }
}

// ═══════════════════════════════════
// Public API
// ═══════════════════════════════════

/**
 * Get a compact accessibility tree for an app/window.
 */
export async function a11yGetTree(
  app: string,
  scope?: string,
  depth?: number,
): Promise<A11yResult> {
  const args: Record<string, string | number> = { app };
  if (scope) args.scope = scope;
  if (depth) args.depth = depth;
  return callBridge('get_tree', args);
}

/**
 * Find a single element by role + name.
 */
export async function a11yFind(
  app: string,
  role: string,
  name: string,
  scope?: string,
): Promise<A11yResult> {
  const args: Record<string, string | number> = { app, role, name };
  if (scope) args.scope = scope;
  return callBridge('find', args);
}

/**
 * Execute a semantic action (click, activate, press, toggle) on an element.
 */
export async function a11yDoAction(
  app: string,
  role: string,
  name: string,
  action: string,
  scope?: string,
): Promise<A11yResult> {
  const args: Record<string, string | number> = { app, role, name, action };
  if (scope) args.scope = scope;
  return callBridge('do_action', args);
}

/**
 * Set text/value on an entry-like control.
 */
export async function a11ySetValue(
  app: string,
  role: string,
  name: string,
  value: string,
  scope?: string,
): Promise<A11yResult> {
  const args: Record<string, string | number> = { app, role, name, value };
  if (scope) args.scope = scope;
  return callBridge('set_value', args);
}

/**
 * Read state/value of an element.
 */
export async function a11yGetState(
  app: string,
  role: string,
  name: string,
  scope?: string,
): Promise<A11yResult> {
  const args: Record<string, string | number> = { app, role, name };
  if (scope) args.scope = scope;
  return callBridge('get_state', args);
}

/**
 * List apps visible to AT-SPI.
 */
export async function a11yListApps(): Promise<A11yResult> {
  return callBridge('list_apps', {});
}

/**
 * Determine if a task can be handled by the AT-SPI layer.
 * Returns true for menu, dialog, button, and text-field tasks.
 * Returns false for canvas, drawing, drag-drop, and custom widget tasks.
 */
export function isA11yCandidate(userMessage: string): boolean {
  // Tasks that AT-SPI handles well
  const A11Y_PATTERNS = /\b(menu|dialog|button|text\s+field|form|settings|preferences|save\s+as|export\s+as|new\s+image|scale\s+image|resize|spin\s+button|check\s*box|radio\s+button|combo\s*box|dropdown|tab|file\s+chooser)\b/i;

  // Tasks that require raw GUI (canvas, drawing, etc.)
  const RAW_GUI_PATTERNS = /\b(canvas|draw|paint|brush|pencil|lasso|select.*region|drag|drop|color\s+pick|zoom\s+tool|clone|stamp|gradient\s+tool)\b/i;

  if (RAW_GUI_PATTERNS.test(userMessage)) return false;
  return A11Y_PATTERNS.test(userMessage);
}
