#!/usr/bin/env node
/**
 * Bloodhound Micro-Seeder
 * Inserts hand-crafted executors directly into the browser_playbooks table.
 *
 * Usage:
 *   node seeder.mjs                          # Seed from default manifest
 *   node seeder.mjs --dry-run                # Preview without writing
 *   node seeder.mjs --db /path/to.db         # Custom DB path
 */

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.config', 'clawdia', 'data.sqlite');

const DEFAULT_EXECUTORS = [
  { domain: 'google.com', taskPattern: 'google search', steps: [{ tool: 'browser_navigate', input: { url: 'https://www.google.com/search?q=${query}' }, summary: 'Google search' }], note: 'Template: ${query} replaced at runtime', templateVars: ['query'] },
  { domain: 'github.com', taskPattern: 'github pull_requests', steps: [{ tool: 'browser_navigate', input: { url: 'https://github.com/pulls' }, summary: 'Open GitHub PRs' }] },
  { domain: 'github.com', taskPattern: 'github review_requests github_review_requests', steps: [{ tool: 'browser_navigate', input: { url: 'https://github.com/pulls/review-requested' }, summary: 'Open GitHub review requests' }] },
  { domain: 'github.com', taskPattern: 'github notification github_notifications', steps: [{ tool: 'browser_navigate', input: { url: 'https://github.com/notifications' }, summary: 'Open GitHub notifications' }] },
  { domain: 'github.com', taskPattern: 'github issue', steps: [{ tool: 'browser_navigate', input: { url: 'https://github.com/issues' }, summary: 'Open GitHub issues' }] },
  { domain: 'mail.google.com', taskPattern: 'gmail email inbox', steps: [{ tool: 'browser_navigate', input: { url: 'https://mail.google.com/mail/u/0/#inbox' }, summary: 'Open Gmail inbox' }] },
  { domain: 'mail.yahoo.com', taskPattern: 'yahoo email inbox', steps: [{ tool: 'browser_navigate', input: { url: 'https://mail.yahoo.com/' }, summary: 'Open Yahoo Mail' }] },
  { domain: 'reddit.com', taskPattern: 'reddit', steps: [{ tool: 'browser_navigate', input: { url: 'https://www.reddit.com/' }, summary: 'Open Reddit' }] },
  { domain: 'twitter.com', taskPattern: 'twitter x notification', steps: [{ tool: 'browser_navigate', input: { url: 'https://x.com/notifications' }, summary: 'Open X/Twitter notifications' }] },
  { domain: 'linkedin.com', taskPattern: 'linkedin message', steps: [{ tool: 'browser_navigate', input: { url: 'https://www.linkedin.com/messaging/' }, summary: 'Open LinkedIn messages' }] },
  { domain: 'vercel.com', taskPattern: 'vercel dashboard deployment', steps: [{ tool: 'browser_navigate', input: { url: 'https://vercel.com/dashboard' }, summary: 'Open Vercel dashboard' }] },
  { domain: 'npmjs.com', taskPattern: 'npm package', steps: [{ tool: 'browser_navigate', input: { url: 'https://www.npmjs.com/search?q=${query}' }, summary: 'Search npm packages' }], templateVars: ['query'] },
  { domain: 'docs.google.com', taskPattern: 'google doc document', steps: [{ tool: 'browser_navigate', input: { url: 'https://docs.google.com/document/u/0/' }, summary: 'Open Google Docs' }] },
  { domain: 'drive.google.com', taskPattern: 'google drive file', steps: [{ tool: 'browser_navigate', input: { url: 'https://drive.google.com/drive/my-drive' }, summary: 'Open Google Drive' }] },
  { domain: 'calendar.google.com', taskPattern: 'google calendar schedule event', steps: [{ tool: 'browser_navigate', input: { url: 'https://calendar.google.com/' }, summary: 'Open Google Calendar' }] },
  { domain: 'open.spotify.com', taskPattern: 'spotify music', steps: [{ tool: 'browser_navigate', input: { url: 'https://open.spotify.com/' }, summary: 'Open Spotify Web Player' }] },
  { domain: 'youtube.com', taskPattern: 'youtube video', steps: [{ tool: 'browser_navigate', input: { url: 'https://www.youtube.com/' }, summary: 'Open YouTube' }] },
  { domain: 'youtube.com', taskPattern: 'youtube search', steps: [{ tool: 'browser_navigate', input: { url: 'https://www.youtube.com/results?search_query=${query}' }, summary: 'Search YouTube' }], templateVars: ['query'] },
  { domain: 'claude.ai', taskPattern: 'claude anthropic chat', steps: [{ tool: 'browser_navigate', input: { url: 'https://claude.ai/new' }, summary: 'Open Claude' }] },
  { domain: 'chatgpt.com', taskPattern: 'chatgpt openai', steps: [{ tool: 'browser_navigate', input: { url: 'https://chatgpt.com/' }, summary: 'Open ChatGPT' }] },
];

