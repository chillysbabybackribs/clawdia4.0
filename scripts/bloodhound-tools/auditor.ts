#!/usr/bin/env npx tsx
/**
 * Bloodhound History Auditor
 * 
 * Mines Clawdia's SQLite database for past successful browser tasks,
 * extracts tool call sequences, scores them, groups by pattern,
 * and outputs a ranked report of executor candidates.
 *
 * Usage:
 *   npx tsx auditor.ts                    # Print report
 *   npx tsx auditor.ts --promote          # Interactive: promote candidates to playbooks
 *   npx tsx auditor.ts --promote-all      # Auto-promote all candidates scoring >= 0.7
 *   npx tsx auditor.ts --json             # Output raw JSON for piping
 *   npx tsx auditor.ts --db /path/to.db   # Custom DB path
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

// ─── Config ───
const DEFAULT_DB_PATH = path.join(
  os.homedir(), '.config', 'clawdia', 'data.sqlite'
);
const MIN_BROWSER_CALLS = 1;
const MIN_CANDIDATE_SCORE = 0.3;

// ─── Helpers (mirrors browser-playbooks.ts logic) ───

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

function normalizeTaskPattern(task: string): string {
  const lower = task.toLowerCase().trim()
    .replace(/^\/[a-z0-9_-]+\s+/i, '')
    .replace(/\bbloodhound\b/g, ' ');

  const cleaned = lower
    .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, '')
    .replace(/\b\d{5,}\b/g, '')
    .replace(/"[^"]+"/g, '')
    .replace(/'[^']+'/g, '')
    .replace(/\bpull requests?\b/g, 'pull_requests')
    .replace(/\bprs?\b/g, 'pull_requests')
    .replace(/[?.,!:/()]+/g, ' ');

  const words = cleaned.match(/\b[a-z][a-z0-9-]*\b/g) || [];
  const keywords = words
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i);

  keywords.sort();
  return keywords.join(' ').slice(0, 100) || lower.slice(0, 100);
}

function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    const match = url.match(/(?:https?:\/\/)?(?:www\.)?([^/?#]+)/);
    return match?.[1]?.replace(/^www\./, '') || '';
  }
}

interface PlaybookStep {
  tool: string;
  input: Record<string, any>;
  summary: string;
}

const STEP_WEIGHTS: Record<string, number> = {
  browser_navigate: 2,
  browser_click: 2,
  browser_type: 2,
  browser_scroll: 3,
  browser_read_page: 4,
  browser_search: 3,
  browser_extract: 3,
};

function scoreSteps(steps: PlaybookStep[]): number {
  return steps.reduce((sum, s) => sum + (STEP_WEIGHTS[s.tool] || 3), 0);
}

function optimizeSteps(steps: PlaybookStep[]): PlaybookStep[] {
  const optimized: PlaybookStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const prev = optimized[optimized.length - 1];
    if (step.tool === 'browser_read_page' && prev?.tool === 'browser_navigate') continue;
    if (step.tool === 'browser_scroll' && prev?.tool === 'browser_scroll'
        && step.input?.direction === prev.input?.direction) {
      optimized[optimized.length - 1] = step;
      continue;
    }
    if (step.tool === 'browser_navigate' && prev?.tool === 'browser_search') {
      optimized[optimized.length - 1] = step;
      continue;
    }
    if (step.tool === 'browser_extract' && prev?.tool === 'browser_navigate') continue;
    optimized.push(step);
  }
  return optimized;
}

// ─── Types ───

interface RawCandidate {
  runId: string;
  conversationId: string;
  goal: string;
  status: string;
  completedAt: string;
  toolCallCount: number;
  browserSteps: PlaybookStep[];
  domain: string;
}

interface ScoredCandidate extends RawCandidate {
  pattern: string;
  optimizedSteps: PlaybookStep[];
  score: number;
  reasons: string[];
}

interface PatternGroup {
  pattern: string;
  domain: string;
  candidates: ScoredCandidate[];
  bestCandidate: ScoredCandidate;
  occurrences: number;
  avgSteps: number;
  alreadySaved: boolean;
}

// ─── Core Logic ───

function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

function extractCandidatesFromRuns(db: Database.Database): RawCandidate[] {
  const candidates: RawCandidate[] = [];

  // Strategy 1: Extract from run_events table
  const runs = db.prepare(`
    SELECT r.id, r.conversation_id, r.goal, r.status, r.completed_at, r.tool_call_count
    FROM runs r
    WHERE r.status = 'completed'
    ORDER BY r.completed_at DESC
  `).all() as any[];

  for (const run of runs) {
    const events = db.prepare(`
      SELECT kind, tool_name, payload_json
      FROM run_events
      WHERE run_id = ? AND kind IN ('tool_dispatched', 'tool_completed', 'tool_success')
      ORDER BY seq ASC
    `).all(run.id) as any[];

    const browserSteps: PlaybookStep[] = [];
    for (const event of events) {
      const payload = safeParse(event.payload_json);
      const toolName = event.tool_name || payload.toolName || payload.name || '';
      if (!toolName.startsWith('browser_') || toolName === 'browser_screenshot') continue;
      browserSteps.push({
        tool: toolName,
        input: sanitizeInput(payload.input || payload.args || {}),
        summary: payload.detail || payload.summary || toolName,
      });
    }

    if (browserSteps.length >= MIN_BROWSER_CALLS) {
      const domain = extractDomainFromSteps(browserSteps);
      candidates.push({
        runId: run.id,
        conversationId: run.conversation_id,
        goal: run.goal || '',
        status: run.status,
        completedAt: run.completed_at || '',
        toolCallCount: run.tool_call_count,
        browserSteps,
        domain,
      });
    }
  }

  // Strategy 2: Extract from messages.tool_calls JSON
  const messages = db.prepare(`
    SELECT m.conversation_id, m.tool_calls, m.content, m.created_at,
           c.title as conv_title
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.role = 'assistant' AND m.tool_calls IS NOT NULL AND m.tool_calls != '[]'
    ORDER BY m.created_at DESC
  `).all() as any[];

  const seenConvIds = new Set(candidates.map(c => c.conversationId));

  for (const msg of messages) {
    if (seenConvIds.has(msg.conversation_id)) continue;

    const toolCalls = safeParse(msg.tool_calls);
    if (!Array.isArray(toolCalls)) continue;

    const browserSteps: PlaybookStep[] = [];
    for (const tc of toolCalls) {
      const name = tc.name || tc.toolName || '';
      if (!name.startsWith('browser_') || name === 'browser_screenshot') continue;
      browserSteps.push({
        tool: name,
        input: sanitizeInput(tc.input || tc.args || {}),
        summary: tc.detail || tc.summary || name,
      });
    }

    if (browserSteps.length >= MIN_BROWSER_CALLS) {
      const domain = extractDomainFromSteps(browserSteps);

      // Try to find the user message that triggered this
      const userMsg = db.prepare(`
        SELECT content FROM messages
        WHERE conversation_id = ? AND role = 'user' AND created_at <= ?
        ORDER BY created_at DESC LIMIT 1
      `).get(msg.conversation_id, msg.created_at) as any;

      candidates.push({
        runId: `msg-${msg.conversation_id}-${msg.created_at}`,
        conversationId: msg.conversation_id,
        goal: userMsg?.content || msg.conv_title || '',
        status: 'completed',
        completedAt: msg.created_at,
        toolCallCount: browserSteps.length,
        browserSteps,
        domain,
      });
      seenConvIds.add(msg.conversation_id);
    }
  }

  return candidates;
}

function scoreCandidates(candidates: RawCandidate[]): ScoredCandidate[] {
  return candidates.map(c => {
    const optimized = optimizeSteps(c.browserSteps);
    const reasons: string[] = [];
    let score = 0;

    // Base: has meaningful steps
    if (optimized.length >= 1) { score += 0.2; reasons.push('has browser steps'); }
    if (optimized.length >= 2) { score += 0.1; reasons.push('multi-step'); }

    // Has a navigate (knows where to go)
    const hasNavigate = optimized.some(s => s.tool === 'browser_navigate');
    if (hasNavigate) { score += 0.2; reasons.push('has navigate'); }

    // Has a direct URL (not search-dependent)
    const hasDirectUrl = optimized.some(s =>
      s.tool === 'browser_navigate' && s.input?.url && !s.input.url.includes('google.com/search')
    );
    if (hasDirectUrl) { score += 0.15; reasons.push('direct URL'); }

    // Domain is known
    if (c.domain) { score += 0.1; reasons.push(`domain: ${c.domain}`); }

    // Efficiency: fewer steps = better
    const stepScore = scoreSteps(optimized);
    if (stepScore <= 6) { score += 0.15; reasons.push('efficient path'); }
    else if (stepScore <= 10) { score += 0.05; reasons.push('moderate path'); }

    // Goal is meaningful (not empty/generic)
    if (c.goal && c.goal.length > 10 && !/^new chat$/i.test(c.goal)) {
      score += 0.1;
      reasons.push('clear goal');
    }

    const pattern = c.goal ? normalizeTaskPattern(c.goal) : '';

    return { ...c, pattern, optimizedSteps: optimized, score: Math.min(1, score), reasons };
  }).filter(c => c.score >= MIN_CANDIDATE_SCORE);
}

function groupByPattern(candidates: ScoredCandidate[], db: Database.Database): PatternGroup[] {
  const groups = new Map<string, ScoredCandidate[]>();

  for (const c of candidates) {
    const key = c.domain ? `${c.domain}::${c.pattern}` : c.pattern;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  // Check which patterns already have saved playbooks
  const existingPlaybooks = new Set<string>();
  try {
    const rows = db.prepare('SELECT domain, task_pattern FROM browser_playbooks').all() as any[];
    for (const row of rows) {
      existingPlaybooks.add(`${row.domain}::${row.task_pattern}`);
    }
  } catch { /* table might not exist */ }

  const result: PatternGroup[] = [];
  for (const [key, members] of groups) {
    members.sort((a, b) => b.score - a.score);
    const best = members[0];
    const avgSteps = members.reduce((sum, m) => sum + m.optimizedSteps.length, 0) / members.length;
    const alreadySaved = existingPlaybooks.has(`${best.domain}::${best.pattern}`);

    result.push({
      pattern: best.pattern,
      domain: best.domain,
      candidates: members,
      bestCandidate: best,
      occurrences: members.length,
      avgSteps,
      alreadySaved,
    });
  }

  result.sort((a, b) => {
    // Already saved goes to bottom
    if (a.alreadySaved !== b.alreadySaved) return a.alreadySaved ? 1 : -1;
    // More occurrences = higher priority
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    // Higher score = higher priority
    return b.bestCandidate.score - a.bestCandidate.score;
  });

  return result;
}

