/**
 * Site Harness — Compiled, deterministic form-filling sequences.
 *
 * A harness is a learned, structured definition of how to interact with
 * a specific form on a specific site. It contains:
 *   - The URL pattern for the form
 *   - Exact CSS selectors for each field (with shadow DOM drilling info)
 *   - The field type (native input, contenteditable, shadow-input, etc.)
 *   - The submit button selector
 *   - Success/error verification selectors
 *
 * Harnesses are discovered by the LLM on first encounter and then stored
 * in SQLite. On subsequent encounters, the harness executes deterministically
 * via native browser input primitives — zero LLM calls, zero token cost, 2-5 seconds.
 *
 * This is the browser equivalent of CLI-Anything: instead of wrapping desktop
 * apps in CLI harnesses, we wrap web forms in site harnesses.
 *
 * Execution hierarchy:
 *   1. Check if a harness exists for this domain + form → run it (no LLM)
 *   2. If no harness, LLM explores with browser tools → fills form
 *   3. On success, system generates a harness from the successful sequence
 *   4. Next time, step 1 catches it
 */

import { getDb } from '../db/database';
import { fillFieldWithInputEvents, nativeClickInput, resolveElement } from './native-input';
import type { BrowserView } from 'electron';
import type { FillResult } from './native-input';
import { wait, waitForPotentialNavigation, waitForSelector } from './waits';

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export interface HarnessFieldDef {
  /** Human-readable field name (e.g., "title", "body", "email") */
  name: string;
  /** CSS selector that reaches the field (may target a Web Component wrapper) */
  selector: string;
  /** Field type for input strategy selection */
  fieldType: 'input' | 'textarea' | 'contenteditable' | 'shadow-input' | 'shadow-textarea';
  /** Whether this field is required */
  required: boolean;
}

export interface HarnessSubmitDef {
  /** CSS selector for the submit button */
  selector: string;
  /** Text content of the button for fallback matching */
  text: string;
}

export interface HarnessVerifyDef {
  /** Selector that appears on success (e.g., confirmation message, redirect indicator) */
  successSelector?: string;
  /** Selector that appears on error */
  errorSelector?: string;
  /** URL pattern that indicates success (e.g., /r/blackbox/comments/) */
  successUrlPattern?: string;
}

export interface SiteHarness {
  id?: number;
  /** Domain this harness applies to */
  domain: string;
  /** A name for this harness (e.g., "create-post", "compose-email", "create-issue") */
  actionName: string;
  /** URL pattern (with {param} placeholders) that triggers this harness */
  urlPattern: string;
  /** Ordered list of fields to fill */
  fields: HarnessFieldDef[];
  /** Submit button definition */
  submit: HarnessSubmitDef;
  /** How to verify success/failure */
  verify: HarnessVerifyDef;
  /** Number of times this harness has been used successfully */
  successCount: number;
  /** Number of times this harness has failed */
  failCount: number;
  /** If this harness required human intervention, describes what step and why. */
  interventionHint?: string;
  /** True if this harness was learned from a signup flow (vs. a regular form). */
  isSignupHarness?: boolean;
  /** ISO timestamp of last use */
  lastUsed: string;
  /** ISO timestamp of creation */
  createdAt: string;
}

export interface HarnessExecResult {
  success: boolean;
  message: string;
  /** Per-field results */
  fieldResults: { name: string; success: boolean; message: string }[];
  /** Total elapsed time */
  elapsedMs: number;
}

export interface PreparedHarnessExecution {
  harness: SiteHarness;
  fieldValues: Record<string, string>;
  autoSubmit: boolean;
}

// ═══════════════════════════════════
// Database Operations
// ═══════════════════════════════════

