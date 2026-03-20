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
import type { AgentProfile } from '../../shared/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTab, switchTab, closeTab, getTabList, getCurrentUrl, getVisibleText } from '../browser/manager';
import {
  executeBrowserSearch,
  executeBrowserNavigate,
  executeBrowserReadPage,
  executeBrowserClick,
  executeBrowserType,
  executeBrowserExtract,
  executeBrowserScroll,
} from '../agent/executors/browser-executors';

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
  agentProfile: AgentProfile;
  steps: PlaybookStep[];
  successCount: number;
  failCount: number;
  successRate: number;
  validationRuns: number;
  avgRuntimeMs: number;
  avgStepCount: number;
  notes: string[];
  lastUsed: string;
  createdAt: string;
}

export interface PlaybookValidationResult {
  attemptedRuns: number;
  successfulRuns: number;
  successRate: number;
  avgRuntimeMs: number;
  notes: string[];
  metThreshold: boolean;
  skippedReplay: boolean;
  selectedSteps: PlaybookStep[];
}

export interface SavedPlaybookResult {
  domain: string;
  taskPattern: string;
  agentProfile: AgentProfile;
  steps: PlaybookStep[];
  successRate: number;
  validationRuns: number;
  avgRuntimeMs: number;
  notes: string[];
}

