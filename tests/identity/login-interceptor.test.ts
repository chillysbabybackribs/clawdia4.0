/**
 * Tests for the login interceptor state machine logic.
 * Pure functions only — no Electron dependency.
 */

function isLoginUrl(url: string): boolean {
  try {
    const { pathname, hostname } = new URL(url);
    const p = pathname.toLowerCase();
    return /\/login\b/.test(p) || /\/signin\b/.test(p) ||
           /\/auth\b/.test(p) || /\/session\b/.test(p) ||
           hostname.includes('login.') || hostname.includes('signin.');
  } catch {
    return false;
  }
}

function isAuthUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    const p = pathname.toLowerCase();
    return p.includes('/2fa') || p.includes('/two-factor') || p.includes('/verify') ||
           p.includes('/otp') || p.includes('/mfa') || p.includes('/challenge');
  } catch {
    return false;
  }
}

function extractDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

type PendingCapture = { username: string; password: string; loginUrl: string };

function simulateInterceptor() {
  const pendingCaptures = new Map<number, PendingCapture>();
  const saved: { serviceName: string; username: string }[] = [];

  const onWillNavigate = (wcId: number, fromUrl: string, captured: PendingCapture | null) => {
    if (!fromUrl.startsWith('https://')) return;
    if (isLoginUrl(fromUrl) && captured) {
      pendingCaptures.set(wcId, { ...captured, loginUrl: fromUrl });
    }
  };

  const onDidNavigate = (wcId: number, newUrl: string) => {
    const pending = pendingCaptures.get(wcId);
    if (!pending) return;
    if (isLoginUrl(newUrl)) {
      pendingCaptures.delete(wcId); // Failed login — back on login page
      return;
    }
    if (isAuthUrl(newUrl)) return; // 2FA / MFA hold — wait for next navigation
    pendingCaptures.delete(wcId);
    saved.push({ serviceName: extractDomain(pending.loginUrl), username: pending.username });
  };

  return { pendingCaptures, saved, onWillNavigate, onDidNavigate };
}

describe('isLoginUrl', () => {
  it('detects /login paths', () => {
    expect(isLoginUrl('https://reddit.com/login')).toBe(true);
    expect(isLoginUrl('https://example.com/signin')).toBe(true);
    expect(isLoginUrl('https://auth.example.com/auth/token')).toBe(true);
  });
  it('does not flag non-login pages', () => {
    expect(isLoginUrl('https://reddit.com/r/programming')).toBe(false);
    expect(isLoginUrl('https://github.com/dashboard')).toBe(false);
  });
  it('returns false for invalid URLs', () => {
    expect(isLoginUrl('not-a-url')).toBe(false);
  });
});

describe('HTTPS-only guard', () => {
  it('does not store capture for HTTP pages', () => {
    const { pendingCaptures, onWillNavigate } = simulateInterceptor();
    onWillNavigate(1, 'http://reddit.com/login', { username: 'u', password: 'p', loginUrl: 'http://reddit.com/login' });
    expect(pendingCaptures.size).toBe(0);
  });
  it('stores capture for HTTPS pages', () => {
    const { pendingCaptures, onWillNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://reddit.com/login', { username: 'u', password: 'p', loginUrl: 'https://reddit.com/login' });
    expect(pendingCaptures.size).toBe(1);
  });
});

describe('Successful login capture', () => {
  it('saves credentials when navigating from login to non-auth URL', () => {
    const { saved, onWillNavigate, onDidNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://reddit.com/login', { username: 'dp_user', password: 'secret', loginUrl: 'https://reddit.com/login' });
    onDidNavigate(1, 'https://reddit.com/');
    expect(saved).toHaveLength(1);
    expect(saved[0].serviceName).toBe('reddit.com');
    expect(saved[0].username).toBe('dp_user');
  });
});

describe('Failed login — lands back on login URL', () => {
  it('discards pending capture when did-navigate returns to a login URL', () => {
    const { saved, pendingCaptures, onWillNavigate, onDidNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://reddit.com/login', { username: 'dp_user', password: 'wrong', loginUrl: 'https://reddit.com/login' });
    onDidNavigate(1, 'https://reddit.com/login?error=1');
    expect(saved).toHaveLength(0);
    expect(pendingCaptures.size).toBe(0);
  });
});

describe('2FA hold', () => {
  it('holds capture on /verify URL and saves on final redirect', () => {
    const { saved, pendingCaptures, onWillNavigate, onDidNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://github.com/login', { username: 'dpdev', password: 'pw', loginUrl: 'https://github.com/login' });
    onDidNavigate(1, 'https://github.com/sessions/two-factor/app');
    expect(saved).toHaveLength(0);
    expect(pendingCaptures.has(1)).toBe(true);
    onDidNavigate(1, 'https://github.com/dashboard');
    expect(saved).toHaveLength(1);
  });
});

describe('Concurrent captures', () => {
  it('isolates captures across different webContents ids', () => {
    const { saved, onWillNavigate, onDidNavigate } = simulateInterceptor();
    onWillNavigate(1, 'https://reddit.com/login', { username: 'u1', password: 'p1', loginUrl: 'https://reddit.com/login' });
    onWillNavigate(2, 'https://github.com/login', { username: 'u2', password: 'p2', loginUrl: 'https://github.com/login' });
    onDidNavigate(1, 'https://reddit.com/');
    onDidNavigate(2, 'https://github.com/dashboard');
    expect(saved).toHaveLength(2);
    expect(saved.map(s => s.serviceName).sort()).toEqual(['github.com', 'reddit.com']);
  });
});
