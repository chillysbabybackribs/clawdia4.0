import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { NewPaymentMethod, CardType } from '../db/payment-methods';

export type PaymentMethodCandidate = NewPaymentMethod & { browserSource: 'chrome' | 'firefox' };

const CHROME_WEB_DATA_PATHS = [
  path.join(os.homedir(), '.config/google-chrome/Default/Web Data'),
  path.join(os.homedir(), '.config/chromium/Default/Web Data'),
  path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Web Data'), // macOS
];

function inferCardType(nameOnCard: string): CardType {
  const name = nameOnCard.toLowerCase();
  if (name.includes('visa')) return 'visa';
  if (name.includes('mastercard') || name.includes('master')) return 'mastercard';
  if (name.includes('amex') || name.includes('american express')) return 'amex';
  if (name.includes('discover')) return 'discover';
  return 'other';
}

function scanChrome(): PaymentMethodCandidate[] {
  for (const webDataPath of CHROME_WEB_DATA_PATHS) {
    if (!fs.existsSync(webDataPath)) continue;
    try {
      // Copy to tmp to avoid locking the live file
      const tmpPath = path.join(os.tmpdir(), `clawdia-webdata-${Date.now()}.db`);
      fs.copyFileSync(webDataPath, tmpPath);
      const db = new Database(tmpPath, { readonly: true });
      try {
        // CRITICAL: Only read display metadata columns. NEVER read card_number_encrypted.
        const rows = db.prepare<Array<{
          name_on_card: string;
          last_four: string;
          expiration_month: number;
          expiration_year: number;
        }>>(`
          SELECT name_on_card, last_four, expiration_month, expiration_year
          FROM credit_cards
          WHERE use_count > 0
        `).all();

        return rows.map(row => ({
          label: `${inferCardType(row.name_on_card)} ••••${row.last_four}`,
          lastFour: row.last_four,
          cardType: inferCardType(row.name_on_card),
          expiryMonth: row.expiration_month,
          expiryYear: row.expiration_year,
          billingName: row.name_on_card || undefined,
          source: 'browser_autofill' as const,
          browserSource: 'chrome' as const,
        }));
      } finally {
        db.close();
        try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      }
    } catch {
      // Locked or unreadable — silently return empty
      return [];
    }
  }
  return [];
}

export async function scanBrowserCards(): Promise<PaymentMethodCandidate[]> {
  const results: PaymentMethodCandidate[] = [];
  try {
    results.push(...scanChrome());
  } catch {
    // Never throw
  }
  return results;
}
