/**
 * Classifier Tests — Verifies regex routing, tool group selection, prompt modules.
 *
 * Run:  npx tsx tests/test-classifier.ts
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

import { classify } from '../src/main/agent/classifier';

// ════════════════════════════════════════════════════════
// GREETINGS
// ════════════════════════════════════════════════════════

section('Greetings → core group, haiku, isGreeting');
{
  for (const msg of ['hi', 'Hello', 'hey!', 'yo', 'good morning', 'Good Evening!']) {
    const p = classify(msg);
    assertEq(p.toolGroup, 'core', `"${msg}" → core`);
    assertEq(p.model, 'haiku', `"${msg}" → haiku`);
    assertEq(p.isGreeting, true, `"${msg}" → isGreeting`);
    assert(p.promptModules.size === 0, `"${msg}" → no modules`);
  }
}

section('Non-greetings that look similar');
{
  const p1 = classify('hi can you help me with some code');
  assert(!p1.isGreeting, '"hi can you help..." is not a greeting');

  const p2 = classify('hello world program in python');
  assert(!p2.isGreeting, '"hello world program..." is not a greeting');
}

// ════════════════════════════════════════════════════════
// BROWSER TASKS
// ════════════════════════════════════════════════════════

section('Browser tasks → browser group');
{
  for (const msg of [
    'search for typescript tutorials',
    'look up the weather in Atlanta',
    'go to https://github.com',
    'browse online reviews of MacBook Air',
    'what is the latest news about AI',
    'how much does a Tesla Model 3 cost',
    'navigate to docs.anthropic.com',
  ]) {
    const p = classify(msg);
    assertEq(p.toolGroup, 'browser', `"${msg.slice(0, 40)}..." → browser`);
    assert(!p.isGreeting, `"${msg.slice(0, 40)}..." → not greeting`);
  }
}

// ════════════════════════════════════════════════════════
// FILESYSTEM/CODE TASKS
// ════════════════════════════════════════════════════════

section('Filesystem/code tasks → core group + coding module');
{
  for (const msg of [
    'read the file src/main.ts',
    'create a new file called hello.py',
    'refactor the database module',
    'npm install express',
    'git status',
    'fix the bug in parser.rs',
    'ls ~/Desktop',
  ]) {
    const p = classify(msg);
    assertEq(p.toolGroup, 'core', `"${msg.slice(0, 40)}..." → core`);
    assert(p.promptModules.has('coding'), `"${msg.slice(0, 40)}..." → coding module`);
  }
}

// ════════════════════════════════════════════════════════
// DESKTOP APP TASKS
// ════════════════════════════════════════════════════════

section('Desktop app tasks → full group + desktop_apps module');
{
  for (const msg of [
    'open gimp and resize the image',
    'launch blender',
    'play music on spotify',
    'pause the music',
    'take a screenshot',
    'use inkscape to create an SVG',
    'open audacity and record audio',
    'control the volume',
    'click the button in libreoffice',
  ]) {
    const p = classify(msg);
    assertEq(p.toolGroup, 'full', `"${msg.slice(0, 40)}..." → full`);
    assert(p.promptModules.has('desktop_apps'), `"${msg.slice(0, 40)}..." → desktop_apps module`);
  }
}

// ════════════════════════════════════════════════════════
// DOCUMENT TASKS
// ════════════════════════════════════════════════════════

section('Document tasks → full group + document module');
{
  for (const msg of [
    'create a report about Q3 sales',
    'write a memo to the team',
    'generate a PDF summary',
    'create a spreadsheet with monthly data',
    'make a presentation about our roadmap',
  ]) {
    const p = classify(msg);
    assertEq(p.toolGroup, 'full', `"${msg.slice(0, 40)}..." → full`);
    assert(p.promptModules.has('document'), `"${msg.slice(0, 40)}..." → document module`);
  }
}

// ════════════════════════════════════════════════════════
// SELF-REFERENCE TASKS
// ════════════════════════════════════════════════════════

section('Self-reference tasks → core group + self_knowledge module');
{
  for (const msg of [
    'what is clawdia',
    'clear my data',
    'reset your memory',
    'show your settings',
  ]) {
    const p = classify(msg);
    assertEq(p.toolGroup, 'core', `"${msg.slice(0, 40)}..." → core`);
    assert(p.promptModules.has('self_knowledge'), `"${msg.slice(0, 40)}..." → self_knowledge module`);
  }
}

// ════════════════════════════════════════════════════════
// MULTI-DOMAIN TASKS
// ════════════════════════════════════════════════════════

section('Multi-domain → full group');
{
  // Browser + filesystem
  const p1 = classify('search for python tutorials and save them to a file');
  assertEq(p1.toolGroup, 'full', 'browser + filesystem → full');

  // Browser + desktop
  const p2 = classify('look up a recipe and open it in libreoffice');
  assertEq(p2.toolGroup, 'full', 'browser + desktop → full');

  // Desktop + self
  const p3 = classify('open gimp and tell me about clawdia settings');
  assertEq(p3.toolGroup, 'full', 'desktop + self → full');
}

// ════════════════════════════════════════════════════════
// MODEL SELECTION
// ════════════════════════════════════════════════════════

section('Model selection');
{
  assertEq(classify('hi').model, 'haiku', 'Greeting → haiku');
  assertEq(classify('search for AI news').model, 'sonnet', 'Normal task → sonnet');
  assertEq(classify('assess the architecture and think carefully about the tradeoffs').model, 'opus', 'Deep analysis → opus');

  // Short question → haiku
  const p = classify('what is 2+2?');
  assertEq(p.model, 'haiku', 'Short factual question → haiku');
}

// ════════════════════════════════════════════════════════
// EDGE CASES
// ════════════════════════════════════════════════════════

section('Edge cases');
{
  // Empty string
  const p1 = classify('');
  assert(!p1.isGreeting, 'Empty string is not a greeting');

  // Very long message → should still classify
  const long = 'please ' + 'help me with this code '.repeat(50) + ' in the file main.ts';
  const p2 = classify(long);
  assert(p2.toolGroup !== undefined, 'Long message still classifies');

  // Ambiguous — defaults to full
  const p3 = classify('do something interesting');
  assertEq(p3.toolGroup, 'full', 'Ambiguous message → full (default)');
}

// ════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log('\n🎉 All classifier tests passed!');