export interface ExecuteSavedPlaybookResult {
  playbook: Playbook;
  ok: boolean;
  response: string;
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
  opts?: {
    agentProfile?: AgentProfile;
    validationRuns?: number;
    successRate?: number;
    runtimeMs?: number;
    notes?: string[];
    stepsOverride?: PlaybookStep[];
  },
): SavedPlaybookResult | null {
  const agentProfile = opts?.agentProfile || 'general';
  const minBrowserCalls = agentProfile === 'bloodhound' ? 1 : 2;

  // Only save if there are enough browser tool calls to form a useful executor
  const browserCalls = toolCalls.filter(tc =>
    tc.name.startsWith('browser_') && tc.name !== 'browser_screenshot',
  );
  if (browserCalls.length < minBrowserCalls) return null;

  // Determine the domain from the first navigate call or the primary URL
  let domain = '';
  if (primaryUrl) {
    domain = extractDomain(primaryUrl);
  } else {
    const firstNav = browserCalls.find(tc => tc.name === 'browser_navigate');
    if (firstNav?.input?.url) domain = extractDomain(firstNav.input.url);
  }
  if (!domain) return null;

  const pattern = normalizeTaskPattern(taskDescription);
  if (!pattern) return null;
  const validationRuns = Math.max(1, opts?.validationRuns || 1);
  const successRate = clampRate(opts?.successRate ?? 1);
  const runtimeMs = Math.max(0, Math.round(opts?.runtimeMs || 0));
  const notes = Array.isArray(opts?.notes) ? opts!.notes.slice(0, 12) : [];

  // Optimize the step sequence before saving
  const rawSteps: PlaybookStep[] = opts?.stepsOverride?.length
    ? opts.stepsOverride
    : browserCalls.map(tc => ({
        tool: tc.name,
        input: sanitizeInput(tc.input),
        summary: tc.summary || `${tc.name}(${JSON.stringify(tc.input).slice(0, 60)})`,
      }));
  const steps = agentProfile === 'bloodhound'
    ? compileBloodhoundExecutorSteps(rawSteps)
    : optimizeSteps(rawSteps);
  if (steps.length < minBrowserCalls) return null; // optimization reduced it to trivial

  const db = getDb();

  // Check if a playbook already exists for this domain+pattern
  const existing = db.prepare(
    `SELECT id, steps, success_count, validation_runs, success_rate, avg_runtime_ms, avg_step_count, notes
     FROM browser_playbooks WHERE domain = ? AND task_pattern = ?`,
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
          agent_profile = ?,
          success_rate = ?,
          validation_runs = validation_runs + ?,
          avg_runtime_ms = ?,
          avg_step_count = ?,
          notes = ?,
          last_used = datetime('now'),
          steps = CASE WHEN ? THEN ? ELSE steps END
      WHERE id = ?
    `).run(
      agentProfile,
      mergeAverage(existing.success_rate, existing.validation_runs, successRate, validationRuns),
      validationRuns,
      mergeAverage(existing.avg_runtime_ms, existing.success_count, runtimeMs, 1),
      mergeAverage(existing.avg_step_count, existing.success_count, steps.length, 1),
      JSON.stringify(mergeNotes(safeJsonParse(existing.notes, []), notes)),
      useNewSteps ? 1 : 0,
      JSON.stringify(steps),
      existing.id,
    );

    if (useNewSteps) {
      console.log(`[Playbook] Optimized "${pattern}" on ${domain}: ${oldSteps.length} → ${steps.length} steps (score: ${oldScore} → ${newScore})`);
    } else {
      console.log(`[Playbook] Updated "${pattern}" on ${domain} (success: ${existing.success_count + 1}, kept existing ${oldSteps.length}-step path)`);
    }
  } else {
    db.prepare(`
      INSERT INTO browser_playbooks (
        domain, task_pattern, agent_profile, steps,
        success_rate, validation_runs, avg_runtime_ms, avg_step_count, notes, last_used
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(domain, pattern, agentProfile, JSON.stringify(steps), successRate, validationRuns, runtimeMs, steps.length, JSON.stringify(notes));
    console.log(`[Playbook] Saved new "${pattern}" on ${domain} (${steps.length} steps)`);
  }

  return {
    domain,
    taskPattern: pattern,
    agentProfile,
    steps,
    successRate,
    validationRuns,
    avgRuntimeMs: runtimeMs,
    notes,
  };
}

const BLOODHOUND_DEFAULT_THRESHOLD = 0.85;
const BLOODHOUND_DEFAULT_RUNS = 3;
const BLOODHOUND_INITIAL_CANDIDATES = 10;
const REPLAY_UNSAFE_TASK_RE = /\b(delete|remove|destroy|erase|send|submit|purchase|buy|checkout|order|refund|transfer|pay|publish|post|create|invite|grant|revoke|archive|approve|deny|cancel|book|schedule|email|message|upload)\b/i;

interface CandidateVariant {
  id: string;
  lineage: string;
  steps: PlaybookStep[];
}

interface CandidateScore {
  candidate: CandidateVariant;
  attempts: number;
  successes: number;
  successRate: number;
  avgRuntimeMs: number;
  score: number;
  notes: string[];
}

export async function validatePlaybookCandidate(
  taskDescription: string,
  toolCalls: Array<{ name: string; input: Record<string, any>; summary: string }>,
  opts?: {
    threshold?: number;
    maxRuns?: number;
    expectedUrl?: string;
  },
): Promise<PlaybookValidationResult> {
  const browserCalls = toolCalls.filter(tc =>
    tc.name.startsWith('browser_') && tc.name !== 'browser_screenshot',
  );
  if (browserCalls.length < 2) {
    return {
      attemptedRuns: 0,
      successfulRuns: 0,
      successRate: 0,
      avgRuntimeMs: 0,
      notes: ['Not enough browser steps to validate.'],
      metThreshold: false,
      skippedReplay: true,
      selectedSteps: [],
    };
  }

  const baseSteps = optimizeSteps(browserCalls.map(tc => ({
    tool: tc.name,
    input: sanitizeInput(tc.input),
    summary: tc.summary || tc.name,
  })));

  if (REPLAY_UNSAFE_TASK_RE.test(taskDescription)) {
    return {
      attemptedRuns: 1,
      successfulRuns: 1,
      successRate: 1,
      avgRuntimeMs: 0,
      notes: ['Multi-run validation skipped because the task appears state-changing or non-idempotent.'],
      metThreshold: true,
      skippedReplay: true,
      selectedSteps: baseSteps,
    };
  }

  const threshold = clampRate(opts?.threshold ?? BLOODHOUND_DEFAULT_THRESHOLD);
  const maxRuns = Math.max(1, opts?.maxRuns || BLOODHOUND_DEFAULT_RUNS);
  const expectedDomain = opts?.expectedUrl ? extractDomain(opts.expectedUrl) : '';
  let candidates = buildInitialCandidatePool(baseSteps);
  const allNotes: string[] = [];

  const rounds = [
    { label: 'round 1', runsPerCandidate: 1, keep: 5, expand: true },
    { label: 'round 2', runsPerCandidate: 1, keep: 3, expand: true },
    { label: 'final', runsPerCandidate: maxRuns, keep: 1, expand: false },
  ];

  let finalists: CandidateScore[] = [];
  for (const round of rounds) {
    const results: CandidateScore[] = [];
    for (const candidate of candidates) {
      results.push(await evaluateCandidate(candidate, round.runsPerCandidate, expectedDomain));
    }
    results.sort((a, b) => b.score - a.score);
    finalists = results.slice(0, round.keep);
    allNotes.push(`${round.label}: evaluated ${results.length} candidate(s), kept ${finalists.length}. Leader ${finalists[0]?.candidate.lineage || 'n/a'} at ${(((finalists[0]?.successRate) || 0) * 100).toFixed(0)}% success.`);

    if (round.expand && finalists.length > 0) {
      candidates = expandCandidatePool(finalists.map(f => f.candidate));
    } else {
      candidates = finalists.map(f => f.candidate);
    }
  }

  const winner = finalists[0];
  const successRate = winner?.successRate || 0;
  const avgRuntimeMs = winner?.avgRuntimeMs || 0;
  const selectedSteps = winner?.candidate.steps || baseSteps;
  const notes = mergeNotes(allNotes, winner?.notes || []);

  return {
    attemptedRuns: winner?.attempts || 0,
    successfulRuns: winner?.successes || 0,
    successRate,
    avgRuntimeMs,
    notes,
    metThreshold: successRate >= threshold,
    skippedReplay: false,
    selectedSteps,
  };
}

export function writeBloodhoundExecutorArtifacts(
  taskDescription: string,
  playbook: SavedPlaybookResult,
  opts?: {
    finalUrl?: string;
    successMessage?: string;
  },
): { markdownPath: string; jsonPath: string } {
  const rootDir = path.join(os.homedir(), 'Documents', 'Clawdia', 'Bloodhound', safePathSegment(playbook.domain));
  fs.mkdirSync(rootDir, { recursive: true });

  const baseName = safePathSegment(taskDescription).slice(0, 80) || safePathSegment(playbook.taskPattern) || 'executor';
  const markdownPath = path.join(rootDir, `${baseName}.md`);
  const jsonPath = path.join(rootDir, `${baseName}.json`);

  const markdown = buildBloodhoundExecutorMarkdown(taskDescription, playbook, opts);
  const json = JSON.stringify({
    taskDescription,
    domain: playbook.domain,
    taskPattern: playbook.taskPattern,
    agentProfile: playbook.agentProfile,
    successRate: playbook.successRate,
    validationRuns: playbook.validationRuns,
    avgRuntimeMs: playbook.avgRuntimeMs,
    finalUrl: opts?.finalUrl || '',
    successMessage: opts?.successMessage || '',
    notes: playbook.notes,
    steps: playbook.steps,
    savedAt: new Date().toISOString(),
  }, null, 2);

  fs.writeFileSync(markdownPath, markdown, 'utf-8');
  fs.writeFileSync(jsonPath, json, 'utf-8');
  return { markdownPath, jsonPath };
}

export async function executeSavedBloodhoundPlaybook(
  taskDescription: string,
  url?: string,
): Promise<ExecuteSavedPlaybookResult | null> {
  const playbook = findPlaybook(taskDescription, url);
  if (!playbook || playbook.agentProfile !== 'bloodhound') return null;
  const compiledSteps = compileBloodhoundExecutorSteps(playbook.steps);
  if (JSON.stringify(compiledSteps) !== JSON.stringify(playbook.steps)) {
    const db = getDb();
    db.prepare(`
      UPDATE browser_playbooks
      SET steps = ?, avg_step_count = ?, last_used = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(compiledSteps), compiledSteps.length, playbook.id);
    playbook.steps = compiledSteps;
  }

  const priorActiveTabId = getTabList().find(tab => tab.isActive)?.id;
  const tempTabId = createTab();
  let keepResultTab = false;
  try {
    const replay = await replayStepsInActiveTab(playbook.steps);
    const finalUrl = getCurrentUrl();
    const finalText = (await getVisibleText()).trim();
    const domainOk = !playbook.domain || extractDomain(finalUrl) === playbook.domain;
    const contentOk = finalText.length >= 40;

    if (!replay.ok || !domainOk || !contentOk) {
      recordPlaybookFailure(playbook.domain, playbook.taskPattern);
      return {
        playbook,
        ok: false,
        response: replay.reason || (!domainOk ? `Executor ended on unexpected domain ${extractDomain(finalUrl) || 'unknown'}` : 'Executor completed but page content was too thin to trust'),
      };
    }

    keepResultTab = true;

    return {
      playbook,
      ok: true,
      response: [
        `Used a saved browser executor.`,
        `URL: ${finalUrl}`,
      ].join('\n'),
    };
  } finally {
    if (!keepResultTab && getTabList().some(tab => tab.id === tempTabId)) closeTab(tempTabId);
    if (!keepResultTab && priorActiveTabId && getTabList().some(tab => tab.id === priorActiveTabId)) switchTab(priorActiveTabId);
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

function compileBloodhoundExecutorSteps(steps: PlaybookStep[]): PlaybookStep[] {
  const optimized = optimizeSteps(steps);
  const candidates: PlaybookStep[][] = [
    optimized,
    trimDiscoveryTail(optimized),
    trimObservationTail(optimized),
  ];

  for (let i = 0; i < optimized.length; i++) {
    const step = optimized[i];
    if (step.tool !== 'browser_navigate') continue;
    const prefix = trimObservationTail(optimized.slice(0, i + 1));
    if (prefix.length > 0) candidates.push(prefix);
  }

  const unique = new Map<string, PlaybookStep[]>();
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const id = JSON.stringify(candidate.map(step => [step.tool, step.input]));
    if (!unique.has(id)) unique.set(id, candidate);
  }

  return Array.from(unique.values()).sort((a, b) => {
    const scoreDiff = scoreSteps(a) - scoreSteps(b);
    if (scoreDiff !== 0) return scoreDiff;
    return a.length - b.length;
  })[0] || optimized;
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

    const domainRows = db.prepare(`
      SELECT * FROM browser_playbooks
      WHERE domain = ?
      AND success_count > fail_count
      ORDER BY success_count DESC
      LIMIT 25
    `).all(domain) as any[];
    const fuzzyDomainMatch = pickBestFuzzyPlaybook(domainRows.map(rowToPlaybook), pattern);
    if (fuzzyDomainMatch) return fuzzyDomainMatch;
  }

  // Fallback: search across all domains for this pattern
  const row = db.prepare(`
    SELECT * FROM browser_playbooks
    WHERE task_pattern = ?
    AND success_count > fail_count
    ORDER BY success_count DESC
    LIMIT 1
  `).get(pattern) as any;

  if (row) return rowToPlaybook(row);

  const rows = db.prepare(`
    SELECT * FROM browser_playbooks
    WHERE success_count > fail_count
    ORDER BY success_count DESC
    LIMIT 50
  `).all() as any[];
  return pickBestFuzzyPlaybook(rows.map(rowToPlaybook), pattern);
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
    playbook.agentProfile === 'bloodhound'
      ? `[BLOODHOUND EXECUTOR — validated browser workflow for "${playbook.taskPattern}" on ${playbook.domain}]`
      : `[PLAYBOOK — learned navigation for "${playbook.taskPattern}" on ${playbook.domain}]`,
    playbook.agentProfile === 'bloodhound'
      ? `Validation: ${(playbook.successRate * 100).toFixed(0)}% success across ${playbook.validationRuns} run(s); avg ${playbook.avgStepCount.toFixed(1)} steps, avg ${Math.round(playbook.avgRuntimeMs / 1000)}s runtime.`
      : `This sequence has worked ${playbook.successCount} time(s). Suggested steps:`,
  ];

  for (let i = 0; i < playbook.steps.length; i++) {
    const step = playbook.steps[i];
    lines.push(`  ${i + 1}. ${step.tool}(${JSON.stringify(step.input)})  // ${step.summary}`);
  }

  if (playbook.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const note of playbook.notes.slice(0, 5)) lines.push(`- ${note}`);
  }

  lines.push('');
  lines.push('Rules:');
  lines.push('- If you know a more direct path (e.g. a direct URL instead of search→click), use it. The system will learn the faster route.');
  lines.push('- If any step fails or the page looks different than expected, abandon the playbook and navigate manually.');
  lines.push('- Do NOT blindly replay steps that don\'t make sense for the current page state.');
  if (playbook.agentProfile === 'bloodhound') {
    lines.push('- Bloodhound should improve this executor if it discovers a shorter or more reliable real working path.');
  }

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
export function normalizeTaskPattern(task: string): string {
  const lower = task
    .toLowerCase()
    .trim()
    .replace(/^\/[a-z0-9_-]+\s+/i, '')
    .replace(/\bbloodhound\b/g, ' ');

  // Remove dates, long numbers, quoted strings
  const cleaned = lower
    .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, '')
    .replace(/\b\d{5,}\b/g, '')
    .replace(/"[^"]+"/g, '')
    .replace(/'[^']+'/g, '')
    .replace(/\bpull requests?\b/g, 'pull_requests')
    .replace(/\bprs?\b/g, 'pull_requests')
    .replace(/\breview requests?\b/g, 'review_requests')
    .replace(/\breview requested\b/g, 'review_requests')
    .replace(/\bneed(?:s)? review\b/g, 'review_requests')
    .replace(/\bneeding review\b/g, 'review_requests')
    .replace(/\bgithub\.com\b/g, 'github')
    .replace(/[?.,!:/()]+/g, ' ');

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
    'learn', 'save', 'saved', 'executor', 'fastest', 'reliable', 'fresh', 'tab',
    'there', 'way', 'using', 'build', 'design', 'create', 'open', 'navigate',
    'direct', 'best', 'from',
  ]);

  const words = cleaned.match(/\b[a-z][a-z0-9-]*\b/g) || [];
  const keywords = words
    .map(canonicalizePatternToken)
    .filter(Boolean)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i); // deduplicate

  const enrichedKeywords = enrichPatternKeywords(keywords);

  // Sort for order-independent matching
  enrichedKeywords.sort();

  return enrichedKeywords.join(' ').slice(0, 100) || lower.slice(0, 100);
}