// ─── Promotion (write to playbooks table) ───

function promoteCandidate(dbPath: string, group: PatternGroup): boolean {
  // Open writable connection
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const best = group.bestCandidate;
  const steps = JSON.stringify(best.optimizedSteps);
  const notes = JSON.stringify([
    `Promoted from history audit (${group.occurrences} occurrence(s), score ${best.score.toFixed(2)})`,
    `Source run: ${best.runId}`,
    `Original goal: ${best.goal.slice(0, 200)}`,
  ]);

  try {
    const existing = db.prepare(
      'SELECT id FROM browser_playbooks WHERE domain = ? AND task_pattern = ?'
    ).get(best.domain, best.pattern) as any;

    if (existing) {
      db.prepare(`
        UPDATE browser_playbooks
        SET steps = ?, agent_profile = 'bloodhound', success_rate = 1.0,
            validation_runs = 1, avg_runtime_ms = 0,
            avg_step_count = ?, notes = ?, last_used = datetime('now')
        WHERE id = ?
      `).run(steps, best.optimizedSteps.length, notes, existing.id);
    } else {
      db.prepare(`
        INSERT INTO browser_playbooks (
          domain, task_pattern, agent_profile, steps,
          success_rate, validation_runs, avg_runtime_ms, avg_step_count,
          notes, last_used
        ) VALUES (?, ?, 'bloodhound', ?, 1.0, 1, 0, ?, ?, datetime('now'))
      `).run(best.domain, best.pattern, steps, best.optimizedSteps.length, notes);
    }

    db.close();
    return true;
  } catch (e: any) {
    console.error(`  Failed to promote: ${e.message}`);
    db.close();
    return false;
  }
}

