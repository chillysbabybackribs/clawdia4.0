/**
 * EmailMonitor — watches an inbox for verification emails during signup flows.
 *
 * Two modes:
 *   - browser: navigates to Gmail/Yahoo in the BrowserView and polls for new mail
 *   - tempmail: polls mail.tm API for a throwaway address
 */
import type { BrowserView } from 'electron';
import { wait } from '../browser/waits';

const TEMPMAIL_BASE = 'https://api.mail.tm';
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes

// ─── Temp-mail ────────────────────────────────────────────────────────────────

export interface TempMailbox {
  address: string;
  token: string;
}

export async function createTempMailbox(): Promise<TempMailbox> {
  // Get available domain
  const domainsRes = await fetch(`${TEMPMAIL_BASE}/domains`);
  const domains = await domainsRes.json() as any;
  const domain = domains['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('No temp-mail domains available');

  const username = `clawdia${Date.now()}`;
  const password = `Tmp${Math.random().toString(36).slice(2, 10)}!`;
  const address = `${username}@${domain}`;

  await fetch(`${TEMPMAIL_BASE}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });

  const tokenRes = await fetch(`${TEMPMAIL_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const tokenData = await tokenRes.json() as any;
  return { address, token: tokenData.token };
}

/** Poll temp-mail inbox until a message matching `senderDomain` arrives. Returns the message body. */
export async function waitForTempMail(mailbox: TempMailbox, senderDomain: string): Promise<string | null> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${TEMPMAIL_BASE}/messages`, {
      headers: { Authorization: `Bearer ${mailbox.token}` },
    });
    const data = await res.json() as any;
    const messages: any[] = data['hydra:member'] ?? [];
    const match = messages.find((m: any) =>
      m.from?.address?.includes(senderDomain) || m.subject?.toLowerCase().includes(senderDomain.split('.')[0])
    );
    if (match) {
      // Fetch full message body
      const msgRes = await fetch(`${TEMPMAIL_BASE}/messages/${match.id}`, {
        headers: { Authorization: `Bearer ${mailbox.token}` },
      });
      const msg = await msgRes.json() as any;
      return msg.text ?? msg.html ?? '';
    }
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}

// ─── Browser inbox (Gmail/Yahoo) ──────────────────────────────────────────────

/** Navigate to Gmail inbox and wait for a verification email from `senderDomain`. Returns the email body text. */
export async function waitForGmailVerification(view: BrowserView, senderDomain: string): Promise<string | null> {
  const wc = view.webContents;
  const deadline = Date.now() + MAX_WAIT_MS;

  // Navigate to Gmail if not already there
  const currentUrl = wc.getURL();
  if (!currentUrl.includes('mail.google.com')) {
    wc.loadURL('https://mail.google.com/mail/u/0/#inbox');
    await wait(3000);
  }

  while (Date.now() < deadline) {
    try {
      // Look for an unread email row matching the sender domain
      const found = await wc.executeJavaScript(`(() => {
        const rows = Array.from(document.querySelectorAll('[role="row"]'));
        return rows.some(row => row.textContent && row.textContent.toLowerCase().includes(${JSON.stringify(senderDomain.split('.')[0])}));
      })()`);

      if (found) {
        // Click the matching row
        await wc.executeJavaScript(`(() => {
          const rows = Array.from(document.querySelectorAll('[role="row"]'));
          const match = rows.find(row => row.textContent && row.textContent.toLowerCase().includes(${JSON.stringify(senderDomain.split('.')[0])}));
          if (match) (match as HTMLElement).click();
        })()`);
        await wait(2000);
        // Extract body text
        const body = await wc.executeJavaScript(`document.querySelector('[role="main"]')?.innerText ?? ''`);
        return body as string;
      }
    } catch { /* ignore JS errors, keep polling */ }

    // Reload inbox to check for new mail
    wc.loadURL('https://mail.google.com/mail/u/0/#inbox');
    await wait(POLL_INTERVAL_MS);
  }
  return null;
}

// ─── Code/link extraction ─────────────────────────────────────────────────────

/** Extract a numeric OTP code from email body text. Returns null if not found. */
export function extractOtpCode(body: string): string | null {
  const match = body.match(/\b(\d{4,8})\b/);
  return match?.[1] ?? null;
}

/** Extract a verification link from email body text. Returns null if not found. */
export function extractVerificationLink(body: string): string | null {
  const urlMatch = body.match(/https?:\/\/[^\s"'<>]+(?:verif|confirm|activate|token)[^\s"'<>]*/i);
  return urlMatch?.[0] ?? null;
}