function canonicalizePatternToken(word: string): string {
  if (!word) return '';
  if (word === 'pull_requests' || word === 'review_requests' || word === 'github') return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ses') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function enrichPatternKeywords(words: string[]): string[] {
  const set = new Set(words);

  const hasGithub = set.has('github');
  const hasPull = set.has('pull') || set.has('pull_request') || set.has('pull_requests');
  const hasRequest = set.has('request') || set.has('requests') || set.has('review_request') || set.has('review_requests');
  const hasReview = set.has('review') || set.has('review_request') || set.has('review_requests');

  if (hasPull && hasRequest) {
    set.add('pull_requests');
    set.delete('pull');
    set.delete('request');
    set.delete('requests');
  }

  if (hasReview && (hasRequest || set.has('need') || set.has('needs'))) {
    set.add('review_requests');
    set.delete('review');
    set.delete('need');
    set.delete('needs');
  }

  if (hasGithub) {
    if (set.has('notification') || set.has('notifications')) set.add('github_notifications');
    if (set.has('pull_requests')) set.add('github_pull_requests');
    if (set.has('review_requests')) set.add('github_review_requests');
  }

  return Array.from(set);
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

async function replayStepsInActiveTab(steps: PlaybookStep[]): Promise<{ ok: boolean; reason?: string }> {
  for (const step of steps) {
    const result = await executeReplayStep(step);
    if (isReplayFailure(result)) {
      return { ok: false, reason: `${step.tool} failed: ${result.slice(0, 200)}` };
    }
  }
  return { ok: true };
}

async function evaluateCandidate(candidate: CandidateVariant, runs: number, expectedDomain: string): Promise<CandidateScore> {
  const priorActiveTabId = getTabList().find(tab => tab.isActive)?.id;
  const notes: string[] = [];
  let successes = 0;
  let totalRuntimeMs = 0;

  for (let run = 0; run < runs; run++) {
    const startedAt = Date.now();
    const tempTabId = createTab();
    try {
      const replay = await replayStepsInActiveTab(candidate.steps);
      const finalUrl = getCurrentUrl();
      const finalText = (await getVisibleText()).trim();
      const domainOk = !expectedDomain || extractDomain(finalUrl) === expectedDomain;
      const contentOk = finalText.length >= 40;

      if (replay.ok && domainOk && contentOk) {
        successes += 1;
      } else {
        notes.push(`${candidate.lineage} replay ${run + 1} failed: ${replay.reason || (!domainOk ? `unexpected domain ${extractDomain(finalUrl) || 'unknown'}` : 'page content too thin')}`);
      }
    } catch (err: any) {
      notes.push(`${candidate.lineage} replay ${run + 1} failed: ${err.message || 'unknown replay error'}`);
    } finally {
      totalRuntimeMs += Date.now() - startedAt;
      if (getTabList().some(tab => tab.id === tempTabId)) closeTab(tempTabId);
      if (priorActiveTabId && getTabList().some(tab => tab.id === priorActiveTabId)) switchTab(priorActiveTabId);
    }
  }

  const successRate = runs > 0 ? successes / runs : 0;
  const avgRuntimeMs = runs > 0 ? Math.round(totalRuntimeMs / runs) : 0;
  return {
    candidate,
    attempts: runs,
    successes,
    successRate,
    avgRuntimeMs,
    score: scoreCandidate(candidate.steps, successRate, avgRuntimeMs),
    notes,
  };
}

function buildInitialCandidatePool(baseSteps: PlaybookStep[]): CandidateVariant[] {
  const variants: CandidateVariant[] = [];
  const compiled = compileBloodhoundExecutorSteps(baseSteps);
  const queue: Array<{ label: string; steps: PlaybookStep[] }> = [
    { label: 'compiled', steps: compiled },
    { label: 'base', steps: baseSteps },
    { label: 'drop-read', steps: dropTools(baseSteps, new Set(['browser_read_page'])) },
    { label: 'drop-extract', steps: dropTools(baseSteps, new Set(['browser_extract'])) },
    { label: 'drop-read-extract', steps: dropTools(baseSteps, new Set(['browser_read_page', 'browser_extract'])) },
    { label: 'direct-entry', steps: preferDirectNavigation(baseSteps) },
    { label: 'tight-discovery', steps: trimDiscoveryTail(baseSteps) },
    { label: 'trim-observation-tail', steps: trimObservationTail(baseSteps) },
    { label: 'no-scroll', steps: dropTools(baseSteps, new Set(['browser_scroll'])) },
    { label: 'direct-no-read', steps: dropTools(preferDirectNavigation(baseSteps), new Set(['browser_read_page'])) },
    { label: 'direct-no-extract', steps: dropTools(preferDirectNavigation(baseSteps), new Set(['browser_extract'])) },
    { label: 'compact', steps: trimObservationTail(trimDiscoveryTail(dropTools(baseSteps, new Set(['browser_read_page', 'browser_extract'])))) },
  ];

  for (const item of queue) {
    pushCandidate(variants, item.label, item.steps);
    if (variants.length >= BLOODHOUND_INITIAL_CANDIDATES) break;
  }

  return variants;
}

function expandCandidatePool(survivors: CandidateVariant[]): CandidateVariant[] {
  const expanded: CandidateVariant[] = [];
  for (const survivor of survivors) {
    pushCandidate(expanded, survivor.lineage, survivor.steps);
    pushCandidate(expanded, `${survivor.lineage}>drop-read`, dropTools(survivor.steps, new Set(['browser_read_page'])));
    pushCandidate(expanded, `${survivor.lineage}>drop-extract`, dropTools(survivor.steps, new Set(['browser_extract'])));
    pushCandidate(expanded, `${survivor.lineage}>direct`, preferDirectNavigation(survivor.steps));
    pushCandidate(expanded, `${survivor.lineage}>compact`, trimDiscoveryTail(survivor.steps));
    pushCandidate(expanded, `${survivor.lineage}>trim-tail`, trimObservationTail(survivor.steps));
    for (const prefix of generateNavigatePrefixes(survivor.steps)) {
      pushCandidate(expanded, `${survivor.lineage}>prefix`, prefix);
    }
  }
  return expanded;
}

function pushCandidate(pool: CandidateVariant[], lineage: string, steps: PlaybookStep[]): void {
  const optimized = compileBloodhoundExecutorSteps(steps);
  if (optimized.length < 1) return;
  const id = JSON.stringify(optimized.map(step => [step.tool, step.input]));
  if (pool.some(candidate => candidate.id === id)) return;
  pool.push({ id, lineage, steps: optimized });
}

function dropTools(steps: PlaybookStep[], tools: Set<string>): PlaybookStep[] {
  return steps.filter(step => !tools.has(step.tool));
}

function preferDirectNavigation(steps: PlaybookStep[]): PlaybookStep[] {
  const result = [...steps];
  while (result[0]?.tool === 'browser_search') result.shift();
  return result;
}

function trimDiscoveryTail(steps: PlaybookStep[]): PlaybookStep[] {
  const trimmed = [...steps];
  while (trimmed.length > 2 && ['browser_read_page', 'browser_extract'].includes(trimmed[trimmed.length - 1]?.tool)) {
    trimmed.pop();
  }
  return trimmed;
}

function trimObservationTail(steps: PlaybookStep[]): PlaybookStep[] {
  const trimmed = [...steps];
  while (trimmed.length > 1 && ['browser_read_page', 'browser_extract', 'browser_scroll'].includes(trimmed[trimmed.length - 1]?.tool)) {
    trimmed.pop();
  }
  return trimmed;
}

function generateNavigatePrefixes(steps: PlaybookStep[]): PlaybookStep[][] {
  const prefixes: PlaybookStep[][] = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.tool !== 'browser_navigate') continue;
    const prefix = trimObservationTail(steps.slice(0, i + 1));
    if (prefix.length > 0) prefixes.push(prefix);
  }
  return prefixes;
}

