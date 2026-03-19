// Integration smoke tests for installApp() — makes real system calls.
// testUnknownApp may take 15-30s as it exhausts all install strategies.
import { installApp } from '../src/main/agent/loop-app-install';

// Minimal smoke test: already-installed binary returns true immediately
// (Full integration tests require a real system)
async function testAlreadyInstalled() {
  const progress: string[] = [];
  // 'ls' is always on PATH — should return true without attempting install
  const result = await installApp('ls', (msg) => progress.push(msg));
  if (!result) throw new Error('Expected true for already-installed binary');
  if (progress.length > 0) throw new Error('Should not narrate for already-installed binary');
  console.log('✓ already-installed returns true silently');
}

async function testUnknownApp() {
  const progress: string[] = [];
  // 'zzz-nonexistent-app-xyz' will never be installed
  const result = await installApp('zzz-nonexistent-app-xyz', (msg) => progress.push(msg));
  if (result) throw new Error('Expected false for unknown app');
  if (!progress.some(m => m.includes('zzz-nonexistent-app-xyz'))) {
    throw new Error('Expected narration mentioning app name');
  }
  console.log('✓ unknown app returns false with narration');
}

(async () => {
  await testAlreadyInstalled();
  await testUnknownApp();
  console.log('All loop-app-install tests passed');
})().catch(e => { console.error(e); process.exit(1); });
