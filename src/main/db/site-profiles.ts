/**
 * Site Profiles — Browser session & navigation awareness.
 *
 * Tracks which sites the user has authenticated on, what their accounts
 * look like, and navigation patterns that have worked before. This gives
 * the LLM immediate awareness of the user's web identity without
 * re-discovering it each conversation.
 *
 * Updated automatically by browser_navigate:
 *   - auth_status flips to 'authenticated' when login detection doesn't trigger
 *   - auth_status flips to 'unauthenticated' when login detection triggers
 *   - visit_count increments on every navigation
 *   - account_info extracted from page content (username, display name)
 *   - nav_hints track successful navigation paths
 *   - page_map tracks known pages and what they contain
 */

import { getDb } from './database';

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export interface SiteProfile {
  domain: string;
  displayName: string;
  authStatus: 'authenticated' | 'unauthenticated' | 'unknown';
  lastVisited: string;
  visitCount: number;
  navHints: NavHints;
  accountInfo: AccountInfo;
  pageMap: PageMap;
}

export interface NavHints {
  /** Known working URLs for common actions on this domain */
  knownPaths: Record<string, string>;  // "notifications" → "/notifications"
  /** Menu items or navigation elements discovered on the site */
  menuItems?: string[];
}

export interface AccountInfo {
  /** Detected username or display name from page content */
  username?: string;
  displayName?: string;
  /** Account type if detectable (e.g., "pro", "free", "business") */
  accountType?: string;
  /** Profile URL if found */
  profileUrl?: string;
}

export interface PageMap {
  /** domain-relative paths → short description of what the page contains */
  [path: string]: string;
}

// ═══════════════════════════════════
// CRUD
// ═══════════════════════════════════

/** Extract the base domain from a URL. */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

/** Get a site profile by domain. Returns null if not tracked. */
export function getSiteProfile(domain: string): SiteProfile | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM site_profiles WHERE domain = ?').get(domain) as any;
  if (!row) return null;
  return {
    domain: row.domain,
    displayName: row.display_name,
    authStatus: row.auth_status,
    lastVisited: row.last_visited,
    visitCount: row.visit_count,
    navHints: safeJsonParse(row.nav_hints, { knownPaths: {} }),
    accountInfo: safeJsonParse(row.account_info, {}),
    pageMap: safeJsonParse(row.page_map, {}),
  };
}

/** Create or update a site profile. */
export function upsertSiteProfile(profile: SiteProfile): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO site_profiles (domain, display_name, auth_status, last_visited, visit_count, nav_hints, account_info, page_map)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      display_name = excluded.display_name,
      auth_status = excluded.auth_status,
      last_visited = excluded.last_visited,
      visit_count = excluded.visit_count,
      nav_hints = excluded.nav_hints,
      account_info = excluded.account_info,
      page_map = excluded.page_map
  `).run(
    profile.domain,
    profile.displayName,
    profile.authStatus,
    profile.lastVisited,
    profile.visitCount,
    JSON.stringify(profile.navHints),
    JSON.stringify(profile.accountInfo),
    JSON.stringify(profile.pageMap),
  );
}

/** Get all authenticated site profiles, ordered by visit frequency. */
export function getAuthenticatedSites(): SiteProfile[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM site_profiles
    WHERE auth_status = 'authenticated'
    ORDER BY visit_count DESC
    LIMIT 20
  `).all() as any[];
  return rows.map(rowToProfile);
}

/** Get the top N most-visited sites regardless of auth status. */
export function getFrequentSites(limit: number = 10): SiteProfile[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM site_profiles
    ORDER BY visit_count DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map(rowToProfile);
}

// ═══════════════════════════════════
// Learning — Called by browser executors after navigation
// ═══════════════════════════════════

/**
 * Record a visit to a URL. Updates the site profile with auth status,
 * page path, and increments the visit counter.
 *
 * Called by executeBrowserNavigate after every successful navigation.
 */
export function recordVisit(
  url: string,
  opts: {
    authenticated: boolean;
    title?: string;
    contentSnippet?: string;
  },
): void {
  const domain = extractDomain(url);
  if (!domain || domain === 'google.com' || domain === 'www.google.com') return; // Skip search engine

  const existing = getSiteProfile(domain) || {
    domain,
    displayName: domainToDisplayName(domain),
    authStatus: 'unknown' as const,
    lastVisited: new Date().toISOString(),
    visitCount: 0,
    navHints: { knownPaths: {} },
    accountInfo: {},
    pageMap: {},
  };

  // Update auth status
  existing.authStatus = opts.authenticated ? 'authenticated' : 'unauthenticated';
  existing.lastVisited = new Date().toISOString();
  existing.visitCount++;

  // Track the path and what's on it
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    if (path !== '/' && opts.title) {
      existing.pageMap[path] = opts.title.slice(0, 100);
      // Keep page map from growing unbounded
      const keys = Object.keys(existing.pageMap);
      if (keys.length > 30) {
        for (const k of keys.slice(0, keys.length - 30)) delete existing.pageMap[k];
      }
    }
  } catch {}

  // Try to extract account info from authenticated pages
  if (opts.authenticated && opts.contentSnippet) {
    const extracted = extractAccountInfo(domain, opts.contentSnippet);
    if (extracted) {
      existing.accountInfo = { ...existing.accountInfo, ...extracted };
    }
  }

  upsertSiteProfile(existing);
}

