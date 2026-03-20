/**
 * Executor Auto-Graduation — Self-training pipeline for Bloodhound.
 *
 * Watches the playbook table for general playbooks that have been replayed
 * successfully enough times to warrant promotion to validated bloodhound
 * executors. Runs in the background so users never see it.
 *
 * ═══════════════════════════════════════════════════════════
 * LIFECYCLE:
 *
 *   1. User asks "check my github PRs" (first time)
 *   2. LLM discovers the path → savePlaybook(agentProfile: 'general')
 *   3. success_count = 1
 *
 *   4. User asks again → findPlaybook() injects hint → LLM replays
 *   5. Post-loop: savePlaybook() increments success_count = 2
 *
 *   6. User asks a third time → same flow → success_count = 3
 *
 *   7. Background: autoGraduate() detects success_count >= GRAD_THRESHOLD
 *   8. Opens a temp tab, runs tournament validation silently
 *   9. If validation passes → promotes to agentProfile: 'bloodhound'
 *  10. Next time → executeSavedBloodhoundPlaybook() short-circuits (zero API calls)
 *
 *  The user never asked for this. The system just got faster by itself.
 *
 * ═══════════════════════════════════════════════════════════
 * INTEGRATION:
 *
 *   Call scheduleAutoGraduation() once at app startup.
 *   It debounces internally — safe to call multiple times.
 *
 * ═══════════════════════════════════════════════════════════
 */

import { getDb } from './database';
import { extractDomain } from './site-profiles';
import type { Playbook, PlaybookStep, PlaybookValidationResult } from './browser-playbooks';
import {
  createTab, switchTab, closeTab, getTabList, getCurrentUrl, getVisibleText,
} from '../browser/manager';
import {
  executeBrowserSearch, executeBrowserNavigate, executeBrowserReadPage,
  executeBrowserClick, executeBrowserType, executeBrowserExtract, executeBrowserScroll,
} from '../agent/executors/browser-executors';

// ─── Config ───

/** Minimum success_count before a general playbook becomes a graduation candidate */
const GRAD_THRESHOLD = 3;

/** Maximum playbooks to graduate per cycle (rate-limits browser tab usage) */
const MAX_PER_CYCLE = 5;

/** Validation runs per candidate during graduation */
const VALIDATION_RUNS = 2;

/** Minimum success rate to pass graduation */
const MIN_SUCCESS_RATE = 0.85;

/** Debounce interval — don't run graduation more than once per N ms */
const DEBOUNCE_MS = 60_000; // 1 minute

/** Delay before first graduation attempt after startup */
const STARTUP_DELAY_MS = 30_000; // 30 seconds

// ─── State ───

let graduationTimer: ReturnType<typeof setTimeout> | null = null;
let lastGraduationAt = 0;
let isGraduating = false;

// ─── Public API ───

/**
 * Schedule automatic graduation checks.
 * Call once at app startup. Safe to call multiple times.
 */
export function scheduleAutoGraduation(): void {
  if (graduationTimer) return;
  graduationTimer = setTimeout(() => {
    graduationTimer = null;
    runAutoGraduation().catch(err => {
      console.warn('[AutoGrad] Graduation cycle failed:', err.message);
    });
  }, STARTUP_DELAY_MS);
  console.log(`[AutoGrad] Scheduled first graduation check in ${STARTUP_DELAY_MS / 1000}s`);
}

/**
 * Trigger a graduation check now (debounced).
 * Called internally after each successful playbook save.
 */
export function nudgeGraduation(): void {
  const now = Date.now();
  if (now - lastGraduationAt < DEBOUNCE_MS) return;
  if (isGraduating) return;
  if (graduationTimer) clearTimeout(graduationTimer);
  graduationTimer = setTimeout(() => {
    graduationTimer = null;
    runAutoGraduation().catch(err => {
      console.warn('[AutoGrad] Graduation cycle failed:', err.message);
    });
  }, 5_000); // Short delay to batch multiple saves
}

// ─── Core Logic ───

