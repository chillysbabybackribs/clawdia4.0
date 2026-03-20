/**
 * Verification Layer — Phase 1
 *
 * Lightweight post-action verification for CLI, browser, and GUI surfaces.
 * Attached after tool execution in the agent loop. Does NOT redesign the loop.
 *
 * Design:
 *   - Each tool executor returns a raw result string (unchanged)
 *   - The verification layer inspects that result against an optional VerificationRule
 *   - Rules are resolved per-tool-call, not globally forced
 *   - Failures are structured and logged separately from execution errors
 *   - Retries are minimal: at most one, via the smallest valid recovery path
 */

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export type Surface = 'cli' | 'browser' | 'gui';

export type VerificationType =
  // CLI
  | 'output_contains'
  | 'exit_code_success'
  | 'file_exists'
  // Browser
  | 'url_changed'
  | 'url_contains'
  | 'dom_contains'
  | 'title_contains'
  | 'element_present'
  // GUI
  | 'window_focused'
  | 'active_window_title'
  | 'file_exists_gui';

export type RetryPolicy = 'none' | 'once' | 'refocus_then_retry';

export interface VerificationRule {
  surface: Surface;
  type: VerificationType;
  expected: string;          // The value to check against
  timeoutMs?: number;        // Max wait for async checks (default 2000)
  retryPolicy?: RetryPolicy; // Default 'none'
}

export interface VerificationResult {
  rule: VerificationRule;
  passed: boolean;
  actual: string;            // What was actually observed
  retried: boolean;
  retryPassed?: boolean;
  durationMs: number;
  error?: string;            // If the verifier itself threw
}

// ═══════════════════════════════════
// Rule Resolution — which tools get verification?
//
// This is opt-in by tool+input. Only high-value actions
// where silent failure is dangerous get rules attached.
// ═══════════════════════════════════

/**
 * Resolve a verification rule for a given tool call.
 * Returns null if this tool call doesn't warrant verification.
 *
 * Context:
 *   - toolName: the tool being called
 *   - input: the tool's input object
 *   - preState: optional pre-action state snapshot (e.g., URL before navigation)
 */
export function resolveVerificationRule(
  toolName: string,
  input: Record<string, any>,
  preState?: { url?: string; windowTitle?: string },
): VerificationRule | null {
  switch (toolName) {

    // ── CLI surface ──

    case 'shell_exec': {
      // Only verify commands that are expected to produce output or files
      const cmd = (input.command || '').trim();

      // File-producing commands: verify the file exists
      const redirectMatch = cmd.match(/>\s*([^\s;&|]+)\s*$/);
      if (redirectMatch) {
        return {
          surface: 'cli',
          type: 'file_exists',
          expected: redirectMatch[1],
          retryPolicy: 'none',
        };
      }

      // Skip verification for bg processes, cd, export, etc.
      if (/^(cd|export|alias|source|\.|\s*$|.*&\s*$)/.test(cmd)) return null;

      // Default: verify command succeeded (exit code 0 implied by no [Error] prefix)
      return {
        surface: 'cli',
        type: 'exit_code_success',
        expected: 'success',
        retryPolicy: 'none',
      };
    }

    case 'file_write': {
      if (!input.path) return null;
      return {
        surface: 'cli',
        type: 'file_exists',
        expected: input.path,
        retryPolicy: 'once',
      };
    }

    // ── Browser surface ──

    case 'browser_navigate': {
      if (!input.url) return null;
      return {
        surface: 'browser',
        type: 'url_changed',
        expected: input.url,
        timeoutMs: 3000,
        retryPolicy: 'once',
      };
    }

    case 'browser_click': {
      // Clicks that should change page state — we verify the elements list updated
      // We can't predict the exact DOM change, so we check for non-error response
      return {
        surface: 'browser',
        type: 'dom_contains',
        expected: 'Clicked',  // clickElement returns "Clicked [n]: ..." on success
        retryPolicy: 'once',
      };
    }

    case 'browser_type': {
      return {
        surface: 'browser',
        type: 'dom_contains',
        expected: 'Typed into',  // typeText returns "Typed into ..." on success
        retryPolicy: 'none',
      };
    }

    // ── GUI surface ──

    case 'gui_interact': {
      const action = input.action;

      if (action === 'focus' || action === 'launch_and_focus') {
        const windowTarget = input.window || input.app || '';
        if (!windowTarget) return null;
        return {
          surface: 'gui',
          type: 'window_focused',
          expected: windowTarget,
          timeoutMs: 3000,
          retryPolicy: 'refocus_then_retry',
        };
      }

      if (action === 'verify_file_exists') {
        return {
          surface: 'gui',
          type: 'file_exists_gui',
          expected: input.path || '',
          retryPolicy: 'none',
        };
      }

      if (action === 'verify_window_title') {
        return {
          surface: 'gui',
          type: 'active_window_title',
          expected: input.text || input.window || '',
          retryPolicy: 'none',
        };
      }

      // batch_actions: verify window focus if a window is specified
      if (action === 'batch_actions' && input.window) {
        return {
          surface: 'gui',
          type: 'window_focused',
          expected: input.window,
          timeoutMs: 2000,
          retryPolicy: 'none',
        };
      }

      return null;
    }

    case 'app_control': {
      // app_control dispatches across surfaces — just verify non-error
      return {
        surface: 'cli',
        type: 'exit_code_success',
        expected: 'success',
        retryPolicy: 'none',
      };
    }

    default:
      return null;
  }
}