function scoreCandidate(steps: PlaybookStep[], successRate: number, avgRuntimeMs: number): number {
  return successRate * 1000 - scoreSteps(steps) * 12 - avgRuntimeMs / 250;
}

async function executeReplayStep(step: PlaybookStep): Promise<string> {
  switch (step.tool) {
    case 'browser_search': return executeBrowserSearch(step.input);
    case 'browser_navigate': return executeBrowserNavigate(step.input);
    case 'browser_read_page': return executeBrowserReadPage(step.input);
    case 'browser_click': return executeBrowserClick(step.input);
    case 'browser_type': return executeBrowserType(step.input);
    case 'browser_extract': return executeBrowserExtract(step.input);
    case 'browser_scroll': return executeBrowserScroll(step.input);
    default: return `[Error: unsupported replay tool] ${step.tool}`;
  }
}

function isReplayFailure(result: string): boolean {
  const lower = result.toLowerCase();
  return lower.startsWith('[error') || lower.startsWith('error:') || lower.includes('[login required]');
}

function safeJsonParse<T>(str: string, fallback: T): T {
  try { return JSON.parse(str); } catch { return fallback; }
}

function rowToPlaybook(row: any): Playbook {
  return {
    id: row.id,
    domain: row.domain,
    taskPattern: row.task_pattern,
    agentProfile: row.agent_profile === 'bloodhound' ? 'bloodhound' : row.agent_profile === 'filesystem' ? 'filesystem' : 'general',
    steps: safeJsonParse(row.steps, []),
    successCount: row.success_count,
    failCount: row.fail_count,
    successRate: typeof row.success_rate === 'number' ? row.success_rate : 1,
    validationRuns: typeof row.validation_runs === 'number' ? row.validation_runs : row.success_count,
    avgRuntimeMs: typeof row.avg_runtime_ms === 'number' ? row.avg_runtime_ms : 0,
    avgStepCount: typeof row.avg_step_count === 'number' && row.avg_step_count > 0 ? row.avg_step_count : safeJsonParse(row.steps, []).length,
    notes: safeJsonParse(row.notes, []),
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function mergeAverage(existingValue: number, existingWeight: number, nextValue: number, nextWeight: number): number {
  const leftWeight = Math.max(0, existingWeight || 0);
  const rightWeight = Math.max(0, nextWeight || 0);
  if (leftWeight + rightWeight === 0) return 0;
  return ((existingValue || 0) * leftWeight + (nextValue || 0) * rightWeight) / (leftWeight + rightWeight);
}

function mergeNotes(existing: string[], incoming: string[]): string[] {
  return [...new Set([...(existing || []), ...(incoming || [])])].slice(0, 12);
}

function summarizeExecutorResult(text: string): string {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => isUsefulSummaryLine(line));

  const prioritized = lines
    .map(line => ({ line, score: scoreSummaryLine(line) }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.line);

  const unique: string[] = [];
  for (const line of prioritized) {
    if (unique.includes(line)) continue;
    unique.push(line);
    if (unique.length >= 6) break;
  }

  if (unique.length === 0) return 'Reached the target page, but no concise summary was extracted.';
  return `Page summary:\n- ${unique.join('\n- ')}`;
}

function isUsefulSummaryLine(line: string): boolean {
  if (line.length < 3) return false;
  if (/^skip to content$/i.test(line)) return false;
  if (/^footer$/i.test(line)) return false;
  if (/^terms$|^privacy$|^security$|^status$|^community$|^docs$|^contact$/i.test(line)) return false;
  if (/^search\b/i.test(line)) return false;
  if (/^clear$/i.test(line)) return false;
  if (/^give feedback$/i.test(line)) return false;
  if (/^provide feedback$/i.test(line)) return false;
  if (/^cancel$|^submit feedback$/i.test(line)) return false;
  if (/^0 suggestions\.?$/i.test(line)) return false;
  if (/gGthen|dDPull|forward slash\/|homepage|open menuhomepage/i.test(line)) return false;
  if (/we read every piece of feedback|include my email address/i.test(line)) return false;
  if (/^[a-z]?[A-Z][a-zA-Z]+\(.*\)[a-zA-Z]+/i.test(line)) return false;
  return true;
}

function scoreSummaryLine(line: string): number {
  let score = 0;
  if (/review requests/i.test(line)) score += 10;
  if (/open|closed/i.test(line)) score += 4;
  if (/no results matched your search/i.test(line)) score += 8;
  if (/uh oh|error while loading|you can.t perform that action/i.test(line)) score += 9;
  if (/private repositories only|public repositories only|organization|sort by/i.test(line)) score += 3;
  if (/\b\d+\s+open\b|\b\d+\s+closed\b/i.test(line)) score += 6;
  if (line.length > 140) score -= 4;
  if (/[a-z][A-Z][a-z]/.test(line)) score -= 3;
  return score;
}

function pickBestFuzzyPlaybook(playbooks: Playbook[], queryPattern: string): Playbook | null {
  let best: { playbook: Playbook; score: number } | null = null;
  const normalizedQuery = normalizeTaskPattern(queryPattern);
  for (const playbook of playbooks) {
    const normalizedStoredPattern = normalizeTaskPattern(playbook.taskPattern);
    const executorPattern = buildExecutorIntentPattern(playbook);
    const score = Math.max(
      scorePatternSimilarity(normalizedQuery, normalizedStoredPattern),
      scorePatternSimilarity(normalizedQuery, executorPattern),
    );
    if (score < 0.45) continue;
    if (!best || score > best.score || (score === best.score && playbook.successCount > best.playbook.successCount)) {
      best = { playbook, score };
    }
  }
  return best?.playbook || null;
}

function scorePatternSimilarity(a: string, b: string): number {
  const aWords = new Set(a.split(/\s+/).filter(Boolean));
  const bWords = new Set(b.split(/\s+/).filter(Boolean));
  if (aWords.size === 0 || bWords.size === 0) return 0;

  let overlap = 0;
  for (const word of aWords) {
    if (bWords.has(word)) overlap += 1;
  }

  const union = new Set([...aWords, ...bWords]).size;
  const jaccard = union > 0 ? overlap / union : 0;
  const containment = Math.max(overlap / aWords.size, overlap / bWords.size);
  return jaccard * 0.6 + containment * 0.4;
}

function buildExecutorIntentPattern(playbook: Playbook): string {
  const tokens = new Set<string>(normalizeTaskPattern(playbook.taskPattern).split(/\s+/).filter(Boolean));
  tokens.add(normalizeTaskPattern(playbook.domain));

  for (const step of playbook.steps) {
    if (step.tool !== 'browser_navigate') continue;
    const url = String(step.input?.url || '').toLowerCase();
    if (!url) continue;
    if (url.includes('github.com')) tokens.add('github');
    if (url.includes('/pulls')) {
      tokens.add('pull_requests');
      tokens.add('github_pull_requests');
    }
    if (url.includes('review-requested')) {
      tokens.add('review_requests');
      tokens.add('github_review_requests');
    }
    if (url.includes('/notifications')) {
      tokens.add('notification');
      tokens.add('github_notifications');
    }
    if (url.includes('/issues')) tokens.add('issue');
  }

  return Array.from(tokens).sort().join(' ');
}

function safePathSegment(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildBloodhoundExecutorMarkdown(
  taskDescription: string,
  playbook: SavedPlaybookResult,
  opts?: {
    finalUrl?: string;
    successMessage?: string;
  },
): string {
  const lines: string[] = [
    `# Bloodhound Executor`,
    '',
    `Task: ${taskDescription}`,
    `Domain: ${playbook.domain}`,
    `Pattern: ${playbook.taskPattern}`,
    `Validation: ${(playbook.successRate * 100).toFixed(0)}% across ${playbook.validationRuns} run(s)`,
    `Average Runtime: ${Math.round(playbook.avgRuntimeMs / 1000)}s`,
  ];

  if (opts?.finalUrl) lines.push(`Final URL: ${opts.finalUrl}`);
  if (opts?.successMessage) {
    lines.push('', '## Outcome', '', opts.successMessage);
  }

  lines.push('', '## Steps', '');
  for (let i = 0; i < playbook.steps.length; i++) {
    const step = playbook.steps[i];
    lines.push(`${i + 1}. \`${step.tool}\` ${JSON.stringify(step.input)}  `);
    lines.push(`   ${step.summary}`);
  }

  if (playbook.notes.length > 0) {
    lines.push('', '## Notes', '');
    for (const note of playbook.notes) lines.push(`- ${note}`);
  }

  lines.push('', `Saved: ${new Date().toISOString()}`);
  return lines.join('\n');
}
