import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (v: string) => Buffer.from(v), decryptString: (b: Buffer) => b.toString() },
  app: { getPath: () => os.tmpdir() },
}));

let tmpPath: string;
beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `clawdia-detect-test-${Date.now()}.sqlite`);
  process.env.CLAWDIA_DB_PATH = tmpPath;
  vi.resetModules();
});
afterEach(async () => {
  const { closeDb } = await import('../../src/main/db/database');
  closeDb();
  delete process.env.CLAWDIA_DB_PATH;
  try { fs.unlinkSync(tmpPath); } catch {}
  try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
  try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
});

describe('ProactiveDetector', () => {
  it('detects service mentions in message text', async () => {
    const { ProactiveDetector } = await import('../../src/main/autonomy/proactive-detector');
    const detector = new ProactiveDetector();
    detector.recordMentions('I want to post something on Reddit today');
    const count = detector.getMentionCount('reddit');
    expect(count).toBe(1);
  });

  it('increments count across multiple messages', async () => {
    const { ProactiveDetector } = await import('../../src/main/autonomy/proactive-detector');
    const detector = new ProactiveDetector();
    detector.recordMentions('Let me check Reddit');
    detector.recordMentions('Can you post to Reddit for me?');
    detector.recordMentions('Reddit has a lot of info on this');
    expect(detector.getMentionCount('reddit')).toBe(3);
  });

  it('returns services over threshold', async () => {
    const { ProactiveDetector } = await import('../../src/main/autonomy/proactive-detector');
    const detector = new ProactiveDetector();
    for (let i = 0; i < 3; i++) detector.recordMentions('post to Reddit');
    const suggestions = detector.getServicesOverThreshold(3);
    expect(suggestions).toContain('reddit');
  });

  it('does not suggest services already in managed_accounts', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const { ProactiveDetector } = await import('../../src/main/autonomy/proactive-detector');
    const store = new IdentityStore();
    store.saveAccount({ serviceName: 'reddit', passwordPlain: 'pass', status: 'active' });
    const detector = new ProactiveDetector(store);
    for (let i = 0; i < 5; i++) detector.recordMentions('Reddit is great');
    const suggestions = detector.getServicesOverThreshold(3);
    expect(suggestions).not.toContain('reddit');
  });
});
