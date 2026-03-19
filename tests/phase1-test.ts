/**
 * Phase 1 Unit Tests — UI State Cache + Shortcut Registry
 * 
 * Run:  npx tsx tests/phase1-test.ts
 * 
 * No test framework needed. Prints pass/fail with colors.
 * Tests the pure logic modules (no Electron, no shell, no LLM).
 */

// ── Inline test harness ────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

function section(name: string): void {
  console.log(`\n━━━ ${name} ━━━`);
}

// ── Import modules under test ──────────────────────────

import {
  createUIState,
  isWindowFocused,
  isStateStale,
  getStateSummary,
  recordFocus,
  recordSuccess,
  recordError,
  recordScreenshot,
  recordSkippedFocus,
  cacheTarget,
  resetUIState,
  type UIState,
} from '../src/main/agent/gui/ui-state';

import {
  getShortcuts,
  resolveShortcut,
  getShortcutPromptBlock,
  listRegisteredApps,
} from '../src/main/agent/gui/shortcuts';

// ════════════════════════════════════════════════════════
// UI STATE TESTS
// ════════════════════════════════════════════════════════

section('UIState — createUIState');
{
  const s = createUIState();
  assert(s.focusedWindow === null, 'Initial focusedWindow is null');
  assert(s.activeApp === null, 'Initial activeApp is null');
  assert(s.confidence === 0, 'Initial confidence is 0');
  assert(s.lastValidatedAt === 0, 'Initial lastValidatedAt is 0');
  assert(s.screenshotCount === 0, 'Initial screenshotCount is 0');
  assert(s.skippedFocusCalls === 0, 'Initial skippedFocusCalls is 0');
  assert(Object.keys(s.knownTargets).length === 0, 'Initial knownTargets is empty');
  assert(s.actionHistory.length === 0, 'Initial actionHistory is empty');
}

section('UIState — recordFocus');
{
  const s = createUIState();
  recordFocus(s, '*Untitled – GNU Image Manipulation Program', 'gimp', '12345');
  assert(s.focusedWindow !== null, 'focusedWindow is set after recordFocus');
  assert(s.focusedWindow!.title === '*Untitled – GNU Image Manipulation Program', 'Title matches');
  assert(s.focusedWindow!.app === 'gimp', 'App matches explicit param');
  assert(s.focusedWindow!.id === '12345', 'Window ID matches');
  assert(s.activeApp === 'gimp', 'activeApp set');
  assert(s.confidence > 0, 'Confidence boosted from 0');
  assert(s.lastValidatedAt > 0, 'lastValidatedAt updated');
}

section('UIState — recordFocus with auto-detect');
{
  const s = createUIState();
  // Pass empty app string to test auto-detection from title
  recordFocus(s, 'Untitled 1 - LibreOffice Writer', '');
  assert(s.focusedWindow!.app === 'libreoffice', 'Auto-detected libreoffice from title');
}

section('UIState — recordFocus auto-detect various apps');
{
  const testCases: [string, string][] = [
    ['*Untitled – GNU Image Manipulation Program', 'gimp'],
    ['Untitled 1 - LibreOffice Writer', 'libreoffice'],
    ['Blender [/home/user/scene.blend]', 'blender'],
    ['Spotify Premium', 'spotify'],
    ['file:///home — Files', 'nautilus'],
    ['Visual Studio Code', 'vscode'],
    ['Mozilla Firefox', 'firefox'],
    ['Something Random', 'unknown'],
  ];
  for (const [title, expected] of testCases) {
    const s = createUIState();
    recordFocus(s, title, '');
    assert(s.focusedWindow!.app === expected, `"${title.slice(0, 30)}..." → ${expected} (got: ${s.focusedWindow!.app})`);
  }
}

section('UIState — isWindowFocused');
{
  const s = createUIState();
  assert(!isWindowFocused(s, 'GIMP'), 'Not focused when state is empty');

  recordFocus(s, '*Untitled – GIMP', 'gimp');
  assert(isWindowFocused(s, 'GIMP'), 'Focused: exact substring match');
  assert(isWindowFocused(s, 'gimp'), 'Focused: case-insensitive match');
  assert(isWindowFocused(s, '*Untitled – GIMP'), 'Focused: full title match');
  assert(!isWindowFocused(s, 'LibreOffice'), 'Not focused: different window');
}