/**
 * Record a known navigation path that worked.
 * Called when the LLM successfully completes a navigation action.
 */
export function recordNavHint(domain: string, intent: string, path: string): void {
  const existing = getSiteProfile(domain);
  if (!existing) return;
  existing.navHints.knownPaths[intent] = path;
  // Cap at 20 hints
  const keys = Object.keys(existing.navHints.knownPaths);
  if (keys.length > 20) {
    for (const k of keys.slice(0, keys.length - 20)) delete existing.navHints.knownPaths[k];
  }
  upsertSiteProfile(existing);
}

// ═══════════════════════════════════
// Prompt Context — Injected before browser tasks
// ═══════════════════════════════════

/**
 * Build a compact prompt block summarizing the user's known site profiles.
 * Only includes authenticated sites and frequently visited sites.
 * Designed for injection into the dynamic prompt.
 */
export function getSiteContextPrompt(): string {
  const authenticated = getAuthenticatedSites();
  if (authenticated.length === 0) return '';

  const lines: string[] = ['[Authenticated sites — user is logged in to these]'];

  for (const site of authenticated.slice(0, 10)) {
    let line = `• ${site.displayName} (${site.domain})`;
    if (site.accountInfo.username) line += ` — user: ${site.accountInfo.username}`;
    if (site.accountInfo.accountType) line += ` [${site.accountInfo.accountType}]`;

    // Add known paths if any
    const paths = Object.entries(site.navHints.knownPaths);
    if (paths.length > 0) {
      const pathStr = paths.slice(0, 5).map(([k, v]) => `${k}→${v}`).join(', ');
      line += ` | paths: ${pathStr}`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════
// Internal helpers
// ═══════════════════════════════════

function safeJsonParse<T>(str: string, fallback: T): T {
  try { return JSON.parse(str); } catch { return fallback; }
}

function rowToProfile(row: any): SiteProfile {
  return {
    domain: row.domain,
    displayName: row.display_name,
    authStatus: row.auth_status,
    lastVisited: row.last_visited,
    visitCount: row.visit_count,
    navHints: safeJsonParse(row.nav_hints, { knownPaths: {} }),
    accountInfo: safeJsonParse(row.account_info, {}),
    pageMap: safeJsonParse(row.page_map, {}),
  };
}

function domainToDisplayName(domain: string): string {
  // "github.com" → "GitHub", "mail.google.com" → "Gmail"
  const known: Record<string, string> = {
    'github.com': 'GitHub',
    'mail.google.com': 'Gmail',
    'drive.google.com': 'Google Drive',
    'docs.google.com': 'Google Docs',
    'calendar.google.com': 'Google Calendar',
    'facebook.com': 'Facebook',
    'instagram.com': 'Instagram',
    'twitter.com': 'Twitter/X',
    'x.com': 'X',
    'linkedin.com': 'LinkedIn',
    'reddit.com': 'Reddit',
    'amazon.com': 'Amazon',
    'youtube.com': 'YouTube',
    'netflix.com': 'Netflix',
    'spotify.com': 'Spotify Web',
    'discord.com': 'Discord',
    'slack.com': 'Slack',
    'notion.so': 'Notion',
    'figma.com': 'Figma',
    'vercel.com': 'Vercel',
    'netlify.com': 'Netlify',
    'railway.app': 'Railway',
    'stripe.com': 'Stripe',
    'claude.ai': 'Claude',
    'chat.openai.com': 'ChatGPT',
    'etsy.com': 'Etsy',
    'ebay.com': 'eBay',
  };
  return known[domain] || domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
}

/**
 * Attempt to extract account info from page content.
 * Uses lightweight pattern matching on common account indicators.
 */
function extractAccountInfo(domain: string, content: string): Partial<AccountInfo> | null {
  const snippet = content.slice(0, 3000);
  const info: Partial<AccountInfo> = {};

  // GitHub: look for username in profile references
  if (domain === 'github.com') {
    const match = snippet.match(/github\.com\/([a-zA-Z0-9-]+)(?:\/|\s|")/);
    if (match && match[1] !== 'features' && match[1] !== 'pricing' && match[1] !== 'about') {
      info.username = match[1];
    }
  }

  // Generic: look for "Signed in as", "Logged in as", "@username" patterns
  const signedIn = snippet.match(/(?:signed in as|logged in as|account:\s*)\s*[""']?(@?[a-zA-Z0-9._-]+)/i);
  if (signedIn) info.username = signedIn[1];

  // Look for profile links that might contain the username
  const profileLink = snippet.match(/\/(?:profile|account|settings|user)\/([a-zA-Z0-9._-]+)/);
  if (profileLink && !info.username) info.username = profileLink[1];

  // Look for "Pro", "Premium", "Business", "Free" account indicators
  const tier = snippet.match(/\b(pro|premium|business|enterprise|free|starter|plus|team)\s*(?:plan|account|tier|member)/i);
  if (tier) info.accountType = tier[1].toLowerCase();

  return Object.keys(info).length > 0 ? info : null;
}
