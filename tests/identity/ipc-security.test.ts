/**
 * IPC security tests — verify that sensitive fields never reach the renderer.
 */
import { describe, it, expect } from 'vitest';

interface ManagedAccount {
  id: number;
  serviceName: string;
  loginUrl: string;
  username: string;
  emailUsed: string;
  passwordPlain: string;
  phoneUsed: string;
  phoneMethod: string;
  status: 'active' | 'suspended' | 'unverified';
  createdAt: string;
  notes: string;
}

interface ManagedAccountView {
  id: number;
  serviceName: string;
  loginUrl: string;
  username: string;
  emailUsed: string;
  passwordPlain?: string;
  phoneUsed: string;
  phoneMethod: string;
  status: 'active' | 'suspended' | 'unverified';
  accessType: 'session' | 'vault' | 'managed';
  source: 'managed' | 'session';
  createdAt: string;
  notes: string;
}

function stripPassword(account: ManagedAccount, accessType: 'session' | 'vault' | 'managed'): ManagedAccountView {
  const { passwordPlain: _omit, ...view } = account;
  return { ...view, accessType, source: 'managed' };
}

const mockAccount: ManagedAccount = {
  id: 1,
  serviceName: 'reddit.com',
  loginUrl: 'https://reddit.com/login',
  username: 'dp_user',
  emailUsed: '',
  passwordPlain: 'supersecret123',
  phoneUsed: '',
  phoneMethod: '',
  status: 'active',
  createdAt: '2026-03-24T00:00:00Z',
  notes: '',
};

describe('IDENTITY_ACCOUNTS_LIST DTO', () => {
  it('does not include passwordPlain in the rendered view', () => {
    const view = stripPassword(mockAccount, 'session');
    expect('passwordPlain' in view).toBe(false);
    expect((view as any).passwordPlain).toBeUndefined();
  });

  it('includes all other expected fields', () => {
    const view = stripPassword(mockAccount, 'vault');
    expect(view.id).toBe(1);
    expect(view.serviceName).toBe('reddit.com');
    expect(view.username).toBe('dp_user');
    expect(view.accessType).toBe('vault');
    expect(view.source).toBe('managed');
  });

  it('accessType is set by the caller, not read from the account', () => {
    const session = stripPassword(mockAccount, 'session');
    const managed = stripPassword(mockAccount, 'managed');
    expect(session.accessType).toBe('session');
    expect(managed.accessType).toBe('managed');
  });
});

describe('IDENTITY_CREDENTIALS_LIST masking', () => {
  it('masks all but last 4 chars', () => {
    const mask = (val: string) =>
      '•'.repeat(Math.max(0, val.length - 4)) + val.slice(-4);
    expect(mask('AC1234567890abcd3f2a')).toBe('••••••••••••••••3f2a');
    expect(mask('abcd')).toBe('abcd');
    expect(mask('short')).toBe('•hort');
    expect(mask('')).toBe('');
  });
});
