import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Mock safeStorage — not available outside Electron
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (val: string) => Buffer.from(val + ':encrypted'),
    decryptString: (buf: Buffer) => buf.toString().replace(':encrypted', ''),
  },
  app: {
    getPath: () => os.tmpdir(),
  },
}));

let tmpPath: string;
beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `clawdia-vault-test-${Date.now()}.sqlite`);
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

describe('IdentityStore', () => {
  it('creates and retrieves a default identity profile', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    const profile = store.upsertProfile({ name: 'default', fullName: 'Test User', email: 'test@example.com', isDefault: true });
    expect(profile.id).toBeGreaterThan(0);
    const fetched = store.getDefaultProfile();
    expect(fetched?.fullName).toBe('Test User');
  });

  it('saves and retrieves a managed account', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    store.saveAccount({ serviceName: 'reddit', loginUrl: 'https://reddit.com/login', username: 'testuser', emailUsed: 'test@example.com', passwordPlain: 'secret123', status: 'active' });
    const account = store.getAccount('reddit');
    expect(account?.username).toBe('testuser');
    expect(account?.passwordPlain).toBe('secret123');
  });

  it('encrypts passwords at rest', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    store.saveAccount({ serviceName: 'github', loginUrl: 'https://github.com/login', username: 'dev', emailUsed: 'dev@example.com', passwordPlain: 'mypassword', status: 'active' });
    // Read raw DB value — should NOT be the plaintext password
    const db = new Database(tmpPath);
    const row = db.prepare('SELECT password_encrypted FROM managed_accounts WHERE service_name = ?').get('github') as any;
    expect(row.password_encrypted).not.toBe('mypassword');
    expect(row.password_encrypted).not.toContain('mypassword'); // truly encrypted
    db.close();
  });

  it('saves and retrieves a credential vault entry', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    store.saveCredential({ label: 'twilio-sid', type: 'api_key', service: 'twilio', valuePlain: 'AC123' });
    const val = store.getCredential('twilio-sid', 'twilio');
    expect(val).toBe('AC123');
  });

  it('returns null for unknown account', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const store = new IdentityStore();
    expect(store.getAccount('nonexistent')).toBeNull();
  });
});
