/**
 * Prompt Builder — Reads .md prompt files and assembles system blocks.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolGroup, PromptModule } from './classifier';
import type { AgentProfile, PerformanceStance } from '../../shared/types';

function resolvePromptPath(...segments: string[]): string {
  const srcPath = path.join(__dirname, '..', '..', '..', 'src', 'main', 'agent', ...segments);
  if (fs.existsSync(srcPath)) return srcPath;
  return path.join(__dirname, ...segments);
}

function readPromptFile(...segments: string[]): string {
  const filePath = resolvePromptPath(...segments);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.split('\n').filter(line => !line.startsWith('#') || line.startsWith('##')).join('\n').replace(/^##\s*/gm, '').trim();
  } catch (err) {
    console.warn(`[prompt] Failed to read ${filePath}:`, (err as Error).message);
    return '';
  }
}

let cachedStaticPrompt: Map<string, string> = new Map();

export function buildStaticPrompt(toolGroup: ToolGroup, modules: Set<PromptModule>): string {
  const cacheKey = `${toolGroup}:${[...modules].sort().join(',')}`;
  if (cachedStaticPrompt.has(cacheKey)) return cachedStaticPrompt.get(cacheKey)!;

  const parts: string[] = [];
  parts.push(readPromptFile('prompt', 'CORE.md'));
  parts.push(readPromptFile('tools', 'groups', toolGroup, 'CONTEXT.md'));

  const MODULE_FILES: Record<PromptModule, string> = {
    browser: 'BROWSER.md', coding: 'CODING.md', research: 'RESEARCH.md',
    document: 'DOCUMENT.md', desktop_apps: 'DESKTOP_APPS.md', filesystem: 'FILESYSTEM.md', self_knowledge: 'SELF_KNOWLEDGE.md', bloodhound: 'BLOODHOUND.md',
  };

  for (const mod of modules) {
    const content = readPromptFile('prompt', 'modules', MODULE_FILES[mod]);
    if (content) parts.push(content);
  }

  const result = parts.filter(Boolean).join('\n\n');
  cachedStaticPrompt.set(cacheKey, result);
  return result;
}

/**
 * Build the DYNAMIC system prompt (NOT cached, changes per-request).
 * Now includes executionConstraint from the Control Surface Registry.
 */
export function buildDynamicPrompt(opts: {
  agentProfile?: AgentProfile;
  model: string;
  toolGroup: ToolGroup;
  browserUrl?: string;
  memoryContext?: string;
  recallContext?: string;
  siteContext?: string;
  playbookContext?: string;
  desktopContext?: string;
  executionConstraint?: string;
  shortcutContext?: string;
  guiStateContext?: string;
  isGreeting?: boolean;
  performanceStance?: PerformanceStance;
}): string {
  const now = new Date();
  const year = now.getFullYear();
  const date = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';

  const desktopDir = path.join(os.homedir(), 'Desktop');
  const lines: string[] = [
    `DATE: ${date} | TIME: ${time} | TZ: ${tz} | YEAR: ${year}`,
    `SYSTEM: ${os.type()} ${os.release()} (${os.arch()}) | ${os.userInfo().username}@${os.hostname()}`,
    `HOME: ${os.homedir()} | CWD: ${desktopDir} (shell starts here)`,
    `MODEL: ${opts.model}`,
    `TOOLS: ${opts.toolGroup} group active`,
  ];

  if (opts.agentProfile) {
    lines.push(`AGENT PROFILE: ${opts.agentProfile}`);
    if (opts.agentProfile === 'filesystem') {
      lines.push('PROFILE DIRECTIVE: You are acting as the Filesystem Agent. Prefer path-aware inspection, directory-level reasoning, safe batch operations, and filesystem-native workflows over generic coding behavior.');
    } else if (opts.agentProfile === 'bloodhound') {
      lines.push('PROFILE DIRECTIVE: You are acting as Bloodhound. Your job is to design the most efficient reliable browser executor for the user task, validate it through real execution, and persist the learned executor for reuse.');
    }
  }

  if (opts.performanceStance) {
    lines.push(`STANCE: ${opts.performanceStance}`);
    if (opts.performanceStance === 'conservative') {
      lines.push('OPERATING STYLE: Be careful, narrower in scope, and bias toward smaller changes, tighter review, and earlier clarification when ambiguity is high.');
    } else if (opts.performanceStance === 'aggressive') {
      lines.push('OPERATING STYLE: Be more aggressive. Widen search breadth, batch more work together, take larger but coherent steps, follow through further before asking, and optimize for momentum while still obeying policy boundaries.');
    } else {
      lines.push('OPERATING STYLE: Stay balanced. Move decisively without becoming reckless, and keep reviewability high.');
    }
  }

  // Execution constraint from registry routing — HIGHEST PRIORITY
  if (opts.executionConstraint) {
    lines.push('', opts.executionConstraint);
  }

  // Shortcut reference for detected app
  if (opts.shortcutContext) lines.push('', opts.shortcutContext);

  // GUI state from previous interactions (focus, confidence, targets)
  if (opts.guiStateContext) lines.push('', opts.guiStateContext);

  if (opts.desktopContext) lines.push('', opts.desktopContext);
  if (opts.memoryContext) lines.push('', opts.memoryContext);

  // Cross-conversation recall — injected only when semantically relevant
  if (opts.recallContext) lines.push('', opts.recallContext);

  // Authenticated site profiles — so LLM knows which accounts are available
  if (opts.siteContext) lines.push('', opts.siteContext);

  // Playbook — learned navigation sequence for this task
  if (opts.playbookContext) lines.push('', opts.playbookContext);

  if (opts.browserUrl) lines.push(`BROWSER: ${opts.browserUrl}`);

  if (opts.isGreeting) {
    lines.push('', 'The user sent a greeting. Reply in one sentence — acknowledge and ask what they need.');
  }

  return lines.join('\n');
}

export function clearPromptCache(): void { cachedStaticPrompt.clear(); }
