/**
 * Verification Layer — Phase 1 Tests
 *
 * Unit tests for the verification module. These run without Electron,
 * testing the pure logic: rule resolution, verifiers, and logging.
 *
 * Run: npx tsx tests/verification-test.ts
 */

import {
  resolveVerificationRule,
  verify,
  logVerification,
  SUPPORTED_VERIFICATION_TYPES,
  type VerificationRule,
} from '../src/main/agent/verification';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

// ═══════════════════════════════════
// 1. Rule Resolution
// ═══════════════════════════════════

console.log('\n═══ Rule Resolution ═══');

// shell_exec: basic command
{
  const rule = resolveVerificationRule('shell_exec', { command: 'echo hello' });
  assert(rule !== null, 'shell_exec basic command gets a rule');
  assert(rule?.surface === 'cli', 'shell_exec rule surface is cli');
  assert(rule?.type === 'exit_code_success', 'shell_exec rule type is exit_code_success');
}

// shell_exec: redirect to file
{
  const rule = resolveVerificationRule('shell_exec', { command: 'echo test > /tmp/out.txt' });
  assert(rule !== null, 'shell_exec redirect gets a rule');
  assert(rule?.type === 'file_exists', 'shell_exec redirect type is file_exists');
  assert(rule?.expected === '/tmp/out.txt', 'shell_exec redirect expected path is correct');
}

// shell_exec: background process — no rule
{
  const rule = resolveVerificationRule('shell_exec', { command: 'gimp &' });
  assert(rule === null, 'shell_exec background process gets no rule');
}

// shell_exec: cd — no rule
{
  const rule = resolveVerificationRule('shell_exec', { command: 'cd /home/user' });
  assert(rule === null, 'shell_exec cd gets no rule');
}

// file_write: gets file_exists rule
{
  const rule = resolveVerificationRule('file_write', { path: '/tmp/test.txt', content: 'hello' });
  assert(rule !== null, 'file_write gets a rule');
  assert(rule?.type === 'file_exists', 'file_write type is file_exists');
  assert(rule?.expected === '/tmp/test.txt', 'file_write expected path correct');
  assert(rule?.retryPolicy === 'once', 'file_write retry policy is once');
}

// browser_navigate: gets url_changed rule
{
  const rule = resolveVerificationRule('browser_navigate', { url: 'https://example.com' });
  assert(rule !== null, 'browser_navigate gets a rule');
  assert(rule?.surface === 'browser', 'browser_navigate surface is browser');
  assert(rule?.type === 'url_changed', 'browser_navigate type is url_changed');
}

// browser_click: gets dom_contains rule
{
  const rule = resolveVerificationRule('browser_click', { target: 'Submit' });
  assert(rule !== null, 'browser_click gets a rule');
  assert(rule?.type === 'dom_contains', 'browser_click type is dom_contains');
  assert(rule?.expected === 'Clicked', 'browser_click expected is "Clicked"');
}

// gui_interact focus: gets window_focused rule
{
  const rule = resolveVerificationRule('gui_interact', { action: 'focus', window: 'GIMP' });
  assert(rule !== null, 'gui_interact focus gets a rule');
  assert(rule?.surface === 'gui', 'gui_interact focus surface is gui');
  assert(rule?.type === 'window_focused', 'gui_interact focus type is window_focused');
  assert(rule?.retryPolicy === 'refocus_then_retry', 'gui_interact focus retry is refocus_then_retry');
}

// gui_interact launch_and_focus: gets window_focused rule
{
  const rule = resolveVerificationRule('gui_interact', { action: 'launch_and_focus', app: 'gimp' });
  assert(rule !== null, 'gui_interact launch_and_focus gets a rule');
  assert(rule?.type === 'window_focused', 'launch_and_focus type is window_focused');
}

// gui_interact click (no specific verification): returns null
{
  const rule = resolveVerificationRule('gui_interact', { action: 'click', x: 100, y: 200 });
  assert(rule === null, 'gui_interact click (no verification rule)');
}

// memory_search: no rule (low-value)
{
  const rule = resolveVerificationRule('memory_search', { query: 'test' });
  assert(rule === null, 'memory_search gets no rule');
}

// browser_read_page: no rule (read-only)
{
  const rule = resolveVerificationRule('browser_read_page', {});
  assert(rule === null, 'browser_read_page gets no rule');
}

