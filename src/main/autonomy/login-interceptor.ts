/**
 * Login interceptor — auto-captures credentials when the user logs into a site
 * in Clawdia's persistent BrowserView.
 *
 * Mechanism:
 *  1. dom-ready on a login URL → inject submit listener writing to window.__clawdia_captured
 *  2. will-navigate from a login URL → read window.__clawdia_captured, store in pendingCaptures Map, delete from page
 *  3. did-navigate to a non-auth URL → save credentials + update account registry + emit IDENTITY_ACCOUNTS_CHANGED
 *
 * Out of scope: SPA logins (history.pushState), fetch-based form submissions,
 * JS-rendered login forms.
 */

import { BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import { identityStore } from './identity-store';

type PendingCapture = { username: string; password: string; loginUrl: string };
const pendingCaptures = new Map<number, PendingCapture>();

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

function emitAccountsChanged(): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(IPC_EVENTS.IDENTITY_ACCOUNTS_CHANGED);
}

const SUBMIT_LISTENER_JS = `
(function() {
  if (window.__clawdia_listener_installed) return;
  window.__clawdia_listener_installed = true;
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (!form) return;
    var pw = form.querySelector('input[type=password]');
    var user = form.querySelector('input[type=email], input[type=text]');
    if (pw) {
      window.__clawdia_captured = { username: user ? user.value : '', password: pw.value };
    }
  }, { capture: true });
})();
`;

export function attachToWebContents(wc: WebContents): void {
  wc.on('dom-ready', () => {
    const url = wc.getURL();
    if (isLoginUrl(url)) {
      wc.executeJavaScript(SUBMIT_LISTENER_JS).catch(() => null);
    }
  });

  wc.on('will-navigate', async (_event, _targetUrl) => {
    const fromUrl = wc.getURL();
    if (!fromUrl.startsWith('https://')) return;
    if (!isLoginUrl(fromUrl)) return;

    try {
      const captured = await wc.executeJavaScript('window.__clawdia_captured || null');
      if (captured && captured.password) {
        pendingCaptures.set(wc.id, { ...captured, loginUrl: fromUrl });
        wc.executeJavaScript('delete window.__clawdia_captured; delete window.__clawdia_listener_installed;').catch(() => null);
      }
    } catch {
      // executeJavaScript can throw if the frame is gone
    }
  });

  wc.once('destroyed', () => pendingCaptures.delete(wc.id));

  wc.on('did-navigate', (_event, newUrl) => {
    const pending = pendingCaptures.get(wc.id);
    if (!pending) return;

    if (isLoginUrl(newUrl)) {
      pendingCaptures.delete(wc.id); // Failed login — back on login page
      return;
    }

    if (isAuthUrl(newUrl)) return; // 2FA / MFA hold — wait for next navigation

    // Successful login
    pendingCaptures.delete(wc.id);
    const serviceName = extractDomain(pending.loginUrl);
    if (!serviceName) return;

    identityStore.saveCredential({
      label: `${serviceName}-password`,
      type: 'app_password',
      service: serviceName,
      valuePlain: pending.password,
    });

    const existing = identityStore.getAccount(serviceName);
    if (!existing) {
      identityStore.saveAccount({
        serviceName,
        loginUrl: pending.loginUrl,
        username: pending.username,
        passwordPlain: pending.password,
        status: 'active',
      });
    }

    emitAccountsChanged();
    console.log(`[LoginInterceptor] Captured login for ${serviceName} (user: ${pending.username})`);
  });
}
