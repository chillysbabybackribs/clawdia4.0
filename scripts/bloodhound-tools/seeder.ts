#!/usr/bin/env node
/**
 * Bloodhound Micro-Seeder
 *
 * Reads a manifest of hand-crafted executors and inserts them directly
 * into the browser_playbooks table. For guaranteed one-shot tasks
 * that don't need tournament validation.
 *
 * Usage:
 *   node --import tsx/esm seeder.ts                          # Seed from default manifest
 *   node --import tsx/esm seeder.ts --manifest custom.json   # Seed from custom manifest
 *   node --import tsx/esm seeder.ts --dry-run                # Preview without writing
 *   node --import tsx/esm seeder.ts --db /path/to.db         # Custom DB path
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ─── Config ───
const DEFAULT_DB_PATH = path.join(
  os.homedir(), '.config', 'clawdia', 'data.sqlite'
);

// ─── Types ───

interface ManifestStep {
  tool: string;
  input: Record<string, any>;
  summary: string;
}

interface ManifestEntry {
  domain: string;
  taskPattern: string;
  steps: ManifestStep[];
  note?: string;
  templateVars?: string[];
}

interface ManifestFile {
  version: number;
  description?: string;
  executors: ManifestEntry[];
}

// ─── Default Manifest ───

const DEFAULT_MANIFEST: ManifestFile = {
  version: 1,
  description: 'Bloodhound micro-executors — hand-crafted guaranteed one-shot tasks',
  executors: [
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
  ],
};

// ─── Seeder Logic ───

function seedExecutors(dbPath: string, manifest: ManifestFile, dryRun: boolean): { inserted: number; updated: number; skipped: number } {
  const stats = { inserted: 0, updated: 0, skipped: 0 };
  const db = dryRun ? null : new Database(dbPath);
  if (db) db.pragma('journal_mode = WAL');

  for (const entry of manifest.executors) {
    const { domain, taskPattern, steps, note, templateVars } = entry;
    const notes = JSON.stringify(['Micro-seeded executor (hand-crafted, no tournament validation)', ...(note ? [note] : []), ...(templateVars?.length ? [`Template vars: ${templateVars.join(', ')}`] : [])]);

    if (dryRun) {
      console.log(`  [DRY RUN] Would seed: "${taskPattern}" on ${domain} (${steps.length} step(s))`);
      stats.inserted++;
      continue;
    }

    const existing = db!.prepare('SELECT id, steps FROM browser_playbooks WHERE domain = ? AND task_pattern = ?').get(domain, taskPattern) as any;

    if (existing) {
      const existingSteps = JSON.parse(existing.steps || '[]');
      if (JSON.stringify(existingSteps) === JSON.stringify(steps)) {
        console.log(`  ⊘ Skipped: "${taskPattern}" on ${domain} (identical)`);
        stats.skipped++;
        continue;
      }
      db!.prepare(`UPDATE browser_playbooks SET steps = ?, agent_profile = 'bloodhound', success_rate = 1.0, validation_runs = 1, avg_runtime_ms = 0, avg_step_count = ?, notes = ?, last_used = datetime('now') WHERE id = ?`).run(JSON.stringify(steps), steps.length, notes, existing.id);
      console.log(`  ↻ Updated: "${taskPattern}" on ${domain}`);
      stats.updated++;
    } else {
      db!.prepare(`INSERT INTO browser_playbooks (domain, task_pattern, agent_profile, steps, success_rate, validation_runs, avg_runtime_ms, avg_step_count, notes, last_used) VALUES (?, ?, 'bloodhound', ?, 1.0, 1, 0, ?, ?, datetime('now'))`).run(domain, taskPattern, JSON.stringify(steps), steps.length, notes);
      console.log(`  ✓ Inserted: "${taskPattern}" on ${domain}`);
      stats.inserted++;
    }
  }

  if (db) db.close();
  return stats;
}

// ─── Main ───

function main(): void {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : DEFAULT_DB_PATH;
  const manifestIdx = args.indexOf('--manifest');
  const dryRun = args.includes('--dry-run');

  let manifest: ManifestFile;
  if (manifestIdx >= 0) {
    const manifestPath = args[manifestIdx + 1];
    console.log(`[Seeder] Loading manifest from ${manifestPath}`);
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } else {
    console.log('[Seeder] Using built-in default manifest');
    manifest = DEFAULT_MANIFEST;
  }

  console.log(`[Seeder] ${manifest.executors.length} executor(s) in manifest`);
  console.log(`[Seeder] Database: ${dbPath}`);
  if (dryRun) console.log('[Seeder] DRY RUN — no database writes\n');
  else console.log('');

  const stats = seedExecutors(dbPath, manifest, dryRun);

  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Inserted: ${stats.inserted}`);
  console.log(`  Updated:  ${stats.updated}`);
  console.log(`  Skipped:  ${stats.skipped}`);
  console.log(`═══════════════════════════════════════════════════════════\n`);
}

main();
