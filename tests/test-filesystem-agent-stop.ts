/**
 * Filesystem Agent stop-condition tests — verifies strong quote matches block further lookup/read churn.
 *
 * Run: npx tsx tests/test-filesystem-agent-stop.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function section(name: string): void { console.log(`\n━━━ ${name} ━━━`); }

import { inferStrongFilesystemQuoteMatch, shouldBlockFilesystemQuoteFollowup } from '../src/main/agent/loop-dispatch';

section('inferStrongFilesystemQuoteMatch');
{
  assert(
    inferStrongFilesystemQuoteMatch('[fs_quote_lookup]\nBEST MATCH: /tmp/a\nBEST MATCH CONFIDENCE: 0.91\nRECOMMENDATION: Strong winner.'),
    'Confidence >= 0.80 is strong',
  );
  assert(
    !inferStrongFilesystemQuoteMatch('[fs_quote_lookup]\nBEST MATCH: /tmp/a\nBEST MATCH CONFIDENCE: 0.61\nRECOMMENDATION: Candidate match.'),
    'Confidence < 0.80 is not strong',
  );
}

section('shouldBlockFilesystemQuoteFollowup');
{
  const active = { filesystemQuoteLookupMode: true, strongFilesystemQuoteMatch: true };
  assert(shouldBlockFilesystemQuoteFollowup(active, 'fs_quote_lookup'), 'Blocks repeated quote lookup after strong match');
  assert(shouldBlockFilesystemQuoteFollowup(active, 'file_read'), 'Blocks file read after strong match');
  assert(!shouldBlockFilesystemQuoteFollowup(active, 'directory_tree'), 'Does not block unrelated tool');
  assert(!shouldBlockFilesystemQuoteFollowup({ filesystemQuoteLookupMode: true, strongFilesystemQuoteMatch: false }, 'file_read'), 'Does not block before strong match');
}

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  ❌ ${failure}`);
  process.exit(1);
}
console.log('\n🎉 All filesystem agent stop-condition tests passed!');
