/**
 * Capability Snapshot Tests — Verifies snapshot building and formatting.
 *
 * Run:  npx tsx tests/test-capability-snapshot.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function section(name: string): void { console.log(`\n━━━ ${name} ━━━`); }
function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got: ${actual}, expected: ${expected})`);
}

import { buildCapabilitySnapshot, formatSnapshotLog } from '../src/main/agent/capability-snapshot';
import type { ExecutionPlan, AppProfile } from '../src/main/db/app-registry';

// ════════════════════════════════════════════════════════
// BUILD SNAPSHOT — No app
// ════════════════════════════════════════════════════════

section('buildSnapshot — no app detected');
{
  const snap = buildCapabilitySnapshot(null, null, null, { xdotool: true, dbus: true, a11y: true });
  assertEq(snap.appId, null, 'appId is null');
  assertEq(snap.appDetected, false, 'appDetected is false');
  assertEq(snap.cliAnythingInstalled, false, 'cliAnythingInstalled false');
  assertEq(snap.cliAnythingHasSkill, false, 'cliAnythingHasSkill false');
  assertEq(snap.selectedSurface, 'none', 'selectedSurface is none');
  assert(snap.preferredOrder.length === 0, 'No preferred order');
  assert(snap.resolvedAt > 0, 'resolvedAt is set');
}

// ════════════════════════════════════════════════════════
// BUILD SNAPSHOT — App with CLI-Anything + SKILL.md
// ════════════════════════════════════════════════════════

section('buildSnapshot — app with CLI-Anything installed + skill');
{
  const profile: AppProfile = {
    appId: 'gimp',
    displayName: 'GIMP',
    binaryPath: 'gimp',
    availableSurfaces: ['cli_anything', 'programmatic', 'gui'],
    cliAnything: {
      command: 'cli-anything-gimp',
      installed: true,
      commands: ['project', 'layer', 'canvas', 'filter', 'export'],
      skillPath: '/some/path/SKILL.md',
      skillContent: '# GIMP CLI\n\nFull reference...',
    },
    confidence: 0.9,
    lastScanned: new Date().toISOString(),
  };

  const plan: ExecutionPlan = {
    appId: 'gimp',
    appProfile: profile,
    selectedSurface: 'cli_anything',
    allowedSurfaces: ['cli_anything', 'programmatic', 'gui'],
    disallowedTools: ['gui_interact', 'app_control'],
    constraint: '[EXECUTION PLAN] ...',
    reasoning: 'GIMP has CLI-Anything harness + SKILL.md',
  };

  const snap = buildCapabilitySnapshot('gimp', plan, profile, { xdotool: true, dbus: true, a11y: true });

  assertEq(snap.appId, 'gimp', 'appId');
  assertEq(snap.appDetected, true, 'appDetected');
  assertEq(snap.nativeCliAvailable, false, 'nativeCliAvailable false (no nativeCli on profile)');
  assertEq(snap.cliAnythingAvailable, true, 'cliAnythingAvailable');
  assertEq(snap.cliAnythingInstalled, true, 'cliAnythingInstalled');
  assertEq(snap.cliAnythingCommands.length, 5, '5 CLI commands');
  assertEq(snap.cliAnythingHasSkill, true, 'cliAnythingHasSkill');
  assertEq(snap.a11yAvailable, true, 'a11y available');
  assertEq(snap.rawGuiAvailable, true, 'GUI available');
  assertEq(snap.dbusAvailable, true, 'dbus available');
  assertEq(snap.selectedSurface, 'cli_anything', 'selectedSurface');
  assert(snap.preferredOrder.includes('cli_anything'), 'cli_anything in preferred order');
}

// ════════════════════════════════════════════════════════
// BUILD SNAPSHOT — App without CLI-Anything
// ════════════════════════════════════════════════════════

section('buildSnapshot — app without CLI, a11y unavailable');
{
  const profile: AppProfile = {
    appId: 'darktable',
    displayName: 'Darktable',
    binaryPath: 'darktable',
    availableSurfaces: ['native_cli', 'gui'],
    nativeCli: { command: 'darktable', supportsBatch: true },
    confidence: 0.5,
    lastScanned: new Date().toISOString(),
  };

  const plan: ExecutionPlan = {
    appId: 'darktable',
    appProfile: profile,
    selectedSurface: 'native_cli',
    allowedSurfaces: ['native_cli', 'gui'],
    disallowedTools: [],
    constraint: '[EXECUTION PLAN] ...',
    reasoning: 'Darktable native CLI',
  };

  const snap = buildCapabilitySnapshot('darktable', plan, profile, { xdotool: true, dbus: false, a11y: false });

  assertEq(snap.cliAnythingAvailable, false, 'No CLI-Anything (not in KNOWN_PREBUILT)');
  assertEq(snap.cliAnythingInstalled, false, 'Not installed');
  assertEq(snap.cliAnythingHasSkill, false, 'No skill');
  assertEq(snap.nativeCliAvailable, true, 'Has native CLI');
  assertEq(snap.a11yAvailable, false, 'a11y NOT available');
  assertEq(snap.dbusAvailable, false, 'dbus NOT available');
  assertEq(snap.selectedSurface, 'native_cli', 'Routes to native CLI');
}

// ════════════════════════════════════════════════════════
// FORMAT SNAPSHOT LOG
// ════════════════════════════════════════════════════════

section('formatSnapshotLog — no app');
{
  const snap = buildCapabilitySnapshot(null, null, null, { xdotool: true, dbus: true, a11y: true });
  const log = formatSnapshotLog(snap);
  assert(log.includes('[Capability]'), 'Has [Capability] prefix');
  assert(log.includes('No app detected'), 'Says no app detected');
}

section('formatSnapshotLog — app with CLI + skill');
{
  const profile: AppProfile = {
    appId: 'gimp',
    displayName: 'GIMP',
    availableSurfaces: ['cli_anything', 'gui'],
    cliAnything: {
      command: 'cli-anything-gimp',
      installed: true,
      commands: ['project', 'export', 'layer'],
      skillContent: '# Skill content',
    },
    confidence: 0.9,
    lastScanned: new Date().toISOString(),
  };
  const plan: ExecutionPlan = {
    appId: 'gimp',
    appProfile: profile,
    selectedSurface: 'cli_anything',
    allowedSurfaces: ['cli_anything', 'gui'],
    disallowedTools: [],
    constraint: '',
    reasoning: '',
  };

  const snap = buildCapabilitySnapshot('gimp', plan, profile, { xdotool: true, dbus: true, a11y: true });
  const log = formatSnapshotLog(snap);

  assert(log.includes('gimp'), 'Log contains app name');
  assert(log.includes('[cli_anything]'), 'Selected surface is bracketed');
  assert(log.includes('3 cmds'), 'Shows command count');
  assert(log.includes('SKILL.md'), 'Shows SKILL.md indicator');
  assert(log.includes('a11y:true'), 'Shows a11y status');
  assert(log.includes('gui:true'), 'Shows GUI status');
}

section('formatSnapshotLog — app without CLI');
{
  const snap = buildCapabilitySnapshot('darktable', {
    selectedSurface: 'native_cli',
    allowedSurfaces: ['native_cli', 'gui'],
    disallowedTools: [],
    constraint: '',
    reasoning: '',
  } as ExecutionPlan, {
    appId: 'darktable',
    displayName: 'Darktable',
    availableSurfaces: ['native_cli', 'gui'],
    nativeCli: { command: 'darktable', supportsBatch: true },
    confidence: 0.5,
    lastScanned: '',
  }, { xdotool: true, dbus: false, a11y: false });

  const log = formatSnapshotLog(snap);
  assert(log.includes('cli:none'), 'Shows cli:none when no CLI-Anything');
  assert(log.includes('[native_cli]'), 'Selected surface bracketed');
  assert(log.includes('a11y:false'), 'a11y false');
}

// ════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log('\n🎉 All capability snapshot tests passed!');