// ─── Helpers ───

function extractDomainFromSteps(steps: PlaybookStep[]): string {
  const nav = steps.find(s => s.tool === 'browser_navigate' && s.input?.url);
  return nav?.input?.url ? extractDomain(nav.input.url) : '';
}

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

function safeParse(json: string | null | undefined): any {
  if (!json) return {};
  try { return JSON.parse(json); } catch { return {}; }
}

// ─── Report Output ───

function printReport(groups: PatternGroup[]): void {
  const newGroups = groups.filter(g => !g.alreadySaved);
  const savedGroups = groups.filter(g => g.alreadySaved);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  BLOODHOUND HISTORY AUDIT');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`  Total candidate groups: ${groups.length}`);
  console.log(`  New (not yet saved):    ${newGroups.length}`);
  console.log(`  Already saved:          ${savedGroups.length}`);
  console.log('');

  if (newGroups.length === 0) {
    console.log('  No new executor candidates found.\n');
    return;
  }

  console.log('─── NEW CANDIDATES ────────────────────────────────────────\n');

  for (let i = 0; i < newGroups.length; i++) {
    const g = newGroups[i];
    const b = g.bestCandidate;

    console.log(`  [${i + 1}] Pattern: "${g.pattern}"`);
    console.log(`      Domain:      ${g.domain || '(none)'}`);
    console.log(`      Occurrences: ${g.occurrences}`);
    console.log(`      Score:       ${b.score.toFixed(2)}`);
    console.log(`      Steps:       ${b.optimizedSteps.length} (optimized from ${b.browserSteps.length})`);
    console.log(`      Goal:        ${b.goal.slice(0, 100)}`);
    console.log(`      Reasons:     ${b.reasons.join(', ')}`);
    console.log(`      Steps detail:`);
    for (let j = 0; j < b.optimizedSteps.length; j++) {
      const s = b.optimizedSteps[j];
      const inputStr = JSON.stringify(s.input).slice(0, 80);
      console.log(`        ${j + 1}. ${s.tool}(${inputStr})`);
    }
    console.log('');
  }

  if (savedGroups.length > 0) {
    console.log('─── ALREADY SAVED (skipped) ───────────────────────────────\n');
    for (const g of savedGroups) {
      console.log(`  ✓ "${g.pattern}" on ${g.domain} (${g.occurrences} occurrence(s))`);
    }
    console.log('');
  }
}

