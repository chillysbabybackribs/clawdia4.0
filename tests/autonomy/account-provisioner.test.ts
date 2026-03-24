import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => os.tmpdir() },
}));

let tmpPath: string;
beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `clawdia-prov-test-${Date.now()}.sqlite`);
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

describe('AccountProvisioner', () => {
  it('returns existing account without provisioning if active', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const { AccountProvisioner } = await import('../../src/main/autonomy/account-provisioner');

    const store = new IdentityStore();
    store.saveAccount({ serviceName: 'reddit', passwordPlain: 'existing', status: 'active' });

    const provisioner = new AccountProvisioner(store);
    const result = await provisioner.ensureAccount('reddit');
    expect(result.status).toBe('existing');
    expect(result.account?.serviceName).toBe('reddit');
  });

  it('calls signupFn when no account exists', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const { AccountProvisioner } = await import('../../src/main/autonomy/account-provisioner');

    const store = new IdentityStore();
    store.upsertProfile({ name: 'default', fullName: 'Test User', email: 'test@example.com', isDefault: true });

    const mockSignup = vi.fn().mockResolvedValue({ username: 'testuser', password: 'newpass', email: 'test@example.com' });
    const provisioner = new AccountProvisioner(store);

    const result = await provisioner.ensureAccount('newservice', {
      loginUrl: 'https://newservice.com/login',
      signupFn: mockSignup,
    });

    expect(mockSignup).toHaveBeenCalledOnce();
    expect(result.status).toBe('provisioned');
    expect(store.getAccount('newservice')?.status).toBe('active');
  });

  it('returns needs_human when signupFn throws InterventionNeeded', async () => {
    const { IdentityStore } = await import('../../src/main/autonomy/identity-store');
    const { AccountProvisioner, InterventionNeeded } = await import('../../src/main/autonomy/account-provisioner');

    const store = new IdentityStore();
    const provisioner = new AccountProvisioner(store);

    const mockSignup = vi.fn().mockRejectedValue(new InterventionNeeded('captcha', 'Please solve the CAPTCHA'));
    const result = await provisioner.ensureAccount('captchasite', { signupFn: mockSignup });

    expect(result.status).toBe('needs_human');
    expect(result.interventionType).toBe('captcha');
  });
});
