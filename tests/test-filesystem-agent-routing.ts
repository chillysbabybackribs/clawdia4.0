/**
 * Filesystem Agent routing tests — verifies quote-lookup task detection for tool restrictions.
 *
 * Run: npx tsx tests/test-filesystem-agent-routing.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function section(name: string): void { console.log(`\n━━━ ${name} ━━━`); }

import { isFilesystemQuoteLookupTask } from '../src/main/agent/filesystem-agent-routing';

section('Positive cases');
{
  assert(
    isFilesystemQuoteLookupTask('Find the file in /home/dp/Desktop/clawdia4.0 that talks about requiring consent before publishing local commits to a remote repository'),
    'Paraphrase file lookup is detected',
  );
  assert(
    isFilesystemQuoteLookupTask('Show me the exact file that contains this line'),
    'Exact line lookup is detected',
  );
  assert(
    isFilesystemQuoteLookupTask('Locate the PDF that mentions post-termination obligations'),
    'PDF mention lookup is detected',
  );
}

section('Negative cases');
{
  assert(!isFilesystemQuoteLookupTask('Organize my Downloads folder'), 'Folder organization is not quote lookup');
  assert(!isFilesystemQuoteLookupTask('Read src/main/main.ts'), 'Plain file read is not quote lookup');
  assert(!isFilesystemQuoteLookupTask('Search the web for pricing'), 'Browser search is not quote lookup');
}

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  ❌ ${failure}`);
  process.exit(1);
}
console.log('\n🎉 All filesystem agent routing tests passed!');
