/**
 * Browser Playbooks — Learned navigation patterns.
 *
 * When the LLM successfully completes a multi-step browser task, the
 * sequence of tool calls is saved as a playbook. Next time a similar
 * task is requested, the playbook is injected into the prompt so the
 * LLM can replay the known-working sequence instead of rediscovering
 * the navigation path from scratch.
 *
 * This is the browser equivalent of CLI-Anything — learned interaction
 * patterns that get faster with repeated use.
 *
 * Lifecycle:
 *   1. User asks "check my GitHub notifications"
 *   2. LLM navigates: search → click → scroll → extract
 *   3. Task succeeds → savePlaybook() records the step sequence
 *   4. Next time user asks similar → findPlaybook() returns the steps
 *   5. LLM gets the playbook injected and replays it directly
 *   6. success_count increments; high-success playbooks rank higher
 */

import { getDb } from './database';
import { extractDomain } from './site-profiles';

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export interface PlaybookStep {
  tool: string;          // "browser_navigate", "browser_click", etc.
  input: Record<string, any>;  // the input that was passed to the tool
  summary: string;       // human-readable summary ("Navigated to /notifications")
}

export interface Playbook {
  id: number;
  domain: string;
  taskPattern: string;   // normalized task description
  steps: PlaybookStep[];
  successCount: number;
  failCount: number;
  lastUsed: string;
  createdAt: string;
}

// ═══════════════════════════════════
// Recording — Called after successful browser tasks
// ═══════════════════════════════════

/**
 * Save a playbook from a successful browser task.
 *
 * Called by the agent loop when a browser-heavy task completes successfully.
 * Extracts only the browser tool calls from the full tool call sequence.
 */
export function savePlaybook(
  taskDescription: string,
  toolCalls: Array<{ name: string; input: Record<string, any>; summary: string }>,
  primaryUrl?: string,
): void {
  // Only save if there are 2+ browser tool calls (single calls aren't worth replaying)
  const browserCalls = toolCalls.filter(tc =>
    tc.name.startsWith('browser_') && tc.name !== 'browser_screenshot',
  );
  if (browserCalls.length < 2) return;

  // Determine the domain from the first navigate call or the primary URL
  let domain = '';
  if (primaryUrl) {
    domain = extractDomain(primaryUrl);
  } else {
    const firstNav = browserCalls.find(tc => tc.name === 'browser_navigate');
    if (firstNav?.input?.url) domain = extractDomain(firstNav.input.url);
  }
  if (!domain) return;

  const pattern = normalizeTaskPattern(taskDescription);
  if (!pattern) return;

  // Optimize the step sequence before saving
  const rawSteps: PlaybookStep[] = browserCalls.map(tc => ({
    tool: tc.name,
    input: sanitizeInput(tc.input),
    summary: tc.summary || `${tc.name}(${JSON.stringify(tc.input).slice(0, 60)})`,
  }));
  const steps = optimizeSteps(rawSteps);
  if (steps.length < 2) return; // optimization reduced it to trivial

  const db = getDb();

  // Check if a playbook already exists for this domain+pattern
  const existing = db.prepare(
    'SELECT id, steps, success_count FROM browser_playbooks WHERE domain = ? AND task_pattern = ?',
  ).get(domain, pattern) as any;

  if (existing) {
    const oldSteps: PlaybookStep[] = safeJsonParse(existing.steps, []);
    // Score both sequences — lower is better
    const oldScore = scoreSteps(oldSteps);
    const newScore = scoreSteps(steps);
    const useNewSteps = newScore < oldScore;

    db.prepare(`
      UPDATE browser_playbooks
      SET success_count = success_count + 1,
          last_used = datetime('now'),
          steps = CASE WHEN ? THEN ? ELSE steps END
      WHERE id = ?
    `).run(useNewSteps ? 1 : 0, JSON.stringify(steps), existing.id);

    if (useNewSteps) {
      console.log(`[Playbook] Optimized "${pattern}" on ${domain}: ${oldSteps.length} → ${steps.length} steps (score: ${oldScore} → ${newScore})`);
    } else {
      console.log(`[Playbook] Updated "${pattern}" on ${domain} (success: ${existing.success_count + 1}, kept existing ${oldSteps.length}-step path)`);
    }
  } else {
    db.prepare(`
      INSERT INTO browser_playbooks (domain, task_pattern, steps, last_used)
      VALUES (?, ?, ?, datetime('now'))
    `).run(domain, pattern, JSON.stringify(steps));
    console.log(`[Playbook] Saved new "${pattern}" on ${domain} (${steps.length} steps)`);
  }
}

/**
 * Optimize a step sequence by removing redundant steps.
 *
 * Removes:
 *   - browser_read_page immediately after browser_navigate (navigate returns content)
 *   - Consecutive duplicate scrolls in the same direction
 *   - browser_search followed by browser_navigate to a search result (collapse to direct navigate)
 */