async function runAutoGraduation(): Promise<void> {
  if (isGraduating) return;
  isGraduating = true;
  lastGraduationAt = Date.now();

  try {
    const candidates = findGraduationCandidates();
    if (candidates.length === 0) {
      return;
    }

    console.log(`[AutoGrad] Found ${candidates.length} graduation candidate(s), processing up to ${MAX_PER_CYCLE}`);

    let graduated = 0;
    for (const candidate of candidates.slice(0, MAX_PER_CYCLE)) {
      const result = await validateForGraduation(candidate);
      if (result.passed) {
        promoteToBloodhound(candidate, result);
        graduated++;
        console.log(`[AutoGrad] ✓ Graduated "${candidate.taskPattern}" on ${candidate.domain} (${Math.round(result.successRate * 100)}% over ${result.runs} run(s))`);
      } else {
        markGraduationAttempted(candidate);
        console.log(`[AutoGrad] ✗ Failed graduation for "${candidate.taskPattern}" on ${candidate.domain} (${Math.round(result.successRate * 100)}%)`);
      }
    }

    if (graduated > 0) {
      console.log(`[AutoGrad] Graduated ${graduated} executor(s) this cycle`);
    }
  } finally {
    isGraduating = false;
  }
}

interface GraduationCandidate {
  id: number;
  domain: string;
  taskPattern: string;
  steps: PlaybookStep[];
  successCount: number;
  failCount: number;
}

function findGraduationCandidates(): GraduationCandidate[] {
  const db = getDb();

  // Find general playbooks that:
  // - Have enough successes to justify validation cost
  // - Haven't failed more than they've succeeded
  // - Haven't already been attempted for graduation recently
  const rows = db.prepare(`
    SELECT id, domain, task_pattern, steps, success_count, fail_count, notes
    FROM browser_playbooks
    WHERE agent_profile = 'general'
      AND success_count >= ?
      AND success_count > fail_count
    ORDER BY success_count DESC
    LIMIT ?
  `).all(GRAD_THRESHOLD, MAX_PER_CYCLE * 2) as any[];

  return rows
    .filter(row => {
      // Skip if we already tried graduating this one recently
      const notes = safeJsonParse<string[]>(row.notes, []);
      const lastAttempt = notes.find((n: string) => n.startsWith('graduation_attempted:'));
      if (lastAttempt) {
        const ts = parseInt(lastAttempt.split(':')[1], 10);
        if (Date.now() - ts < 24 * 60 * 60 * 1000) return false; // Once per day
      }
      return true;
    })
    .map(row => ({
      id: row.id,
      domain: row.domain,
      taskPattern: row.task_pattern,
      steps: safeJsonParse(row.steps, []),
      successCount: row.success_count,
      failCount: row.fail_count,
    }));
}

interface GraduationResult {
  passed: boolean;
  successRate: number;
  runs: number;
  avgRuntimeMs: number;
  notes: string[];
}

