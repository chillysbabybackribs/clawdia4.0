import type { ManagedAccount } from './identity-store';

export interface ManagedAccountView {
  id: number;
  serviceName: string;
  loginUrl: string;
  username: string;
  emailUsed: string;
  phoneUsed: string;
  phoneMethod: string;
  status: 'active' | 'suspended' | 'unverified';
  accessType: 'session' | 'vault' | 'managed';
  source: 'managed' | 'session';
  createdAt: string;
  notes: string;
}

const DISCOVERY_BLOCKLIST = new Set([
  'doubleclick.net',
  'google-analytics.com',
  'googleapis.com',
  'gstatic.com',
  'cloudflare.com',
  'cloudfront.net',
  'fastly.net',
  'akamai.net',
  'akamaihdp.net',
  'amazon-adsystem.com',
  'adsymptotic.com',
  'scorecardresearch.com',
  'quantserve.com',
  'moatads.com',
]);

type CookieSessionLike = {
  cookies: {
    get: (filter: Record<string, unknown>) => Promise<Array<{ domain?: string | null }>>;
  };
};

export function normalizeCookieDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, '').replace(/^www\./, '');
}

function isBlockedDomain(domain: string): boolean {
  for (const blocked of DISCOVERY_BLOCKLIST) {
    if (domain === blocked || domain.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

export function isDiscoverableSessionDomain(domain: string): boolean {
  if (!domain || !domain.includes('.')) return false;
  if (/^\d+\./.test(domain)) return false;
  if (isBlockedDomain(domain)) return false;
  return true;
}

export async function listSessionDomains(session: CookieSessionLike): Promise<string[]> {
  const cookies = await session.cookies.get({});
  const domains = new Set<string>();
  for (const cookie of cookies) {
    const domain = normalizeCookieDomain(String(cookie.domain || ''));
    if (!isDiscoverableSessionDomain(domain)) continue;
    domains.add(domain);
  }
  return Array.from(domains).sort();
}

export function toManagedAccountView(
  account: ManagedAccount,
  accessType: ManagedAccountView['accessType'],
): ManagedAccountView {
  const { passwordPlain: _omit, ...view } = account;
  return { ...view, accessType, source: 'managed' };
}

export function createSyntheticSessionAccount(serviceName: string): ManagedAccountView {
  return {
    id: 0,
    serviceName,
    loginUrl: '',
    username: '',
    emailUsed: '',
    phoneUsed: '',
    phoneMethod: '',
    status: 'active',
    accessType: 'session',
    source: 'session',
    createdAt: '',
    notes: '',
  };
}

export function mergeDiscoveredSessionAccounts(
  managedViews: ManagedAccountView[],
  discoveredDomains: string[],
): ManagedAccountView[] {
  const managedDomains = new Set(managedViews.map((account) => normalizeCookieDomain(account.serviceName)));
  const syntheticViews = discoveredDomains
    .filter((domain) => !managedDomains.has(normalizeCookieDomain(domain)))
    .map((domain) => createSyntheticSessionAccount(domain));
  return [...managedViews, ...syntheticViews];
}
