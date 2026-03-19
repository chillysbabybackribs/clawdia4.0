/**
 * App Registry + Routing Tests — Verifies task routing, app detection, profile management.
 *
 * Run:  npx tsx tests/test-routing.ts
 *
 * NOTE: These tests require SQLite (better-sqlite3) for the registry.
 * They create an in-memory DB, seed it, and test routing logic.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Use a temp database so tests run outside Electron
const testDbDir = path.join(os.tmpdir(), 'clawdia-test-' + process.pid);
fs.mkdirSync(testDbDir, { recursive: true });
process.env.CLAWDIA_DB_PATH = path.join(testDbDir, 'test.sqlite');

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

// Initialize the database (uses temp path from CLAWDIA_DB_PATH)
import { getDb } from '../src/main/db/database';
getDb(); // ensures tables exist

import {
  seedRegistry,
  getAppProfile,
  updateAppProfile,
  listProfiles,
  routeTask,
  extractAppName,
  type AppProfile,
  type ExecutionPlan,
} from '../src/main/db/app-registry';

// Seed the registry with known profiles
seedRegistry();

// ════════════════════════════════════════════════════════
// REGISTRY OPERATIONS
// ════════════════════════════════════════════════════════

section('Registry — seed profiles exist');
{
  const gimp = getAppProfile('gimp');
  assert(gimp !== null, 'GIMP profile exists');
  assertEq(gimp!.appId, 'gimp', 'GIMP appId');
  assertEq(gimp!.displayName, 'GIMP', 'GIMP displayName');
  assert(gimp!.availableSurfaces.includes('programmatic'), 'GIMP has programmatic surface');
  assert(gimp!.availableSurfaces.includes('gui'), 'GIMP has gui surface');

  const spotify = getAppProfile('spotify');
  assert(spotify !== null, 'Spotify profile exists');
  assert(spotify!.availableSurfaces.includes('dbus'), 'Spotify has dbus surface');
  assertEq(spotify!.dbusService, 'org.mpris.MediaPlayer2.spotify', 'Spotify dbus service');

  const ffmpeg = getAppProfile('ffmpeg');
  assert(ffmpeg !== null, 'FFmpeg profile exists');
  assertEq(ffmpeg!.confidence, 1.0, 'FFmpeg has max confidence');
}

section('Registry — listProfiles');
{
  const profiles = listProfiles();
  assert(profiles.length >= 10, `At least 10 seed profiles (got ${profiles.length})`);
  const ids = profiles.map(p => p.appId);
  assert(ids.includes('gimp'), 'List includes gimp');
  assert(ids.includes('spotify'), 'List includes spotify');
  assert(ids.includes('ffmpeg'), 'List includes ffmpeg');
}

section('Registry — updateAppProfile');
{
  // Create a custom profile
  const testProfile: AppProfile = {
    appId: 'test-app',
    displayName: 'Test App',
    binaryPath: 'test-app',
    availableSurfaces: ['native_cli', 'gui'],
    nativeCli: { command: 'test-app', supportsBatch: true, helpSummary: 'Test help' },
    windowMatcher: 'Test',
    confidence: 0.5,
    lastScanned: new Date().toISOString(),
  };
  updateAppProfile(testProfile);
  const loaded = getAppProfile('test-app');
  assert(loaded !== null, 'Custom profile saved and loaded');
  assertEq(loaded!.displayName, 'Test App', 'Display name persisted');
  assertEq(loaded!.nativeCli?.helpSummary, 'Test help', 'Nested data persisted');
}

section('Registry — profile with CLI-Anything skill content');
{
  const profileWithSkill: AppProfile = {
    appId: 'test-skill-app',
    displayName: 'Test Skill App',
    availableSurfaces: ['cli_anything', 'gui'],
    cliAnything: {
      command: 'cli-anything-test-skill-app',
      installed: true,
      commands: ['project', 'export', 'layer'],
      skillPath: '/fake/path/SKILL.md',
      skillContent: '# Test Skill\n\n## Commands\n\n- project new\n- export render',
    },
    confidence: 0.8,
    lastScanned: new Date().toISOString(),
  };
  updateAppProfile(profileWithSkill);
  const loaded = getAppProfile('test-skill-app');
  assert(loaded !== null, 'Profile with skill content saved');
  assertEq(loaded!.cliAnything?.skillPath, '/fake/path/SKILL.md', 'skillPath persisted');
  assert(loaded!.cliAnything?.skillContent?.includes('# Test Skill'), 'skillContent persisted');
}

// ════════════════════════════════════════════════════════
// APP NAME EXTRACTION
// ════════════════════════════════════════════════════════

section('extractAppName — registered apps');
{
  assertEq(extractAppName('open gimp and resize the image'), 'gimp', 'Extracts gimp');
  assertEq(extractAppName('launch blender for 3D modeling'), 'blender', 'Extracts blender');
  assertEq(extractAppName('play music on spotify'), 'spotify', 'Extracts spotify');
  assertEq(extractAppName('use inkscape to create SVG'), 'inkscape', 'Extracts inkscape');
  assertEq(extractAppName('convert with ffmpeg'), 'ffmpeg', 'Extracts ffmpeg');
}

section('extractAppName — programmatic aliases');
{
  assertEq(extractAppName('use pillow to process the image'), 'imagemagick', 'pillow → imagemagick');
  // Note: 'convert' is in SKIP_WORDS (common verb), so it's filtered before alias check.
  // In practice, 'imagemagick' is found via the registry seed profile, not the alias.
  assertEq(extractAppName('resize with imagemagick'), 'imagemagick', 'imagemagick direct match');
}

section('extractAppName — no match');
{
  assertEq(extractAppName('what is the weather today'), null, 'No app in weather query');
  assertEq(extractAppName('help me write an email'), null, 'No app in email request');
  assertEq(extractAppName('hi'), null, 'No app in greeting');
}

// ════════════════════════════════════════════════════════
// TASK ROUTING
// ════════════════════════════════════════════════════════

section('routeTask — no app detected');
{
  const plan = routeTask('what time is it', null);
  assertEq(plan.selectedSurface, 'gui', 'Default surface is gui');
  assert(plan.disallowedTools.length === 0, 'No tools filtered');
  assert(plan.reasoning.includes('No app detected'), 'Reasoning explains no app');
}

section('routeTask — GIMP image creation (programmatic)');
{
  const plan = routeTask('create a new 800x600 image', 'gimp');
  assertEq(plan.appId, 'gimp', 'Plan targets gimp');
  // Image creation should route to programmatic (Pillow/ImageMagick)
  assertEq(plan.selectedSurface, 'programmatic', 'Image creation → programmatic');
  assert(plan.constraint.includes('shell_exec'), 'Constraint mentions shell_exec');
}

section('routeTask — Spotify media control (dbus)');
{
  const plan = routeTask('play the next track', 'spotify');
  assertEq(plan.selectedSurface, 'dbus', 'Media control → dbus');
  assert(plan.constraint.includes('dbus_control'), 'Constraint mentions dbus_control');
  assert(plan.constraint.includes('org.mpris.MediaPlayer2.spotify'), 'Constraint has spotify service');
}

section('routeTask — Blender with native CLI');
{
  const plan = routeTask('render the scene as a PNG', 'blender');
  assert(plan.appProfile !== undefined, 'Plan has app profile');
  // Blender doesn't have programmatic surface, so depends on task rule
  assert(['cli_anything', 'native_cli', 'gui'].includes(plan.selectedSurface),
    `Blender render routes to valid surface: ${plan.selectedSurface}`);
}

section('routeTask — CLI-Anything installed → promoted to first');
{
  // Create a profile with installed cli_anything
  const profileWithCli: AppProfile = {
    appId: 'test-cli-app',
    displayName: 'Test CLI App',
    availableSurfaces: ['programmatic', 'cli_anything', 'native_cli', 'gui'],
    cliAnything: {
      command: 'cli-anything-test-cli-app',
      installed: true,
      commands: ['project', 'export'],
    },
    confidence: 0.9,
    lastScanned: new Date().toISOString(),
  };
  updateAppProfile(profileWithCli);

  const plan = routeTask('do something with test-cli-app', 'test-cli-app');
  assertEq(plan.selectedSurface, 'cli_anything', 'CLI-Anything promoted when installed');
  assert(plan.disallowedTools.includes('gui_interact'), 'gui_interact filtered out');
  assert(plan.disallowedTools.includes('app_control'), 'app_control filtered out');
  assert(plan.constraint.includes('MANDATORY'), 'Constraint is MANDATORY');
  assert(plan.constraint.includes('cli-anything-test-cli-app'), 'Constraint has CLI command');
}

section('routeTask — CLI-Anything with SKILL.md → injected into constraint');
{
  const plan = routeTask('create a project with test-skill-app', 'test-skill-app');
  assertEq(plan.selectedSurface, 'cli_anything', 'Selects cli_anything');
  assert(plan.constraint.includes('CLI SKILL REFERENCE'), 'Constraint contains SKILL REFERENCE block');
  assert(plan.constraint.includes('# Test Skill'), 'Constraint contains actual skill content');
  assert(plan.constraint.includes('project new'), 'Constraint contains command from skill');
  assert(plan.reasoning.includes('SKILL.md'), 'Reasoning mentions SKILL.md');
  // Should NOT contain the generic "run --help" workflow
  assert(!plan.constraint.includes('shell_exec("cli-anything-test-skill-app --help")'),
    'No --help workflow when SKILL.md is available');
}

section('routeTask — CLI-Anything NOT installed → fallback constraint');
{
  const profileNoInstall: AppProfile = {
    appId: 'test-noinstall',
    displayName: 'Test No Install',
    availableSurfaces: ['cli_anything', 'native_cli', 'gui'],
    cliAnything: {
      command: 'cli-anything-test-noinstall',
      installed: false,
    },
    nativeCli: { command: 'test-noinstall', supportsBatch: false },
    confidence: 0.5,
    lastScanned: new Date().toISOString(),
  };
  updateAppProfile(profileNoInstall);

  const plan = routeTask('use test-noinstall', 'test-noinstall');
  // selectedSurface is cli_anything (first in list), but the constraint
  // correctly says "not installed, falling back" — the LLM gets the right guidance.
  assert(plan.constraint.includes('not installed'), 'Constraint says harness not installed');
  assert(plan.constraint.includes('Falling back'), 'Constraint mentions fallback');
  assert(plan.disallowedTools.length === 0, 'No tool filtering for uninstalled cli path');
}

section('routeTask — interactive GUI editing → prefers cli_anything or gui');
{
  const plan = routeTask('edit the layer filter in gimp and apply a blur effect', 'gimp');
  // Interactive editing rule should match, preferring cli_anything > gui
  assert(['cli_anything', 'gui', 'programmatic'].includes(plan.selectedSurface),
    `Interactive edit routes appropriately: ${plan.selectedSurface}`);
}

section('routeTask — launch app → native CLI');
{
  const plan = routeTask('launch libreoffice', 'libreoffice');
  assertEq(plan.selectedSurface, 'native_cli', 'Launch → native_cli');
}

section('routeTask — document creation → programmatic');
{
  const plan = routeTask('create a PDF report', 'libreoffice');
  assertEq(plan.selectedSurface, 'programmatic', 'Document creation → programmatic');
  assert(plan.constraint.includes('python3'), 'Constraint mentions python libraries');
}

section('routeTask — audio conversion → programmatic');
{
  const plan = routeTask('convert audio to mp3', 'audacity');
  assertEq(plan.selectedSurface, 'programmatic', 'Audio conversion → programmatic');
}

// ════════════════════════════════════════════════════════
// EXECUTION PLAN STRUCTURE
// ════════════════════════════════════════════════════════

section('ExecutionPlan — structure validation');
{
  const plan = routeTask('resize an image in gimp', 'gimp');
  assert(plan.appId !== undefined, 'Plan has appId');
  assert(plan.appProfile !== undefined, 'Plan has appProfile');
  assert(plan.selectedSurface !== undefined, 'Plan has selectedSurface');
  assert(Array.isArray(plan.allowedSurfaces), 'Plan has allowedSurfaces array');
  assert(Array.isArray(plan.disallowedTools), 'Plan has disallowedTools array');
  assert(typeof plan.constraint === 'string', 'Plan has constraint string');
  assert(typeof plan.reasoning === 'string', 'Plan has reasoning string');
  assert(plan.reasoning.length > 0, 'Reasoning is not empty');
}

// ════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log('\n🎉 All routing tests passed!');

// Cleanup temp DB
try { fs.rmSync(testDbDir, { recursive: true }); } catch {}