export function ensureHarnessTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_harnesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      action_name TEXT NOT NULL,
      url_pattern TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      submit_json TEXT NOT NULL,
      verify_json TEXT NOT NULL DEFAULT '{}',
      success_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      last_used TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(domain, action_name)
    );
    CREATE INDEX IF NOT EXISTS idx_harness_domain ON site_harnesses(domain);
  `);
}

export function getHarness(domain: string, actionName: string): SiteHarness | null {
  ensureHarnessTable();
  const db = getDb();
  const row = db.prepare('SELECT * FROM site_harnesses WHERE domain = ? AND action_name = ?').get(domain, actionName) as any;
  if (!row) return null;
  return rowToHarness(row);
}

export function getHarnessesForDomain(domain: string): SiteHarness[] {
  ensureHarnessTable();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM site_harnesses WHERE domain = ? ORDER BY success_count DESC').all(domain) as any[];
  return rows.map(rowToHarness);
}

export function findHarnessByUrl(url: string): SiteHarness | null {
  ensureHarnessTable();
  const db = getDb();
  let domain: string;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }

  const harnesses = getHarnessesForDomain(domain);
  // Try to match URL pattern
  for (const h of harnesses) {
    try {
      if (urlPatternToRegExp(h.urlPattern).test(url)) return h;
    } catch { /* invalid pattern, skip */ }
  }
  return null;
}

function urlPatternToRegExp(urlPattern: string): RegExp {
  const placeholderRe = /\{[^}]+\}/g;
  let lastIndex = 0;
  let pattern = '^';

  for (const match of urlPattern.matchAll(placeholderRe)) {
    const start = match.index ?? 0;
    pattern += escapeRegex(urlPattern.slice(lastIndex, start));
    pattern += '[^/?#]+';
    lastIndex = start + match[0].length;
  }

  pattern += escapeRegex(urlPattern.slice(lastIndex));
  pattern += '$';
  return new RegExp(pattern);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function prepareHarnessExecutionFromMessage(
  userMessage: string,
  url: string,
): PreparedHarnessExecution | null {
  const harness = findHarnessByUrl(url);
  if (!harness) return null;

  const fieldValues: Record<string, string> = {};
  for (const field of harness.fields) {
    const value = inferFieldValue(userMessage, field.name);
    if (value) fieldValues[field.name] = value;
  }

  const missingRequired = harness.fields
    .filter((field) => field.required && !fieldValues[field.name])
    .map((field) => field.name);
  if (missingRequired.length > 0) return null;

  const lower = userMessage.toLowerCase();
  const forbidSubmit = /\b(do not submit|don't submit|without submitting|but do not submit)\b/i.test(userMessage);
  const wantsSubmit = /\b(submit|post it|publish|send it|create it now)\b/i.test(lower) && !forbidSubmit;

  return {
    harness,
    fieldValues,
    autoSubmit: wantsSubmit,
  };
}

export function saveHarness(harness: SiteHarness): number {
  ensureHarnessTable();
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO site_harnesses (domain, action_name, url_pattern, fields_json, submit_json, verify_json, success_count, fail_count, last_used, created_at, intervention_hint, is_signup_harness)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain, action_name) DO UPDATE SET
      url_pattern = excluded.url_pattern,
      fields_json = excluded.fields_json,
      submit_json = excluded.submit_json,
      verify_json = excluded.verify_json,
      success_count = excluded.success_count,
      fail_count = excluded.fail_count,
      last_used = excluded.last_used,
      intervention_hint = excluded.intervention_hint,
      is_signup_harness = excluded.is_signup_harness
  `).run(
    harness.domain,
    harness.actionName,
    harness.urlPattern,
    JSON.stringify(harness.fields),
    JSON.stringify(harness.submit),
    JSON.stringify(harness.verify),
    harness.successCount,
    harness.failCount,
    harness.lastUsed || new Date().toISOString(),
    harness.createdAt || new Date().toISOString(),
    harness.interventionHint ?? null,
    harness.isSignupHarness ? 1 : 0,
  );
  return result.lastInsertRowid as number;
}

export function recordHarnessResult(domain: string, actionName: string, success: boolean): void {
  ensureHarnessTable();
  const db = getDb();
  if (success) {
    db.prepare('UPDATE site_harnesses SET success_count = success_count + 1, last_used = datetime("now") WHERE domain = ? AND action_name = ?')
      .run(domain, actionName);
  } else {
    db.prepare('UPDATE site_harnesses SET fail_count = fail_count + 1, last_used = datetime("now") WHERE domain = ? AND action_name = ?')
      .run(domain, actionName);
  }
}

export function listAllHarnesses(): SiteHarness[] {
  ensureHarnessTable();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM site_harnesses ORDER BY success_count DESC').all() as any[];
  return rows.map(rowToHarness);
}