function optimizeSteps(steps: PlaybookStep[]): PlaybookStep[] {
  const optimized: PlaybookStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const prev = optimized[optimized.length - 1];

    // Skip browser_read_page right after browser_navigate — navigate already returns content
    if (step.tool === 'browser_read_page' && prev?.tool === 'browser_navigate') {
      continue;
    }

    // Skip duplicate consecutive scrolls in the same direction
    if (step.tool === 'browser_scroll' && prev?.tool === 'browser_scroll'
        && step.input?.direction === prev.input?.direction) {
      // Keep the later one (it scrolled further)
      optimized[optimized.length - 1] = step;
      continue;
    }

    // Collapse: browser_search + browser_navigate(result URL) → just browser_navigate
    if (step.tool === 'browser_navigate' && prev?.tool === 'browser_search') {
      // The navigate URL likely came from the search results — keep only the navigate
      // since on replay we can go directly to the URL
      optimized[optimized.length - 1] = step;
      continue;
    }

    // Skip browser_extract if it was immediately followed by the same data in a navigate/read
    // (extract currently just returns getVisibleText anyway)
    if (step.tool === 'browser_extract' && prev?.tool === 'browser_navigate') {
      continue;
    }

    optimized.push(step);
  }

  return optimized;
}

/**
 * Score a step sequence — lower score means more efficient.
 * Used to decide whether a new path should replace an existing one.
 *
 * Weights:
 *   - browser_navigate: 2 (expected, necessary)
 *   - browser_click: 2 (necessary interaction)
 *   - browser_type: 2 (necessary interaction)
 *   - browser_scroll: 3 (somewhat wasteful, often avoidable)
 *   - browser_read_page: 4 (usually redundant after navigate)
 *   - browser_search: 3 (avoidable if you know the URL)
 *   - browser_extract: 3 (currently just getVisibleText)
 */
function scoreSteps(steps: PlaybookStep[]): number {
  const weights: Record<string, number> = {
    browser_navigate: 2,
    browser_click: 2,
    browser_type: 2,
    browser_scroll: 3,
    browser_read_page: 4,
    browser_search: 3,
    browser_extract: 3,
  };
  return steps.reduce((sum, s) => sum + (weights[s.tool] || 3), 0);
}

/**
 * Record a playbook failure — the LLM tried to replay but it didn't work.
 * Increments fail_count. If fail_count exceeds success_count, the playbook
 * is deleted (it's stale and the site has probably changed).
 */
export function recordPlaybookFailure(domain: string, taskPattern: string): void {
  const pattern = normalizeTaskPattern(taskPattern);
  const db = getDb();

  const row = db.prepare(
    'SELECT id, success_count, fail_count FROM browser_playbooks WHERE domain = ? AND task_pattern = ?',
  ).get(domain, pattern) as any;

  if (!row) return;

  const newFailCount = row.fail_count + 1;
  if (newFailCount > row.success_count) {
    // Too many failures — playbook is stale, delete it
    db.prepare('DELETE FROM browser_playbooks WHERE id = ?').run(row.id);
    console.log(`[Playbook] Deleted stale "${pattern}" on ${domain} (${newFailCount} fails > ${row.success_count} successes)`);
  } else {
    db.prepare('UPDATE browser_playbooks SET fail_count = ? WHERE id = ?').run(newFailCount, row.id);
    console.log(`[Playbook] Recorded failure for "${pattern}" on ${domain} (${newFailCount}/${row.success_count})`);
  }
}

// ═══════════════════════════════════
// Lookup — Called before browser tasks to find matching playbooks
// ═══════════════════════════════════

/**
 * Find a playbook that matches the user's request.
 * Returns the best matching playbook for the given task + domain, or null.
 */
export function findPlaybook(taskDescription: string, url?: string): Playbook | null {
  const pattern = normalizeTaskPattern(taskDescription);
  if (!pattern) return null;

  const db = getDb();

  // If we have a URL, search that domain first
  if (url) {
    const domain = extractDomain(url);
    const row = db.prepare(`
      SELECT * FROM browser_playbooks
      WHERE domain = ? AND task_pattern = ?
      AND success_count > fail_count
      ORDER BY success_count DESC
      LIMIT 1
    `).get(domain, pattern) as any;
    if (row) return rowToPlaybook(row);
  }

  // Fallback: search across all domains for this pattern
  const row = db.prepare(`
    SELECT * FROM browser_playbooks
    WHERE task_pattern = ?
    AND success_count > fail_count
    ORDER BY success_count DESC
    LIMIT 1
  `).get(pattern) as any;

  return row ? rowToPlaybook(row) : null;
}

/**
 * Find all playbooks for a given domain.
 * Useful for showing the LLM what it already knows about a site.
 */
