/**
 * Agent profile override tests — verifies slash-command forcing for manual agent selection.
 *
 * Run: npx tsx tests/test-agent-profile-override.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}`); }
}
function section(name: string): void { console.log(`\n━━━ ${name} ━━━`); }
function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got: ${actual}, expected: ${expected})`);
}

import { classify } from '../src/main/agent/classifier';
import { applyAgentProfileOverride, parseManualAgentProfileOverride } from '../src/main/agent/agent-profile-override';
import { buildClaudeCodeDelegationPrompt } from '../src/main/agent/claude-code';

section('parseManualAgentProfileOverride');
{
  const parsed = parseManualAgentProfileOverride('/filesystem-agent find the exact file containing hello world');
  assertEq(parsed.forcedAgentProfile, 'filesystem', 'Parses filesystem override');
  assertEq(parsed.cleanedMessage, 'find the exact file containing hello world', 'Strips slash command');

  const claude = parseManualAgentProfileOverride('/claude-code review this repo for TypeScript errors');
  assertEq(claude.forcedAgentProfile, undefined, 'Claude Code slash command does not force an agent profile');
  assertEq(
    claude.cleanedMessage,
    buildClaudeCodeDelegationPrompt('review this repo for TypeScript errors', 'read_only'),
    'Claude Code slash command rewrites to standardized read-only delegation prompt',
  );

  const claudeEdit = parseManualAgentProfileOverride('/claude-code-edit fix the failing tests');
  assertEq(claudeEdit.forcedAgentProfile, undefined, 'Claude Code edit slash command does not force an agent profile');
  assertEq(
    claudeEdit.cleanedMessage,
    buildClaudeCodeDelegationPrompt('fix the failing tests', 'edit'),
    'Claude Code edit slash command rewrites to write-enabled delegation prompt',
  );

  const unknown = parseManualAgentProfileOverride('/unknown-agent test');
  assertEq(unknown.forcedAgentProfile, undefined, 'Unknown command is ignored');
  assertEq(unknown.cleanedMessage, '/unknown-agent test', 'Unknown command leaves message intact');
}

section('applyAgentProfileOverride');
{
  const base = classify('what is 2+2?');
  const forcedFilesystem = applyAgentProfileOverride(base, 'filesystem');
  assertEq(forcedFilesystem.agentProfile, 'filesystem', 'Forces filesystem profile');
  assertEq(forcedFilesystem.toolGroup, 'core', 'Filesystem override uses core tools');
  assert(forcedFilesystem.promptModules.has('filesystem'), 'Filesystem override adds filesystem module');
  assertEq(forcedFilesystem.model, 'sonnet', 'Filesystem override upgrades trivial haiku case to sonnet');

  const forcedBloodhound = applyAgentProfileOverride(classify('hi'), 'bloodhound');
  assertEq(forcedBloodhound.agentProfile, 'bloodhound', 'Forces bloodhound profile');
  assert(forcedBloodhound.promptModules.has('bloodhound'), 'Bloodhound override adds bloodhound module');
  assert(forcedBloodhound.promptModules.has('browser'), 'Bloodhound override includes browser module');

  const resetGeneral = applyAgentProfileOverride(classify('organize my Downloads folder'), 'general');
  assertEq(resetGeneral.agentProfile, 'general', 'Can force general profile');
}

console.log('\n' + '═'.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  ❌ ${failure}`);
  process.exit(1);
}
console.log('\n🎉 All agent profile override tests passed!');