section('UIState — isWindowFocused respects confidence');
{
  const s = createUIState();
  recordFocus(s, 'GIMP', 'gimp');
  assert(isWindowFocused(s, 'GIMP'), 'Focused with good confidence');

  // Hammer confidence down with errors
  recordError(s, 'click');
  recordError(s, 'click');
  recordError(s, 'click');
  recordError(s, 'click');
  recordError(s, 'click');
  assert(!isWindowFocused(s, 'GIMP'), 'Not focused when confidence decayed below threshold');
}

section('UIState — isWindowFocused respects staleness');
{
  const s = createUIState();
  recordFocus(s, 'GIMP', 'gimp');
  // Manually backdate the focus timestamp
  s.focusedWindow!.lastFocusedAt = Date.now() - 60_000; // 60s ago
  assert(!isWindowFocused(s, 'GIMP'), 'Not focused when stale (60s ago)');
}

section('UIState — isStateStale');
{
  const s = createUIState();
  assert(isStateStale(s), 'Stale when brand new (never validated)');

  recordFocus(s, 'GIMP', 'gimp');
  assert(!isStateStale(s), 'Not stale right after focus');

  s.lastValidatedAt = Date.now() - 60_000;
  assert(isStateStale(s), 'Stale when lastValidatedAt is old');
}

section('UIState — confidence boost and decay');
{
  const s = createUIState();
  recordFocus(s, 'GIMP', 'gimp');
  const afterFocus = s.confidence;
  assert(afterFocus === 0.4, `Confidence after focus: ${afterFocus} (expected 0.4 = MIN_CONFIDENCE_FOR_SKIP)`);

  recordSuccess(s, 'click');
  assert(s.confidence === 0.55, `Confidence after success: ${s.confidence} (expected 0.55 = 0.4 + 0.15)`);

  recordSuccess(s, 'key');
  recordSuccess(s, 'type');
  recordSuccess(s, 'key');
  recordSuccess(s, 'key');
  recordSuccess(s, 'key');
  assert(s.confidence <= 1.0, `Confidence capped at 1.0: ${s.confidence}`);

  // Now decay
  recordError(s, 'click');
  const afterError = s.confidence;
  assert(afterError < 1.0, `Confidence decayed after error: ${afterError}`);
  assert(afterError === 1.0 * 0.6, `Decay is multiplicative ×0.6: ${afterError} (expected 0.6)`);
}

section('UIState — actionHistory sliding window');
{
  const s = createUIState();
  for (let i = 0; i < 25; i++) {
    recordSuccess(s, `action-${i}`);
  }
  assert(s.actionHistory.length === 20, `History capped at 20 (got ${s.actionHistory.length})`);
  assert(s.actionHistory[0].action === 'action-5', `Oldest is action-5 (got ${s.actionHistory[0].action})`);
  assert(s.actionHistory[19].action === 'action-24', `Newest is action-24 (got ${s.actionHistory[19].action})`);
}

section('UIState — cacheTarget');
{
  const s = createUIState();
  recordFocus(s, 'GIMP', 'gimp');
  cacheTarget(s, 'File menu', 30, 14);
  assert(s.knownTargets['File menu'] !== undefined, 'Target cached');
  assert(s.knownTargets['File menu'].x === 30, 'X correct');
  assert(s.knownTargets['File menu'].y === 14, 'Y correct');
}

section('UIState — knownTargets cleared on window switch');
{
  const s = createUIState();
  recordFocus(s, 'GIMP', 'gimp');
  cacheTarget(s, 'File menu', 30, 14);
  assert(Object.keys(s.knownTargets).length === 1, 'Has cached target');

  recordFocus(s, 'LibreOffice Writer', 'libreoffice');
  assert(Object.keys(s.knownTargets).length === 0, 'Targets cleared on window switch');
}

section('UIState — recordScreenshot');
{
  const s = createUIState();
  recordScreenshot(s);
  assert(s.screenshotCount === 1, 'Screenshot count incremented');
  assert(s.lastValidatedAt > 0, 'lastValidatedAt updated');
  assert(s.confidence > 0, 'Confidence boosted');
}

section('UIState — recordSkippedFocus');
{
  const s = createUIState();
  recordSkippedFocus(s);
  recordSkippedFocus(s);
  recordSkippedFocus(s);
  assert(s.skippedFocusCalls === 3, 'Skipped focus count tracked');
}