// ═══════════════════════════════════
// 2. CLI Verifiers
// ═══════════════════════════════════

console.log('\n═══ CLI Verifiers ═══');

// exit_code_success: pass
{
  const rule: VerificationRule = { surface: 'cli', type: 'exit_code_success', expected: 'success' };
  const result = verify(rule, 'Hello world\nDone');
  assert(result.passed === true, 'exit_code_success passes on clean output');
  assert(result.actual === 'Exit success', 'exit_code_success actual is "Exit success"');
  logVerification('shell_exec', { command: 'echo hello' }, result);
}

// exit_code_success: fail
{
  const rule: VerificationRule = { surface: 'cli', type: 'exit_code_success', expected: 'success' };
  const result = verify(rule, '[Error] command not found: foobar');
  assert(result.passed === false, 'exit_code_success fails on [Error] prefix');
  logVerification('shell_exec', { command: 'foobar' }, result);
}

// output_contains: pass
{
  const rule: VerificationRule = { surface: 'cli', type: 'output_contains', expected: 'verification-ok' };
  const result = verify(rule, 'some output\nverification-ok\nmore stuff');
  assert(result.passed === true, 'output_contains finds expected text');
}

// output_contains: fail
{
  const rule: VerificationRule = { surface: 'cli', type: 'output_contains', expected: 'verification-ok' };
  const result = verify(rule, 'some output\nbut no marker\n');
  assert(result.passed === false, 'output_contains fails when text missing');
  logVerification('shell_exec', { command: 'echo test' }, result);
}

// file_exists: pass (non-error result)
{
  const rule: VerificationRule = { surface: 'cli', type: 'file_exists', expected: '/tmp/test.txt' };
  const result = verify(rule, 'Wrote 42 bytes to /tmp/test.txt');
  assert(result.passed === true, 'file_exists passes on non-error result');
}

// file_exists: fail (error result)
{
  const rule: VerificationRule = { surface: 'cli', type: 'file_exists', expected: '/tmp/test.txt' };
  const result = verify(rule, '[Error] Permission denied');
  assert(result.passed === false, 'file_exists fails on [Error] result');
  logVerification('file_write', { path: '/tmp/test.txt' }, result);
}

// ═══════════════════════════════════
// 3. Browser Verifiers
// ═══════════════════════════════════

console.log('\n═══ Browser Verifiers ═══');

// url_changed: pass (domain match with real content)
{
  const rule: VerificationRule = { surface: 'browser', type: 'url_changed', expected: 'https://example.com/page' };
  const result = verify(rule, 'Title: Example Page\nURL: https://example.com/page?q=1\n\nSome content here that is long enough to count as real page content loaded successfully');
  assert(result.passed === true, 'url_changed passes on domain match');
  logVerification('browser_navigate', { url: 'https://example.com/page' }, result);
}

// url_changed: fail (different domain)
{
  const rule: VerificationRule = { surface: 'browser', type: 'url_changed', expected: 'https://example.com' };
  const result = verify(rule, 'Title: Login\nURL: https://login.provider.com/oauth\n\nPlease sign in with your account to continue');
  assert(result.passed === false, 'url_changed fails on domain mismatch');
  logVerification('browser_navigate', { url: 'https://example.com' }, result);
}

// url_changed: fail — DNS failure (Electron reports requested URL but page body is empty)
{
  const rule: VerificationRule = { surface: 'browser', type: 'url_changed', expected: 'https://thisdomaindoesnotexist99999.com' };
  const result = verify(rule, 'Title: thisdomaindoesnotexist99999.com\nURL: https://thisdomaindoesnotexist99999.com/\n\n');
  assert(result.passed === false, 'url_changed fails on empty page body (DNS failure)');
  logVerification('browser_navigate', { url: 'https://thisdomaindoesnotexist99999.com' }, result);
}

// url_changed: fail — error signal in result
{
  const rule: VerificationRule = { surface: 'browser', type: 'url_changed', expected: 'https://bad.example.com' };
  const result = verify(rule, '[Error: browser_navigate] ERR_NAME_NOT_RESOLVED');
  assert(result.passed === false, 'url_changed fails on ERR_NAME_NOT_RESOLVED error');
  logVerification('browser_navigate', { url: 'https://bad.example.com' }, result);
}

