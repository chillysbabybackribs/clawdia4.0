import { describe, expect, it } from 'vitest';
import {
  listSessionDomains,
  mergeDiscoveredSessionAccounts,
  normalizeCookieDomain,
  toManagedAccountView,
} from '../../src/main/autonomy/session-discovery';

describe('normalizeCookieDomain()', () => {
  it('normalizes casing, leading dots, and www', () => {
    expect(normalizeCookieDomain(' .WWW.Reddit.COM ')).toBe('reddit.com');
  });
});

describe('listSessionDomains()', () => {
  it('deduplicates and filters non-account domains', async () => {
    const session = {
      cookies: {
        get: async () => [
          { domain: '.WWW.Reddit.COM' },
          { domain: 'reddit.com' },
          { domain: 'localhost' },
          { domain: '192.168.1.1' },
          { domain: 'cdn.doubleclick.net' },
          { domain: '.github.com' },
        ],
      },
    };

    await expect(listSessionDomains(session)).resolves.toEqual(['github.com', 'reddit.com']);
  });
});

describe('mergeDiscoveredSessionAccounts()', () => {
  it('keeps managed rows first and appends only new discovered domains', () => {
    const managedViews = [
      toManagedAccountView({
        id: 1,
        serviceName: 'www.reddit.com',
        loginUrl: '',
        username: 'dp_user',
        emailUsed: '',
        passwordPlain: 'secret',
        phoneUsed: '',
        phoneMethod: '',
        status: 'active',
        createdAt: '2026-03-24T00:00:00Z',
        notes: '',
      }, 'session'),
      toManagedAccountView({
        id: 2,
        serviceName: 'github.com',
        loginUrl: '',
        username: 'dpdev',
        emailUsed: '',
        passwordPlain: 'secret',
        phoneUsed: '',
        phoneMethod: '',
        status: 'active',
        createdAt: '2026-03-24T00:00:00Z',
        notes: '',
      }, 'vault'),
    ];

    const merged = mergeDiscoveredSessionAccounts(managedViews, [
      'reddit.com',
      'github.com',
      'protonmail.com',
    ]);

    expect(merged).toHaveLength(3);
    expect(merged[0]?.source).toBe('managed');
    expect(merged[1]?.source).toBe('managed');
    expect(merged[2]).toMatchObject({
      id: 0,
      serviceName: 'protonmail.com',
      accessType: 'session',
      source: 'session',
    });
  });
});