section('UIState — getStateSummary');
{
  const s = createUIState();
  assert(getStateSummary(s) === '', 'Empty summary when no state');

  recordFocus(s, 'GIMP', 'gimp');
  cacheTarget(s, 'File menu', 30, 14);
  const summary = getStateSummary(s);
  assert(summary.includes('[GUI State]'), 'Summary has header');
  assert(summary.includes('GIMP'), 'Summary includes window title');
  assert(summary.includes('gimp'), 'Summary includes app name');
  assert(summary.includes('Confidence'), 'Summary includes confidence');
  assert(summary.includes('File menu'), 'Summary includes known targets');
}

section('UIState — resetUIState');
{
  const s = createUIState();
  recordFocus(s, 'GIMP', 'gimp');
  recordSuccess(s, 'click');
  recordScreenshot(s);
  cacheTarget(s, 'File menu', 30, 14);

  resetUIState(s);
  assert(s.focusedWindow === null, 'focusedWindow reset');
  assert(s.activeApp === null, 'activeApp reset');
  assert(s.confidence === 0, 'confidence reset');
  assert(s.screenshotCount === 0, 'screenshotCount reset');
  assert(Object.keys(s.knownTargets).length === 0, 'knownTargets reset');
  assert(s.actionHistory.length === 0, 'actionHistory reset');
}

// ════════════════════════════════════════════════════════
// SHORTCUT REGISTRY TESTS
// ════════════════════════════════════════════════════════

section('Shortcuts — listRegisteredApps');
{
  const apps = listRegisteredApps();
  assert(apps.includes('gimp'), 'GIMP registered');
  assert(apps.includes('libreoffice'), 'LibreOffice registered');
  assert(apps.includes('blender'), 'Blender registered');
  assert(apps.includes('inkscape'), 'Inkscape registered');
  assert(!apps.includes('_universal'), 'Universal is not listed as an app');
}

section('Shortcuts — getShortcuts (GIMP)');
{
  const shortcuts = getShortcuts('gimp');
  assert(shortcuts !== null, 'GIMP shortcuts exist');
  assert(shortcuts!.app === 'gimp', 'App name correct');
  assert(shortcuts!.displayName === 'GIMP', 'Display name correct');
  assert(shortcuts!.shortcuts['new_image'] === 'ctrl+n', 'new_image → ctrl+n');
  assert(shortcuts!.shortcuts['export_as'] === 'ctrl+shift+e', 'export_as → ctrl+shift+e');
  assert(shortcuts!.shortcuts['text_tool'] === 't', 'text_tool → t');
  // Universal shortcuts merged in
  assert(shortcuts!.shortcuts['undo'] === 'ctrl+z', 'undo merged (GIMP-specific or universal)');
  assert(shortcuts!.shortcuts['confirm_dialog'] === 'Return', 'confirm_dialog from universal');
}

section('Shortcuts — getShortcuts (case insensitive)');
{
  assert(getShortcuts('GIMP') !== null, 'GIMP (uppercase) works');
  assert(getShortcuts('Gimp') !== null, 'Gimp (mixed) works');
}

section('Shortcuts — getShortcuts (unknown app)');
{
  assert(getShortcuts('notepad') === null, 'Unknown app returns null');
}

section('Shortcuts — resolveShortcut');
{
  assert(resolveShortcut('gimp', 'new_image') === 'ctrl+n', 'GIMP new_image resolves');
  assert(resolveShortcut('gimp', 'export_as') === 'ctrl+shift+e', 'GIMP export_as resolves');
  assert(resolveShortcut('gimp', 'nonexistent') === null, 'Unknown intent returns null from app');
  // Universal fallback
  assert(resolveShortcut('unknown_app', 'undo') === 'ctrl+z', 'Universal fallback for unknown app');
  assert(resolveShortcut('unknown_app', 'nonexistent') === null, 'Truly unknown returns null');
}

section('Shortcuts — getShortcutPromptBlock');
{
  const block = getShortcutPromptBlock('gimp');
  assert(block.includes('[Keyboard shortcuts for GIMP]'), 'Has header');
  assert(block.includes('new_image: ctrl+n'), 'Includes new_image shortcut');
  assert(block.includes('export_as: ctrl+shift+e'), 'Includes export_as shortcut');
  assert(block.includes('text_tool: t'), 'Includes text_tool shortcut');
  assert(block.includes('confirm_dialog: Return'), 'Includes confirm_dialog');
  // Should NOT include every single shortcut (only priority intents)
  assert(!block.includes('paintbrush'), 'Does NOT include low-priority shortcuts');
  assert(!block.includes('measure_tool'), 'Does NOT include measure_tool');
}

