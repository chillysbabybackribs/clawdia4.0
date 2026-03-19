// Tests for runHarnessPipeline() — pre-flight checks and registry behavior
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { checkPreflight } from '../src/main/agent/loop-harness';

// Test 1: Pre-flight fails when HARNESS.md is missing
async function testPreflight() {
  const result = await checkPreflight('/nonexistent/HARNESS.md', '/nonexistent/repl_skin.py');
  if (result.ok) throw new Error('Expected preflight to fail with missing files');
  if (!result.reason.includes('HARNESS.md')) throw new Error('Expected reason to mention HARNESS.md');
  console.log('✓ preflight fails with missing HARNESS.md');
}

// Test 2: Pre-flight passes when both files exist
async function testPreflightPass() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  const harnessMd = path.join(tmpDir, 'HARNESS.md');
  const replSkin = path.join(tmpDir, 'repl_skin.py');
  fs.writeFileSync(harnessMd, '# HARNESS');
  fs.writeFileSync(replSkin, '# repl skin');

  const result = await checkPreflight(harnessMd, replSkin);
  fs.rmSync(tmpDir, { recursive: true });

  if (!result.ok) throw new Error(`Expected preflight to pass: ${result.reason}`);
  console.log('✓ preflight passes when both files exist');
}

(async () => {
  await testPreflight();
  await testPreflightPass();
  console.log('All loop-harness tests passed');
})().catch(e => { console.error(e); process.exit(1); });
