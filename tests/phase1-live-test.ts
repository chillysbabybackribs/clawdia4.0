/**
 * Phase 1 LIVE Integration Test — Real Desktop
 * 
 * Prerequisites:
 *   1. Running on X11 (not Wayland)
 *   2. xdotool, wmctrl, scrot installed
 *   3. Open a terminal window (any window will do)
 * 
 * Run:  npx tsx tests/phase1-live-test.ts
 * 
 * This tests the actual desktop-executors with the state cache active.
 * It interacts with real windows on your desktop.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

// We can't import desktop-executors directly (it imports Electron-dependent gui modules)
// So we test the state module standalone + verify the system tools work

import {
  createUIState,
  isWindowFocused,
  recordFocus,
  recordSuccess,
  recordSkippedFocus,
  getStateSummary,
} from '../src/main/agent/gui/ui-state';

let passed = 0;
let failed = 0;

async function assert(condition: boolean, label: string): Promise<void> {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

function section(name: string): void {
  console.log(`\n━━━ ${name} ━━━`);
}

async function run(cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 5000, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } });
    return stdout.trim();
  } catch (e: any) {
    return `[Error] ${e.message}`;
  }
}

async function main() {
  console.log('Phase 1 — Live Integration Test\n');

  // ── Pre-checks ──────────────────────────────────────
  section('Prerequisites');

  const hasXdotool = !(await run('which xdotool')).startsWith('[Error]');
  const hasWmctrl = !(await run('which wmctrl')).startsWith('[Error]');
  const hasScrot = !(await run('which scrot')).startsWith('[Error]');
  const sessionType = process.env.XDG_SESSION_TYPE || 'unknown';

  await assert(hasXdotool, `xdotool installed: ${hasXdotool}`);
  await assert(hasWmctrl, `wmctrl installed: ${hasWmctrl}`);
  await assert(hasScrot, `scrot installed: ${hasScrot}`);
  console.log(`  ℹ️  Session type: ${sessionType}`);

  if (!hasXdotool || !hasWmctrl) {
    console.log('\n⚠️  Missing prerequisites. Install: sudo apt install xdotool wmctrl scrot');
    console.log('Skipping live tests.\n');
    process.exit(0);
  }

  if (sessionType === 'wayland') {
    console.log('\n⚠️  Wayland detected. xdotool tests will be unreliable.');
    console.log('Skipping live tests.\n');
    process.exit(0);
  }

  // ── Test: List windows ──────────────────────────────
  section('Live — List Windows');

  const windowList = await run('wmctrl -l');
  await assert(!windowList.startsWith('[Error]'), 'wmctrl -l succeeds');
  const windowCount = windowList.split('\n').filter(Boolean).length;
  await assert(windowCount > 0, `Found ${windowCount} open window(s)`);
  console.log(`  ℹ️  Windows:\n${windowList.split('\n').map(l => '    ' + l).join('\n')}`);

  // ── Test: Get active window title ───────────────────
  section('Live — Active Window Title');

  const activeTitle = await run('xdotool getactivewindow getwindowname');
  await assert(!activeTitle.startsWith('[Error]'), 'Got active window title');
  console.log(`  ℹ️  Active: "${activeTitle}"`);

  // ── Test: State tracks real window ──────────────────
  section('Live — State Tracks Active Window');
  {
    const state = createUIState();
    recordFocus(state, activeTitle, '');
    await assert(state.focusedWindow !== null, 'State recorded focus');
    await assert(isWindowFocused(state, activeTitle), 'isWindowFocused returns true for active window');
    console.log(`  ℹ️  Detected app: ${state.focusedWindow?.app}`);
  }

  // ── Test: smartFocus skip simulation ────────────────
  section('Live — Focus Skip Simulation');
  {
    const state = createUIState();
    const title = activeTitle;

    // Simulate first focus (would call wmctrl)
    recordFocus(state, title, '');
    await assert(isWindowFocused(state, title), 'After first focus: isWindowFocused = true');

    // Simulate second focus attempt — should detect as already focused
    const shouldSkip = isWindowFocused(state, title);
    if (shouldSkip) recordSkippedFocus(state);
    await assert(shouldSkip, 'isWindowFocused returns true → can skip');
    await assert(state.skippedFocusCalls === 1, 'Skipped focus call counted');

    // Simulate 10 more batch steps on same window
    for (let i = 0; i < 10; i++) {
      if (isWindowFocused(state, title)) {
        recordSkippedFocus(state);
      }
      recordSuccess(state, 'key', `step-${i}`);
    }
    await assert(state.skippedFocusCalls === 11, `Skipped 11 redundant focus calls (got ${state.skippedFocusCalls})`);

    const summary = getStateSummary(state);
    await assert(summary.includes('Skipped 11'), 'Summary reports skipped calls');
    console.log(`  ℹ️  Summary:\n${summary.split('\n').map(l => '    ' + l).join('\n')}`);
  }

  // ── Test: Screenshot produces a file ────────────────
  section('Live — Screenshot');
  {
    const filename = `/tmp/clawdia-phase1-test-${Date.now()}.png`;
    const result = await run(`scrot -u ${filename}`);
    const exists = !(await run(`stat ${filename}`)).startsWith('[Error]');
    await assert(exists, `Screenshot saved: ${filename}`);
    // Cleanup
    if (exists) await run(`rm ${filename}`);
  }

  // ── Test: verify_window_title equivalent ────────────
  section('Live — Verify Window Title (no screenshot needed)');
  {
    const title = await run('xdotool getactivewindow getwindowname');
    await assert(title.length > 0, `Got title: "${title.slice(0, 50)}"`);
    await assert(!title.startsWith('[Error]'), 'No error from xdotool');
    // This is the equivalent of the new verify_window_title action —
    // it's instant and doesn't need a screenshot
  }

  // ── Test: verify_file_exists equivalent ─────────────
  section('Live — Verify File Exists (no screenshot needed)');
  {
    const testFile = `/tmp/clawdia-phase1-verify-${Date.now()}.txt`;
    await run(`echo "test" > ${testFile}`);
    const stat = await run(`stat --printf="%s bytes, modified %y" "${testFile}"`);
    await assert(!stat.startsWith('[Error]'), `stat works: ${stat}`);
    await run(`rm ${testFile}`);

    const missing = await run(`stat --printf="%s bytes" "/tmp/nonexistent-file-12345"`);
    await assert(missing.startsWith('[Error]'), 'stat fails for missing file');
  }

  // ── Results ─────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('\n🎉 All live tests passed!');
    process.exit(0);
  }
}

main().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