section('Shortcuts — getShortcutPromptBlock (unknown app)');
{
  const block = getShortcutPromptBlock('notepad');
  assert(block === '', 'Unknown app returns empty string');
}

section('Shortcuts — LibreOffice shortcuts');
{
  const shortcuts = getShortcuts('libreoffice');
  assert(shortcuts !== null, 'LibreOffice shortcuts exist');
  assert(shortcuts!.shortcuts['bold'] === 'ctrl+b', 'bold → ctrl+b');
  assert(shortcuts!.shortcuts['save'] === 'ctrl+s', 'save → ctrl+s');
  assert(shortcuts!.shortcuts['find_replace'] === 'ctrl+h', 'find_replace → ctrl+h');
}

// ════════════════════════════════════════════════════════
// INTEGRATION-STYLE TESTS (state + shortcuts together)
// ════════════════════════════════════════════════════════

section('Integration — GIMP workflow simulation');
{
  const s = createUIState();

  // Step 1: Focus GIMP
  recordFocus(s, '*Untitled – GNU Image Manipulation Program', 'gimp');
  assert(s.activeApp === 'gimp', 'Active app detected as gimp');

  // Step 2: Resolve shortcuts for detected app
  const shortcut = resolveShortcut(s.activeApp!, 'new_image');
  assert(shortcut === 'ctrl+n', 'Resolved new_image shortcut for active app');

  // Step 3: Multiple successful actions
  recordSuccess(s, 'key', 'ctrl+n');
  recordSuccess(s, 'key', 'Tab');
  recordSuccess(s, 'type', '800');
  recordSuccess(s, 'key', 'Return');

  // Step 4: Is window still focused? (should be — no switch happened)
  assert(isWindowFocused(s, 'GIMP'), 'Window still focused after 4 actions');
  assert(s.confidence >= 0.75, `Confidence high after focus + 4 successes: ${s.confidence}`);

  // Step 5: Export shortcut
  const exportShortcut = resolveShortcut('gimp', 'export_as');
  assert(exportShortcut === 'ctrl+shift+e', 'Export shortcut available');

  // Step 6: Verify via title (not screenshot)
  recordSuccess(s, 'verify_window_title');
  assert(s.screenshotCount === 0, 'Zero screenshots taken in entire workflow');
  assert(s.actionHistory.length === 5, 'All 5 actions recorded');
}

section('Integration — App switch clears targets');
{
  const s = createUIState();
  recordFocus(s, 'GIMP', 'gimp');
  cacheTarget(s, 'Canvas center', 960, 540);
  assert(Object.keys(s.knownTargets).length === 1, 'Target cached for GIMP');

  // Switch to LibreOffice
  recordFocus(s, 'LibreOffice Writer', 'libreoffice');
  assert(Object.keys(s.knownTargets).length === 0, 'Targets cleared on app switch');
  assert(s.activeApp === 'libreoffice', 'Active app switched');

  // LibreOffice shortcuts available
  const shortcut = resolveShortcut(s.activeApp!, 'bold');
  assert(shortcut === 'ctrl+b', 'LibreOffice shortcut available after switch');
}

section('Integration — State summary for prompt injection');
{
  const s = createUIState();
  recordFocus(s, '*Untitled – GIMP', 'gimp');
  recordSuccess(s, 'key', 'ctrl+n');
  recordSuccess(s, 'key', 'Return');
  cacheTarget(s, 'Export button', 800, 600);

  const summary = getStateSummary(s);
  const shortcutBlock = getShortcutPromptBlock(s.activeApp!);

  // These would be injected into the dynamic prompt
  assert(summary.length > 0, 'State summary non-empty');
  assert(shortcutBlock.length > 0, 'Shortcut block non-empty');

  // Token budget check — should be compact
  const totalTokensEstimate = (summary.length + shortcutBlock.length) / 4; // rough 4 chars/token
  assert(totalTokensEstimate < 300, `Combined prompt injection under 300 tokens (est: ${totalTokensEstimate.toFixed(0)})`);
}

// ════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
} else {
  console.log('\n🎉 All tests passed!');
  process.exit(0);
}