// ═══════════════════════════════════
// Verifiers — one per verification type
//
// Each verifier receives the tool's raw result string and the rule.
// Returns { passed, actual }.
// ═══════════════════════════════════

interface VerifyCheck {
  passed: boolean;
  actual: string;
}

function verifyOutputContains(result: string, expected: string): VerifyCheck {
  const found = result.toLowerCase().includes(expected.toLowerCase());
  return {
    passed: found,
    actual: found ? `Contains "${expected}"` : `Output (${result.length} chars) does not contain "${expected}"`,
  };
}

function verifyExitCodeSuccess(result: string): VerifyCheck {
  const isError = result.startsWith('[Error');
  return {
    passed: !isError,
    actual: isError ? `Command failed: ${result.slice(0, 150)}` : 'Exit success',
  };
}

function verifyFileExists(result: string, expectedPath: string): VerifyCheck {
  // For file_write, the executor returns the result — we check if it's an error
  // The actual filesystem check is in the existing verifyFileOutcomes post-loop
  const isError = result.startsWith('[Error');
  return {
    passed: !isError,
    actual: isError ? `File operation failed: ${result.slice(0, 150)}` : `File operation succeeded for ${expectedPath}`,
  };
}

function verifyUrlChanged(result: string, expectedUrl: string): VerifyCheck {
  // browser_navigate result format: "Title: ...\nURL: ...\n\n<page content>\n\n--- Interactive Elements ---\n..."
  //
  // IMPORTANT: Electron's webContents.getURL() returns the *requested* URL even
  // when the load fails (ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_REFUSED, etc.).
  // So domain matching alone is insufficient — we must also check that the page
  // actually loaded real content.

  // Check for error signals first — these indicate the navigation itself failed
  const errorSignals = [
    '[Error: browser_navigate]',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_CERT_',
    'ERR_SSL_',
    'ERR_BLOCKED_BY',
    'net::ERR_',
  ];
  for (const sig of errorSignals) {
    if (result.includes(sig)) {
      return { passed: false, actual: `Navigation error: ${sig}` };
    }
  }

  const urlMatch = result.match(/^URL:\s*(.+)$/m) || result.match(/\nURL:\s*(.+)$/m);
  if (!urlMatch) {
    const hasUrl = result.includes(expectedUrl.replace(/^https?:\/\//, '').split('/')[0]);
    return {
      passed: hasUrl,
      actual: hasUrl ? `Page loaded (domain found in response)` : `Could not extract URL from result`,
    };
  }

  const actualUrl = urlMatch[1].trim();

  // Check that the page has real content — not just Title + URL with empty body.
  // After "URL: ...\n\n", the page content should follow. If it's effectively
  // empty (< 20 chars of non-whitespace after the URL line), the page didn't load.
  const afterUrl = result.slice(result.indexOf(actualUrl) + actualUrl.length);
  const contentText = afterUrl
    .replace(/---\s*Interactive Elements.*$/s, '')  // strip element list
    .replace(/⚠.*$/s, '')                           // strip login warnings
    .trim();
  if (contentText.length < 20) {
    return {
      passed: false,
      actual: `Page has no content (${contentText.length} chars after URL) — likely failed to load`,
    };
  }

  // Domain comparison
  const expectedDomain = expectedUrl.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  const actualDomain = actualUrl.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  const domainMatch = actualDomain.includes(expectedDomain) || expectedDomain.includes(actualDomain);

  return {
    passed: domainMatch,
    actual: domainMatch ? `Navigated to ${actualUrl}` : `Expected domain "${expectedDomain}" but got "${actualDomain}"`,
  };
}

function verifyDomContains(result: string, expected: string): VerifyCheck {
  const found = result.toLowerCase().includes(expected.toLowerCase());
  return {
    passed: found,
    actual: found ? `Result contains "${expected}"` : `Result does not contain "${expected}"`,
  };
}

function verifyTitleContains(result: string, expected: string): VerifyCheck {
  const titleMatch = result.match(/^Title:\s*(.+)$/m);
  if (!titleMatch) return { passed: false, actual: 'No title found in result' };
  const title = titleMatch[1].trim();
  const found = title.toLowerCase().includes(expected.toLowerCase());
  return {
    passed: found,
    actual: found ? `Title "${title}" contains "${expected}"` : `Title "${title}" does not contain "${expected}"`,
  };
}

function verifyWindowFocused(result: string, expectedWindow: string): VerifyCheck {
  const isError = result.startsWith('[Error') || result.includes('not found') || result.includes('failed');
  if (isError) {
    return { passed: false, actual: `Focus failed: ${result.slice(0, 150)}` };
  }
  // gui_interact focus returns the window title or success message
  const lower = result.toLowerCase();
  const expectedLower = expectedWindow.toLowerCase();
  const found = lower.includes(expectedLower) || lower.includes('focused') || lower.includes('launched');
  return {
    passed: found,
    actual: found ? `Window focused: ${result.slice(0, 100)}` : `Focus result unclear: ${result.slice(0, 100)}`,
  };
}

function verifyActiveWindowTitle(result: string, expected: string): VerifyCheck {
  // verify_window_title action returns match/mismatch
  const lower = result.toLowerCase();
  const passed = lower.includes('match') && !lower.includes('mismatch') && !lower.includes('no match');
  return {
    passed,
    actual: result.slice(0, 150),
  };
}

// ═══════════════════════════════════
// Main verify dispatch
// ═══════════════════════════════════

function runCheck(rule: VerificationRule, result: string): VerifyCheck {
  switch (rule.type) {
    case 'output_contains':      return verifyOutputContains(result, rule.expected);
    case 'exit_code_success':    return verifyExitCodeSuccess(result);
    case 'file_exists':          return verifyFileExists(result, rule.expected);
    case 'file_exists_gui':      return verifyFileExists(result, rule.expected);
    case 'url_changed':          return verifyUrlChanged(result, rule.expected);
    case 'url_contains':         return verifyDomContains(result, rule.expected); // reuse
    case 'dom_contains':         return verifyDomContains(result, rule.expected);
    case 'title_contains':       return verifyTitleContains(result, rule.expected);
    case 'element_present':      return verifyDomContains(result, rule.expected); // lightweight
    case 'window_focused':       return verifyWindowFocused(result, rule.expected);
    case 'active_window_title':  return verifyActiveWindowTitle(result, rule.expected);
    default:                     return { passed: true, actual: `Unknown verification type: ${rule.type}` };
  }
}

/**
 * Run verification for a completed tool action.
 *
 * @param rule - The verification rule to check
 * @param result - The raw result string from the tool executor
 * @returns VerificationResult with pass/fail, actual value, retry info
 */
export function verify(rule: VerificationRule, result: string): VerificationResult {
  const start = Date.now();

  try {
    const check = runCheck(rule, result);

    // If passed or no retry policy, return immediately
    if (check.passed || !rule.retryPolicy || rule.retryPolicy === 'none') {
      return {
        rule,
        passed: check.passed,
        actual: check.actual,
        retried: false,
        durationMs: Date.now() - start,
      };
    }

    // RetryPolicy: 'once' or 'refocus_then_retry' — re-check the same result.
    // (Only remaining cases after the guard above — the trailing return is unreachable.)
    // Full live re-execution (re-calling the tool) is a Phase 2 enhancement.
    const retryCheck = runCheck(rule, result);
    return {
      rule,
      passed: retryCheck.passed,
      actual: retryCheck.actual,
      retried: true,
      retryPassed: retryCheck.passed,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      rule,
      passed: false,
      actual: '',
      retried: false,
      durationMs: Date.now() - start,
      error: err.message,
    };
  }
}

// ═══════════════════════════════════
// Logging
// ═══════════════════════════════════

/**
 * Log a verification result in a structured, inspectable format.
 */
export function logVerification(
  toolName: string,
  toolInput: Record<string, any>,
  result: VerificationResult,
): void {
  const status = result.passed ? '✓ PASS' : '✗ FAIL';
  const retryNote = result.retried
    ? ` (retried: ${result.retryPassed ? 'recovered' : 'still failed'})`
    : '';

  console.log(
    `[Verify] ${status} | ${toolName} | ${result.rule.surface}/${result.rule.type}` +
    ` | expected="${result.rule.expected.slice(0, 60)}"` +
    ` | actual="${result.actual.slice(0, 80)}"` +
    `${retryNote}` +
    ` | ${result.durationMs}ms`,
  );

  if (result.error) {
    console.warn(`[Verify] Verifier error: ${result.error}`);
  }
}

// ═══════════════════════════════════
// Supported types summary (for docs)
// ═══════════════════════════════════

export const SUPPORTED_VERIFICATION_TYPES = {
  cli: ['output_contains', 'exit_code_success', 'file_exists'],
  browser: ['url_changed', 'url_contains', 'dom_contains', 'title_contains', 'element_present'],
  gui: ['window_focused', 'active_window_title', 'file_exists_gui'],
} as const;