// ─── Main ───

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : DEFAULT_DB_PATH;
const manifestIdx = args.indexOf('--manifest');
const dryRun = args.includes('--dry-run');

let executors = DEFAULT_EXECUTORS;
if (manifestIdx >= 0) {
  const manifest = JSON.parse(fs.readFileSync(args[manifestIdx + 1], 'utf-8'));
  executors = manifest.executors;
  console.log(`[Seeder] Loaded ${executors.length} executor(s) from ${args[manifestIdx + 1]}`);
} else {
  console.log('[Seeder] Using built-in default manifest');
}

console.log(`[Seeder] ${executors.length} executor(s) to seed`);
console.log(`[Seeder] Database: ${dbPath}`);
if (dryRun) console.log('[Seeder] DRY RUN — no database writes\n');
else console.log('');

const db = dryRun ? null : new Database(dbPath);
if (db) db.pragma('journal_mode = WAL');

let inserted = 0, updated = 0, skipped = 0;

for (const entry of executors) {
  const { domain, taskPattern, steps, note, templateVars } = entry;
  const notes = JSON.stringify(['Micro-seeded executor (hand-crafted)', ...(note ? [note] : []), ...(templateVars?.length ? [`Template vars: ${templateVars.join(', ')}`] : [])]);

  if (dryRun) {
    console.log(`  [DRY RUN] Would seed: "${taskPattern}" on ${domain} (${steps.length} step(s))`);
    inserted++;
    continue;
  }

  const existing = db.prepare('SELECT id, steps FROM browser_playbooks WHERE domain = ? AND task_pattern = ?').get(domain, taskPattern);

  if (existing) {
    const existingSteps = JSON.parse(existing.steps || '[]');
    if (JSON.stringify(existingSteps) === JSON.stringify(steps)) {
      console.log(`  ⊘ Skipped: "${taskPattern}" on ${domain} (identical)`);
      skipped++;
      continue;
    }
    db.prepare(`UPDATE browser_playbooks SET steps = ?, agent_profile = 'bloodhound', success_rate = 1.0, validation_runs = 1, avg_runtime_ms = 0, avg_step_count = ?, notes = ?, last_used = datetime('now') WHERE id = ?`).run(JSON.stringify(steps), steps.length, notes, existing.id);
    console.log(`  ↻ Updated: "${taskPattern}" on ${domain}`);
    updated++;
  } else {
    db.prepare(`INSERT INTO browser_playbooks (domain, task_pattern, agent_profile, steps, success_rate, validation_runs, avg_runtime_ms, avg_step_count, notes, last_used) VALUES (?, ?, 'bloodhound', ?, 1.0, 1, 0, ?, ?, datetime('now'))`).run(domain, taskPattern, JSON.stringify(steps), steps.length, notes);
    console.log(`  ✓ Inserted: "${taskPattern}" on ${domain}`);
    inserted++;
  }
}

if (db) db.close();

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(`  Inserted: ${inserted}`);
console.log(`  Updated:  ${updated}`);
console.log(`  Skipped:  ${skipped}`);
console.log(`═══════════════════════════════════════════════════════════\n`);