// dom_contains: pass (click result)
{
  const rule: VerificationRule = { surface: 'browser', type: 'dom_contains', expected: 'Clicked' };
  const result = verify(rule, 'Clicked [3]: Submit Button\n\n--- Interactive Elements (after click) ---\n[0] button "Done"');
  assert(result.passed === true, 'dom_contains passes when "Clicked" found');
  logVerification('browser_click', { target: 'Submit' }, result);
}

// dom_contains: fail (click error)
{
  const rule: VerificationRule = { surface: 'browser', type: 'dom_contains', expected: 'Clicked' };
  const result = verify(rule, 'Error: No match "NonexistentButton"');
  assert(result.passed === false, 'dom_contains fails when click errored');
  logVerification('browser_click', { target: 'NonexistentButton' }, result);
}

// title_contains: pass
{
  const rule: VerificationRule = { surface: 'browser', type: 'title_contains', expected: 'Dashboard' };
  const result = verify(rule, 'Title: My Dashboard - App\nURL: https://app.com/dashboard\n\nContent');
  assert(result.passed === true, 'title_contains passes when title matches');
}

// title_contains: fail
{
  const rule: VerificationRule = { surface: 'browser', type: 'title_contains', expected: 'Dashboard' };
  const result = verify(rule, 'Title: Login Page\nURL: https://app.com/login');
  assert(result.passed === false, 'title_contains fails when title does not match');
}

// ═══════════════════════════════════
// 4. GUI Verifiers
// ═══════════════════════════════════

console.log('\n═══ GUI Verifiers ═══');

// window_focused: pass
{
  const rule: VerificationRule = { surface: 'gui', type: 'window_focused', expected: 'GIMP' };
  const result = verify(rule, 'Focused window: *Untitled - GNU Image Manipulation Program');
  assert(result.passed === true, 'window_focused passes on focused result');
  logVerification('gui_interact', { action: 'focus', window: 'GIMP' }, result);
}

// window_focused: fail
{
  const rule: VerificationRule = { surface: 'gui', type: 'window_focused', expected: 'GIMP' };
  const result = verify(rule, '[Error] Window not found: GIMP');
  assert(result.passed === false, 'window_focused fails on error result');
  logVerification('gui_interact', { action: 'focus', window: 'GIMP' }, result);
}

// active_window_title: pass
{
  const rule: VerificationRule = { surface: 'gui', type: 'active_window_title', expected: 'GIMP' };
  const result = verify(rule, 'Window title match: "GIMP"');
  assert(result.passed === true, 'active_window_title passes on match');
}

// active_window_title: fail
{
  const rule: VerificationRule = { surface: 'gui', type: 'active_window_title', expected: 'GIMP' };
  const result = verify(rule, 'Mismatch: expected "GIMP" but got "Firefox"');
  assert(result.passed === false, 'active_window_title fails on mismatch');
}

// ═══════════════════════════════════
// 5. Failure Path — impossible verification
// ═══════════════════════════════════

console.log('\n═══ Failure Path ═══');

{
  const rule: VerificationRule = { surface: 'cli', type: 'output_contains', expected: 'IMPOSSIBLE_STRING_THAT_WILL_NEVER_APPEAR' };
  const result = verify(rule, 'Hello world');
  assert(result.passed === false, 'Impossible verification correctly fails');
  assert(result.retried === false, 'No retry storm — retried is false');
  assert(result.durationMs < 100, `Fast failure (${result.durationMs}ms < 100ms)`);
  logVerification('shell_exec', { command: 'echo hello' }, result);
}

// ═══════════════════════════════════
// 6. Supported types check
// ═══════════════════════════════════

console.log('\n═══ Supported Types ═══');
assert(SUPPORTED_VERIFICATION_TYPES.cli.length === 3, `CLI has 3 types: ${SUPPORTED_VERIFICATION_TYPES.cli.join(', ')}`);
assert(SUPPORTED_VERIFICATION_TYPES.browser.length === 5, `Browser has 5 types: ${SUPPORTED_VERIFICATION_TYPES.browser.join(', ')}`);
assert(SUPPORTED_VERIFICATION_TYPES.gui.length === 3, `GUI has 3 types: ${SUPPORTED_VERIFICATION_TYPES.gui.join(', ')}`);

// ═══════════════════════════════════
// Summary
// ═══════════════════════════════════

console.log(`\n${'═'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(40)}\n`);

if (failed > 0) {
  process.exit(1);
}