export function getPlaybooksForDomain(domain: string): Playbook[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM browser_playbooks
    WHERE domain = ?
    AND success_count > fail_count
    ORDER BY success_count DESC
    LIMIT 10
  `).all(domain) as any[];
  return rows.map(rowToPlaybook);
}

// ═══════════════════════════════════
// Prompt Injection — Inject playbook into LLM context
// ═══════════════════════════════════

/**
 * Build a prompt block for a matched playbook.
 * Returns empty string if no playbook matches.
 */
export function getPlaybookPrompt(taskDescription: string, url?: string): string {
  const playbook = findPlaybook(taskDescription, url);
  if (!playbook) return '';

  const lines: string[] = [
    `[PLAYBOOK — learned navigation for "${playbook.taskPattern}" on ${playbook.domain}]`,
    `This sequence has worked ${playbook.successCount} time(s). Suggested steps:`,
  ];

  for (let i = 0; i < playbook.steps.length; i++) {
    const step = playbook.steps[i];
    lines.push(`  ${i + 1}. ${step.tool}(${JSON.stringify(step.input)})  // ${step.summary}`);
  }

  lines.push('');
  lines.push('Rules:');
  lines.push('- If you know a more direct path (e.g. a direct URL instead of search→click), use it. The system will learn the faster route.');
  lines.push('- If any step fails or the page looks different than expected, abandon the playbook and navigate manually.');
  lines.push('- Do NOT blindly replay steps that don\'t make sense for the current page state.');

  return lines.join('\n');
}

/**
 * Build a summary of known playbooks for a domain.
 * Injected when the LLM is about to navigate to a known site.
 */
export function getDomainPlaybookSummary(domain: string): string {
  const playbooks = getPlaybooksForDomain(domain);
  if (playbooks.length === 0) return '';

  const lines: string[] = [`[Known tasks for ${domain}]`];
  for (const pb of playbooks) {
    lines.push(`• "${pb.taskPattern}" — ${pb.steps.length} steps, ${pb.successCount} successes`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════
// Management — Reset / delete playbooks
// ═══════════════════════════════════

/** Delete a specific playbook by domain + pattern. Returns true if deleted. */
export function deletePlaybook(domain: string, taskPattern: string): boolean {
  const pattern = normalizeTaskPattern(taskPattern);
  const db = getDb();
  const result = db.prepare('DELETE FROM browser_playbooks WHERE domain = ? AND task_pattern = ?').run(domain, pattern);
  if (result.changes > 0) {
    console.log(`[Playbook] Deleted "${pattern}" on ${domain}`);
    return true;
  }
  return false;
}

/** Delete ALL playbooks for a domain. Returns count deleted. */
export function deletePlaybooksForDomain(domain: string): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM browser_playbooks WHERE domain = ?').run(domain);
  if (result.changes > 0) console.log(`[Playbook] Deleted ${result.changes} playbook(s) for ${domain}`);
  return result.changes;
}

/** Delete ALL playbooks. Returns count deleted. */
export function clearAllPlaybooks(): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM browser_playbooks').run();
  if (result.changes > 0) console.log(`[Playbook] Cleared all ${result.changes} playbook(s)`);
  return result.changes;
}

/** List all playbooks (for diagnostics). */
export function listAllPlaybooks(): Playbook[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM browser_playbooks ORDER BY domain, success_count DESC').all() as any[];
  return rows.map(rowToPlaybook);
}

// ═══════════════════════════════════
// Helpers
// ═══════════════════════════════════

/**
 * Normalize a task description into a reusable pattern.
 * Extracts the meaningful keywords and sorts them for order-independent matching.
 *
 * "check my GitHub notifications" → "github notifications"
 * "what notifications do I have on GitHub" → "github notifications"
 * "show me my GitHub notifications please" → "github notifications"
 */
function normalizeTaskPattern(task: string): string {
  const lower = task.toLowerCase().trim();

  // Remove dates, long numbers, quoted strings
  const cleaned = lower
    .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, '')
    .replace(/\b\d{5,}\b/g, '')
    .replace(/"[^"]+"/g, '')
    .replace(/'[^']+'/g, '');

  // Extract words, remove stop words
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'shall', 'can', 'may', 'might', 'must',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'they', 'them',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'how', 'when', 'where',
    'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'about', 'up',
    'and', 'or', 'but', 'not', 'if', 'so', 'as', 'than',
    'please', 'can', 'could', 'want', 'need', 'go', 'get', 'show', 'look',
    'check', 'see', 'find', 'tell', 'give', 'take', 'make', 'let', 'help',
    'just', 'also', 'too', 'very', 'really', 'some', 'any', 'all', 'every',
  ]);

  const words = cleaned.match(/\b[a-z][a-z0-9-]*\b/g) || [];
  const keywords = words
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i); // deduplicate

  // Sort for order-independent matching
  keywords.sort();

  return keywords.join(' ').slice(0, 100) || lower.slice(0, 100);
}

/** Sanitize tool inputs for storage — remove very long content, keep structure. */
function sanitizeInput(input: Record<string, any>): Record<string, any> {
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > 200) {
      clean[key] = value.slice(0, 200) + '...';
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function safeJsonParse<T>(str: string, fallback: T): T {
  try { return JSON.parse(str); } catch { return fallback; }
}

function rowToPlaybook(row: any): Playbook {
  return {
    id: row.id,
    domain: row.domain,
    taskPattern: row.task_pattern,
    steps: safeJsonParse(row.steps, []),
    successCount: row.success_count,
    failCount: row.fail_count,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}