async function validateForGraduation(candidate: GraduationCandidate): Promise<GraduationResult> {
  const notes: string[] = [];
  let successes = 0;
  let totalRuntimeMs = 0;

  // Safety: don't validate destructive patterns
  const UNSAFE_RE = /\b(delete|remove|destroy|send|submit|purchase|buy|checkout|post|create|publish|transfer|pay)\b/i;
  if (UNSAFE_RE.test(candidate.taskPattern)) {
    // For unsafe patterns, graduate based on historical success only (no replay)
    return {
      passed: candidate.successCount >= GRAD_THRESHOLD * 2,
      successRate: candidate.successCount / (candidate.successCount + candidate.failCount),
      runs: 0,
      avgRuntimeMs: 0,
      notes: ['Skipped replay validation (task pattern appears state-changing)'],
    };
  }

  for (let run = 0; run < VALIDATION_RUNS; run++) {
    const priorActiveTabId = getTabList().find(tab => tab.isActive)?.id;
    const tempTabId = createTab();
    const startMs = Date.now();

    try {
      const replay = await replaySteps(candidate.steps);
      const finalUrl = getCurrentUrl();
      const finalText = (await getVisibleText()).trim();
      const domainOk = !candidate.domain || extractDomain(finalUrl) === candidate.domain;
      const contentOk = finalText.length >= 40;

      if (replay.ok && domainOk && contentOk) {
        successes++;
      } else {
        notes.push(`Run ${run + 1} failed: ${replay.reason || (!domainOk ? 'wrong domain' : 'thin content')}`);
      }
    } catch (err: any) {
      notes.push(`Run ${run + 1} error: ${err.message}`);
    } finally {
      totalRuntimeMs += Date.now() - startMs;
      if (getTabList().some(tab => tab.id === tempTabId)) closeTab(tempTabId);
      if (priorActiveTabId && getTabList().some(tab => tab.id === priorActiveTabId)) switchTab(priorActiveTabId);
    }
  }

  const successRate = VALIDATION_RUNS > 0 ? successes / VALIDATION_RUNS : 0;
  return {
    passed: successRate >= MIN_SUCCESS_RATE,
    successRate,
    runs: VALIDATION_RUNS,
    avgRuntimeMs: VALIDATION_RUNS > 0 ? Math.round(totalRuntimeMs / VALIDATION_RUNS) : 0,
    notes,
  };
}

function promoteToBloodhound(candidate: GraduationCandidate, result: GraduationResult): void {
  const db = getDb();
  const notes = JSON.stringify([
    `Auto-graduated from general playbook after ${candidate.successCount} successful uses`,
    `Validation: ${Math.round(result.successRate * 100)}% over ${result.runs} run(s)`,
    `Avg runtime: ${result.avgRuntimeMs}ms`,
    ...result.notes,
  ]);

  db.prepare(`
    UPDATE browser_playbooks
    SET agent_profile = 'bloodhound',
        success_rate = ?,
        validation_runs = ?,
        avg_runtime_ms = ?,
        avg_step_count = ?,
        notes = ?,
        last_used = datetime('now')
    WHERE id = ?
  `).run(
    result.successRate,
    result.runs,
    result.avgRuntimeMs,
    candidate.steps.length,
    notes,
    candidate.id,
  );
}

function markGraduationAttempted(candidate: GraduationCandidate): void {
  const db = getDb();
  const existingNotes = safeJsonParse<string[]>(
    (db.prepare('SELECT notes FROM browser_playbooks WHERE id = ?').get(candidate.id) as any)?.notes,
    [],
  );

  // Remove old graduation attempt notes, add new one
  const filtered = existingNotes.filter((n: string) => !n.startsWith('graduation_attempted:'));
  filtered.push(`graduation_attempted:${Date.now()}`);

  db.prepare('UPDATE browser_playbooks SET notes = ? WHERE id = ?')
    .run(JSON.stringify(filtered.slice(-12)), candidate.id);
}

// ─── Replay (mirrors browser-playbooks.ts) ───

async function replaySteps(steps: PlaybookStep[]): Promise<{ ok: boolean; reason?: string }> {
  for (const step of steps) {
    const result = await executeStep(step);
    if (isFailure(result)) {
      return { ok: false, reason: `${step.tool} failed: ${result.slice(0, 200)}` };
    }
  }
  return { ok: true };
}

async function executeStep(step: PlaybookStep): Promise<string> {
  switch (step.tool) {
    case 'browser_search': return executeBrowserSearch(step.input);
    case 'browser_navigate': return executeBrowserNavigate(step.input);
    case 'browser_read_page': return executeBrowserReadPage(step.input);
    case 'browser_click': return executeBrowserClick(step.input);
    case 'browser_type': return executeBrowserType(step.input);
    case 'browser_extract': return executeBrowserExtract(step.input);
    case 'browser_scroll': return executeBrowserScroll(step.input);
    default: return `[Error: unsupported tool] ${step.tool}`;
  }
}

function isFailure(result: string): boolean {
  const lower = result.toLowerCase();
  return lower.startsWith('[error') || lower.startsWith('error:') || lower.includes('[login required]');
}

function safeJsonParse<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}