// ─── Interactive Promotion ───

async function interactivePromote(groups: PatternGroup[], dbPath: string): Promise<void> {
  const newGroups = groups.filter(g => !g.alreadySaved);
  if (newGroups.length === 0) {
    console.log('\nNo new candidates to promote.\n');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  console.log('\n─── PROMOTE CANDIDATES ────────────────────────────────────\n');

  let promoted = 0;
  for (let i = 0; i < newGroups.length; i++) {
    const g = newGroups[i];
    const b = g.bestCandidate;
    console.log(`[${i + 1}/${newGroups.length}] "${g.pattern}" on ${g.domain}`);
    console.log(`  Score: ${b.score.toFixed(2)} | ${b.optimizedSteps.length} steps | ${g.occurrences} occurrences`);
    console.log(`  Goal: ${b.goal.slice(0, 100)}`);

    const answer = await ask('  Promote to playbook? [y/n/q] ');
    if (answer.toLowerCase() === 'q') break;
    if (answer.toLowerCase() === 'y') {
      const ok = promoteCandidate(dbPath, g);
      if (ok) { promoted++; console.log('  ✓ Promoted!\n'); }
    } else {
      console.log('  Skipped.\n');
    }
  }

  rl.close();
  console.log(`\nPromoted ${promoted} executor(s).\n`);
}

function autoPromoteAll(groups: PatternGroup[], dbPath: string, minScore = 0.7): void {
  const eligible = groups.filter(g => !g.alreadySaved && g.bestCandidate.score >= minScore);
  console.log(`\nAuto-promoting ${eligible.length} candidate(s) with score >= ${minScore}...\n`);

  let promoted = 0;
  for (const g of eligible) {
    const ok = promoteCandidate(dbPath, g);
    if (ok) {
      promoted++;
      console.log(`  ✓ "${g.pattern}" on ${g.domain} (score ${g.bestCandidate.score.toFixed(2)})`);
    }
  }
  console.log(`\nPromoted ${promoted} executor(s).\n`);
}

// ─── Main ───

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : DEFAULT_DB_PATH;
  const doPromote = args.includes('--promote');
  const doPromoteAll = args.includes('--promote-all');
  const doJson = args.includes('--json');

  console.log(`[Auditor] Opening ${dbPath}`);
  const db = openDb(dbPath);

  console.log('[Auditor] Extracting candidates from history...');
  const raw = extractCandidatesFromRuns(db);
  console.log(`[Auditor] Found ${raw.length} raw candidate(s)`);

  const scored = scoreCandidates(raw);
  console.log(`[Auditor] ${scored.length} candidate(s) above threshold`);

  const groups = groupByPattern(scored, db);
  db.close();

  if (doJson) {
    console.log(JSON.stringify(groups, null, 2));
    return;
  }

  printReport(groups);

  if (doPromoteAll) {
    autoPromoteAll(groups, dbPath);
  } else if (doPromote) {
    await interactivePromote(groups, dbPath);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
