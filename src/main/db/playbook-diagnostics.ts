#!/usr/bin/env node
/**
 * Playbook Diagnostics — CLI tool to inspect and test the playbook system.
 *
 * Usage (run from clawdia4.0 root):
 *   npx ts-node src/main/db/playbook-diagnostics.ts list
 *   npx ts-node src/main/db/playbook-diagnostics.ts match "check my github notifications"
 *   npx ts-node src/main/db/playbook-diagnostics.ts pattern "check my GitHub notifications"
 *   npx ts-node src/main/db/playbook-diagnostics.ts clear
 *   npx ts-node src/main/db/playbook-diagnostics.ts clear github.com
 *   npx ts-node src/main/db/playbook-diagnostics.ts sites
 *
 * Or after build:
 *   node dist/main/db/playbook-diagnostics.js list
 */

// Mock electron's app.getPath for standalone usage
try {
  require('electron');
} catch {
  // Running outside Electron — mock the module
  const os = require('os');
  const path = require('path');
  const mockApp = {
    getPath: (name: string) => {
      if (name === 'userData') return path.join(os.homedir(), '.config', 'clawdia');
      return os.homedir();
    },
  };
  require('module')._cache[require.resolve('electron')] = {
    exports: { app: mockApp },
  } as any;
}

import { getDb } from './database';
import {
  listAllPlaybooks, findPlaybook, deletePlaybook,
  deletePlaybooksForDomain, clearAllPlaybooks,
} from './browser-playbooks';
import { getAuthenticatedSites, getFrequentSites } from './site-profiles';

// Mirror the normalizer from browser-playbooks.ts for testing
function normalizeTaskPattern(task: string): string {
  const lower = task.toLowerCase().trim();
  const cleaned = lower
    .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, '')
    .replace(/\b\d{5,}\b/g, '')
    .replace(/"[^"]+"/g, '')
    .replace(/'[^']+'/g, '');

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
    .filter((w, i, arr) => arr.indexOf(w) === i);
  keywords.sort();
  return keywords.join(' ').slice(0, 100) || lower.slice(0, 100);
}

const args = process.argv.slice(2);
const command = args[0] || 'list';

try {
  // Force DB init
  getDb();

  switch (command) {
    case 'list': {
      const playbooks = listAllPlaybooks();
      if (playbooks.length === 0) {
        console.log('No playbooks saved yet.');
      } else {
        console.log(`\n${playbooks.length} playbook(s):\n`);
        for (const pb of playbooks) {
          console.log(`  [${pb.domain}] "${pb.taskPattern}"`);
          console.log(`    successes: ${pb.successCount} | fails: ${pb.failCount} | steps: ${pb.steps.length}`);
          console.log(`    last used: ${pb.lastUsed} | created: ${pb.createdAt}`);
          for (let i = 0; i < pb.steps.length; i++) {
            const s = pb.steps[i];
            console.log(`    ${i + 1}. ${s.tool}(${JSON.stringify(s.input).slice(0, 80)}) // ${s.summary}`);
          }
          console.log('');
        }
      }
      break;
    }

    case 'match': {
      const query = args.slice(1).join(' ');
      if (!query) { console.log('Usage: match "your query"'); break; }
      const pattern = normalizeTaskPattern(query);
      console.log(`Query:      "${query}"`);
      console.log(`Normalized: "${pattern}"`);
      const pb = findPlaybook(query);
      if (pb) {
        console.log(`\nMATCH FOUND: [${pb.domain}] "${pb.taskPattern}" (${pb.successCount} successes, ${pb.steps.length} steps)`);
        for (let i = 0; i < pb.steps.length; i++) {
          const s = pb.steps[i];
          console.log(`  ${i + 1}. ${s.tool}(${JSON.stringify(s.input).slice(0, 80)})`);
        }
      } else {
        console.log('\nNo matching playbook found.');
        // Show what patterns exist
        const all = listAllPlaybooks();
        if (all.length > 0) {
          console.log('\nExisting patterns:');
          for (const p of all) console.log(`  "${p.taskPattern}" on ${p.domain}`);
        }
      }
      break;
    }

    case 'pattern': {
      const query = args.slice(1).join(' ');
      if (!query) { console.log('Usage: pattern "your query"'); break; }
      const pattern = normalizeTaskPattern(query);
      console.log(`Input:      "${query}"`);
      console.log(`Normalized: "${pattern}"`);

      // Show a few variations so you can test matching
      const variations = [
        query,
        'please ' + query,
        'can you ' + query,
        'show me my ' + query.replace(/^(check|show|get)\s+/i, ''),
        'go to my ' + query.replace(/^(check|show|get)\s+/i, ''),
      ];
      console.log('\nVariations:');
      for (const v of variations) {
        const p = normalizeTaskPattern(v);
        const matches = p === pattern;
        console.log(`  ${matches ? '✓' : '✗'} "${v}" → "${p}"`);
      }
      break;
    }

    case 'clear': {
      const domain = args[1];
      if (domain) {
        const count = deletePlaybooksForDomain(domain);
        console.log(`Deleted ${count} playbook(s) for ${domain}`);
      } else {
        const count = clearAllPlaybooks();
        console.log(`Cleared all ${count} playbook(s)`);
      }
      break;
    }

    case 'sites': {
      const auth = getAuthenticatedSites();
      const freq = getFrequentSites(15);
      console.log(`\nAuthenticated sites (${auth.length}):`);
      for (const s of auth) {
        console.log(`  ${s.displayName} (${s.domain}) — visits: ${s.visitCount}, user: ${s.accountInfo.username || 'unknown'}`);
      }
      console.log(`\nFrequent sites (top 15):`);
      for (const s of freq) {
        console.log(`  ${s.displayName} (${s.domain}) — visits: ${s.visitCount}, auth: ${s.authStatus}`);
      }
      break;
    }

    default:
      console.log('Commands: list, match "query", pattern "query", clear [domain], sites');
  }
} catch (err: any) {
  console.error('Error:', err.message);
  process.exit(1);
}
