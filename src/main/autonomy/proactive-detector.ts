/**
 * ProactiveDetector — tracks how often services are mentioned in conversation
 * and suggests pre-creating accounts before they're needed.
 *
 * Service detection uses an allowlist + case-insensitive regex — no LLM required.
 */
import { getDb } from '../db/database';
import type { IdentityStore } from './identity-store';
import { identityStore } from './identity-store';

// Expand this list as needed. Keys are canonical service names (lowercase).
const SERVICE_PATTERNS: Record<string, RegExp> = {
  reddit:    /\breddit\b/i,
  twitter:   /\btwitter\b|\bx\.com\b/i,
  linkedin:  /\blinkedin\b/i,
  github:    /\bgithub\b/i,
  youtube:   /\byoutube\b/i,
  instagram: /\binstagram\b/i,
  facebook:  /\bfacebook\b/i,
  tiktok:    /\btiktok\b/i,
  discord:   /\bdiscord\b/i,
  slack:     /\bslack\b/i,
  notion:    /\bnotion\b/i,
  trello:    /\btrello\b/i,
  jira:      /\bjira\b/i,
  amazon:    /\bamazon\b/i,
  ebay:      /\bebay\b/i,
};

export class ProactiveDetector {
  constructor(private readonly store?: IdentityStore) {}

  /** Scan a message for service mentions and persist counts to DB. */
  recordMentions(messageText: string): void {
    const db = getDb();
    for (const [service, pattern] of Object.entries(SERVICE_PATTERNS)) {
      if (pattern.test(messageText)) {
        db.prepare(`
          INSERT INTO service_mentions (service_name, mention_count, last_seen)
          VALUES (?, 1, datetime('now'))
          ON CONFLICT(service_name) DO UPDATE SET
            mention_count = mention_count + 1,
            last_seen = datetime('now')
        `).run(service);
      }
    }
  }

  /** Get the current mention count for a service. */
  getMentionCount(serviceName: string): number {
    const row = getDb()
      .prepare('SELECT mention_count FROM service_mentions WHERE service_name = ?')
      .get(serviceName) as any;
    return row?.mention_count ?? 0;
  }

  /**
   * Returns service names that:
   *   1. Have >= `threshold` mentions
   *   2. Do NOT have an active account in managed_accounts
   */
  getServicesOverThreshold(threshold = 3): string[] {
    const rows = getDb()
      .prepare('SELECT service_name FROM service_mentions WHERE mention_count >= ?')
      .all(threshold) as any[];

    return rows
      .map((r: any) => r.service_name as string)
      .filter((service) => {
        if (!this.store) return true;
        const account = this.store.getAccount(service);
        return !account || account.status !== 'active';
      });
  }
}

// Singleton for use across the autonomy module and main.ts
export const proactiveDetector = new ProactiveDetector(identityStore);