function rowToHarness(row: any): SiteHarness {
  return {
    id: row.id,
    domain: row.domain,
    actionName: row.action_name,
    urlPattern: row.url_pattern,
    fields: JSON.parse(row.fields_json),
    submit: JSON.parse(row.submit_json),
    verify: JSON.parse(row.verify_json || '{}'),
    successCount: row.success_count,
    failCount: row.fail_count,
    interventionHint: row.intervention_hint ?? undefined,
    isSignupHarness: row.is_signup_harness === 1,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}

// ═══════════════════════════════════
// Harness Executor — Deterministic native-input pipeline
// ═══════════════════════════════════

/**
 * Execute a site harness: fill all fields and optionally submit.
 * Uses native browser input — no LLM, no token cost, 2-5 seconds.
 *
 * @param view - The BrowserView to operate on
 * @param harness - The harness definition
 * @param fieldValues - Map of field name → text value
 * @param autoSubmit - Whether to click the submit button after filling
 */
export async function executeHarness(
  view: BrowserView,
  harness: SiteHarness,
  fieldValues: Record<string, string>,
  autoSubmit: boolean = false,
): Promise<HarnessExecResult> {
  const start = Date.now();
  const fieldResults: { name: string; success: boolean; message: string }[] = [];
  let allSuccess = true;

  // Fill each field in order
  for (const field of harness.fields) {
    const value = fieldValues[field.name];
    if (value === undefined || value === null) {
      if (field.required) {
        fieldResults.push({ name: field.name, success: false, message: 'Required field not provided' });
        allSuccess = false;
      } else {
        fieldResults.push({ name: field.name, success: true, message: 'Skipped (optional, no value)' });
      }
      continue;
    }

    const selectorReady = await waitForSelector(view, field.selector, { timeoutMs: 5_000 });
    if (!selectorReady) {
      fieldResults.push({ name: field.name, success: false, message: `Selector did not become available: ${field.selector}` });
      allSuccess = false;
      continue;
    }

    const result = await fillFieldWithInputEvents(view, field.selector, value);
    fieldResults.push({ name: field.name, success: result.success, message: result.message });
    if (!result.success) {
      allSuccess = false;
      // Don't stop on failure — try remaining fields so the user can see what worked
    }

    // Small delay between fields for page reactivity
    await wait(200);
  }

  // Optionally click submit
  if (autoSubmit && allSuccess) {
    const submitInfo = await resolveElement(view, harness.submit.selector);
    if (submitInfo) {
      await nativeClickInput(view, submitInfo.x, submitInfo.y);
      await waitForPotentialNavigation(view, { timeoutMs: 8_000, settleMs: 200 });

      // Verify submission
      if (harness.verify.successUrlPattern) {
        try {
          const currentUrl = view.webContents.getURL();
          if (new RegExp(harness.verify.successUrlPattern).test(currentUrl)) {
            recordHarnessResult(harness.domain, harness.actionName, true);
            return {
              success: true,
              message: `Form submitted successfully (URL matched: ${harness.verify.successUrlPattern})`,
              fieldResults,
              elapsedMs: Date.now() - start,
            };
          }
        } catch { /* regex error, skip */ }
      }

      if (harness.verify.errorSelector) {
        try {
          const errorText = await view.webContents.executeJavaScript(`(function(){
            var el = document.querySelector(${JSON.stringify(harness.verify.errorSelector)});
            return el ? (el.textContent || '').trim().slice(0, 100) : '';
          })()`);
          if (errorText) {
            recordHarnessResult(harness.domain, harness.actionName, false);
            return {
              success: false,
              message: `Form submission error: ${errorText}`,
              fieldResults,
              elapsedMs: Date.now() - start,
            };
          }
        } catch { /* non-fatal */ }
      }
    } else {
      fieldResults.push({ name: '_submit', success: false, message: `Submit button not found: ${harness.submit.selector}` });
      allSuccess = false;
    }
  }

  // Record result
  recordHarnessResult(harness.domain, harness.actionName, allSuccess);

  return {
    success: allSuccess,
    message: allSuccess
      ? `Filled ${fieldResults.filter(f => f.success).length}/${harness.fields.length} fields` + (autoSubmit ? ' and submitted' : '')
      : `Some fields failed: ${fieldResults.filter(f => !f.success).map(f => f.name).join(', ')}`,
    fieldResults,
    elapsedMs: Date.now() - start,
  };
}

// ═══════════════════════════════════
// Harness Context for LLM Prompt
// ═══════════════════════════════════

/**
 * Build a compact prompt block listing available harnesses for a domain.
 * Injected into the dynamic prompt when the user is on a site with known harnesses.
 */
export function getHarnessContextForUrl(url: string): string {
  let domain: string;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch { return ''; }

  const harnesses = getHarnessesForDomain(domain);
  if (harnesses.length === 0) return '';

  const lines: string[] = [`[Site harnesses for ${domain} — use browser_run_harness for zero-cost form filling]`];
  for (const h of harnesses) {
    const fields = h.fields.map(f => f.name).join(', ');
    const reliability = h.successCount + h.failCount > 0
      ? `${Math.round(h.successCount / (h.successCount + h.failCount) * 100)}%`
      : 'new';
    lines.push(`• ${h.actionName} (${reliability} reliable, ${h.successCount} uses): fields=[${fields}] url=${h.urlPattern}`);
  }
  return lines.join('\n');
}

function inferFieldValue(userMessage: string, fieldName: string): string {
  const escaped = escapeRegExp(fieldName).replace(/_/g, '[_\\s-]*');
  const quotedPatterns = [
    new RegExp(`${escaped}\\s*(?:is|=|:|to|with)?\\s*"([^"]+)"`, 'i'),
    new RegExp(`${escaped}\\s*(?:is|=|:|to|with)?\\s*'([^']+)'`, 'i'),
  ];
  for (const pattern of quotedPatterns) {
    const match = userMessage.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  if (/title|subject|headline/i.test(fieldName)) {
    const match = userMessage.match(/\btitled?\s*"([^"]+)"|\btitle\s+"([^"]+)"/i);
    const value = match?.[1] || match?.[2];
    if (value) return value.trim();
  }

  if (/body|description|content|message|comment|text/i.test(fieldName)) {
    const quoted = userMessage.match(/\b(?:body|description|content|message|comment|text)\s*(?:is|=|:|to|with)?\s*"([^"]+)"/i);
    if (quoted?.[1]) return quoted[1].trim();
    const about = userMessage.match(/\babout\s+(.+?)(?=,?\s+(?:but do not submit|do not submit|without submitting|and then|then|$))/i);
    if (about?.[1]) return about[1].trim();
  }

  return '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
