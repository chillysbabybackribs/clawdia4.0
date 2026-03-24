/**
 * PhoneVerifier — handles SMS verification codes during signup.
 *
 * Priority:
 *   1. Google Voice (browser, zero external deps)
 *   2. Twilio (REST API, credentials from vault)
 *   3. Human-in-the-loop fallback
 */
import type { BrowserView } from 'electron';
import { wait } from '../browser/waits';
import { identityStore } from './identity-store';

const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 3 * 60 * 1_000;

// ─── Google Voice ─────────────────────────────────────────────────────────────

/**
 * Navigate to voice.google.com and wait for an SMS from `senderPattern`.
 * Returns the SMS body text, or null on timeout.
 */
export async function waitForGoogleVoiceSms(view: BrowserView, senderPattern: string): Promise<string | null> {
  const wc = view.webContents;
  const currentUrl = wc.getURL();
  if (!currentUrl.includes('voice.google.com')) {
    wc.loadURL('https://voice.google.com/u/0/messages');
    await wait(3000);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const found = await wc.executeJavaScript(`(() => {
        const items = Array.from(document.querySelectorAll('[data-item-id]'));
        return items.some(el => el.textContent?.toLowerCase().includes(${JSON.stringify(senderPattern.toLowerCase())}));
      })()`);

      if (found) {
        await wc.executeJavaScript(`(() => {
          const items = Array.from(document.querySelectorAll('[data-item-id]'));
          const match = items.find(el => el.textContent?.toLowerCase().includes(${JSON.stringify(senderPattern.toLowerCase())}));
          if (match) (match as HTMLElement).click();
        })()`);
        await wait(1500);
        const text = await wc.executeJavaScript(`document.querySelector('gv-message-item')?.innerText ?? ''`);
        return text as string;
      }
    } catch { /* keep polling */ }

    wc.loadURL('https://voice.google.com/u/0/messages');
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}

// ─── Twilio ───────────────────────────────────────────────────────────────────

/**
 * Poll Twilio REST API for an incoming SMS.
 * Credentials must be stored in the vault under labels 'twilio-account-sid' and 'twilio-auth-token'.
 * The Twilio phone number must be stored under 'twilio-phone-number'.
 */
export async function waitForTwilioSms(senderPattern: string): Promise<string | null> {
  const sid = identityStore.getCredential('twilio-account-sid', 'twilio');
  const token = identityStore.getCredential('twilio-auth-token', 'twilio');
  if (!sid || !token) {
    console.warn('[PhoneVerifier] Twilio credentials not found in vault');
    return null;
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?Direction=inbound&PageSize=5`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      const data = await res.json() as any;
      const messages: any[] = data.messages ?? [];
      const match = messages.find((m: any) =>
        m.body?.toLowerCase().includes(senderPattern.toLowerCase()) ||
        m.from?.includes(senderPattern)
      );
      if (match) return match.body as string;
    } catch (err) {
      console.error('[PhoneVerifier] Twilio poll error:', err);
    }
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}

// ─── Code extraction (reuse from email-monitor pattern) ──────────────────────

export function extractSmsCode(body: string): string | null {
  const match = body.match(/\b(\d{4,8})\b/);
  return match?.[1] ?? null;
}
