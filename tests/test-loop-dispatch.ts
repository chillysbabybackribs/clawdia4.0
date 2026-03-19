/**
 * Loop Dispatch Tests — Verifies batch partitioning logic.
 *
 * Run:  npx tsx tests/test-loop-dispatch.ts
 *
 * Tests the pure partitioning function (no native modules needed).
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

import { partitionIntoBatches } from '../src/main/agent/loop-dispatch';

// Helper to create mock tool-use blocks
function mockBlock(name: string, input: Record<string, any> = {}): any {
  return { type: 'tool_use', id: `test-${name}-${Math.random().toString(36).slice(2, 6)}`, name, input };
}

// ════════════════════════════════════════════════════════
// SINGLE TOOL
// ════════════════════════════════════════════════════════

section('Single tool → single batch');
{
  const batches = partitionIntoBatches([mockBlock('file_read', { path: '/tmp/a.txt' })]);
  assertEq(batches.length, 1, 'One batch');
  assertEq(batches[0].length, 1, 'One tool in batch');
}

// ════════════════════════════════════════════════════════
// PARALLEL INDEPENDENT TOOLS
// ════════════════════════════════════════════════════════

section('Independent non-sequential tools → single parallel batch');
{
  const batches = partitionIntoBatches([
    mockBlock('file_read', { path: '/tmp/a.txt' }),
    mockBlock('browser_search', { query: 'test' }),
    mockBlock('memory_search', { query: 'preferences' }),
  ]);
  assertEq(batches.length, 1, 'One batch (all parallel)');
  assertEq(batches[0].length, 3, 'Three tools in parallel batch');
}

// ════════════════════════════════════════════════════════
// SEQUENTIAL TOOLS GET OWN BATCH
// ════════════════════════════════════════════════════════

section('shell_exec always gets its own batch');
{
  const batches = partitionIntoBatches([
    mockBlock('file_read', { path: '/tmp/a.txt' }),
    mockBlock('shell_exec', { command: 'ls' }),
    mockBlock('file_read', { path: '/tmp/b.txt' }),
  ]);
  assertEq(batches.length, 3, 'Three batches (file_read, shell_exec, file_read)');
  assertEq(batches[0][0].name, 'file_read', 'First batch is file_read');
  assertEq(batches[1][0].name, 'shell_exec', 'Second batch is shell_exec (isolated)');
  assertEq(batches[2][0].name, 'file_read', 'Third batch is file_read');
}

section('gui_interact always gets its own batch');
{
  const batches = partitionIntoBatches([
    mockBlock('gui_interact', { action: 'click', x: 100, y: 200 }),
    mockBlock('gui_interact', { action: 'type', text: 'hello' }),
  ]);
  assertEq(batches.length, 2, 'Two batches (each gui_interact isolated)');
}

section('app_control gets its own batch');
{
  const batches = partitionIntoBatches([
    mockBlock('browser_search', { query: 'test' }),
    mockBlock('app_control', { app: 'gimp', command: 'project info' }),
  ]);
  assertEq(batches.length, 2, 'Two batches');
  assertEq(batches[0][0].name, 'browser_search', 'First batch: browser_search');
  assertEq(batches[1][0].name, 'app_control', 'Second batch: app_control (isolated)');
}

section('dbus_control gets its own batch');
{
  const batches = partitionIntoBatches([
    mockBlock('dbus_control', { action: 'call', service: 'org.mpris.MediaPlayer2.spotify' }),
  ]);
  assertEq(batches.length, 1, 'One batch');
  assertEq(batches[0].length, 1, 'Single isolated tool');
}

// ════════════════════════════════════════════════════════
// SEQUENTIAL TOOLS FLUSH PRECEDING PARALLEL BATCH
// ════════════════════════════════════════════════════════

section('Sequential tool flushes accumulated parallel batch');
{
  const batches = partitionIntoBatches([
    mockBlock('file_read', { path: '/a.txt' }),
    mockBlock('memory_search', { query: 'test' }),
    mockBlock('shell_exec', { command: 'echo done' }),
  ]);
  assertEq(batches.length, 2, 'Two batches');
  assertEq(batches[0].length, 2, 'First batch: 2 parallel tools');
  assertEq(batches[1].length, 1, 'Second batch: shell_exec alone');
}

// ════════════════════════════════════════════════════════
// CROSS-REFERENCE DETECTION
// ════════════════════════════════════════════════════════

section('Tool referencing previous tool name → new batch');
{
  const batches = partitionIntoBatches([
    mockBlock('browser_search', { query: 'API docs' }),
    mockBlock('file_write', { path: '/tmp/notes.txt', content: 'Results from browser_search...' }),
  ]);
  assertEq(batches.length, 2, 'Two batches (file_write references browser_search)');
}

section('No cross-reference → stays parallel');
{
  const batches = partitionIntoBatches([
    mockBlock('browser_search', { query: 'API docs' }),
    mockBlock('file_read', { path: '/tmp/config.json' }),
  ]);
  assertEq(batches.length, 1, 'One batch (no cross-reference)');
  assertEq(batches[0].length, 2, 'Both tools in parallel');
}

// ════════════════════════════════════════════════════════
// MIXED SCENARIOS
// ════════════════════════════════════════════════════════

section('Complex mixed scenario');
{
  // Real-world pattern: search + read in parallel, then shell_exec, then two more reads
  const batches = partitionIntoBatches([
    mockBlock('browser_search', { query: 'typescript generics' }),
    mockBlock('file_read', { path: '/home/dp/project/tsconfig.json' }),
    mockBlock('shell_exec', { command: 'tsc --version' }),
    mockBlock('file_read', { path: '/home/dp/project/src/index.ts' }),
    mockBlock('memory_search', { query: 'preferred editor' }),
  ]);
  assertEq(batches.length, 3, 'Three batches');
  assertEq(batches[0].length, 2, 'Batch 1: browser_search + file_read (parallel)');
  assertEq(batches[1].length, 1, 'Batch 2: shell_exec (isolated)');
  assertEq(batches[2].length, 2, 'Batch 3: file_read + memory_search (parallel)');
}

section('All sequential tools → all isolated');
{
  const batches = partitionIntoBatches([
    mockBlock('shell_exec', { command: 'mkdir /tmp/test' }),
    mockBlock('shell_exec', { command: 'cd /tmp/test' }),
    mockBlock('shell_exec', { command: 'touch file.txt' }),
  ]);
  assertEq(batches.length, 3, 'Three batches (all isolated)');
  for (let i = 0; i < 3; i++) {
    assertEq(batches[i].length, 1, `Batch ${i + 1}: single shell_exec`);
  }
}

section('Empty input → empty output');
{
  const batches = partitionIntoBatches([]);
  assertEq(batches.length, 0, 'No batches for empty input');
}

// ════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exit(1);
}
console.log('\n🎉 All dispatch tests passed!');
