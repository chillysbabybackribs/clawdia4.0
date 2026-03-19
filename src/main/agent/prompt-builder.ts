/**
 * Prompt Builder — Reads .md prompt files and assembles system blocks.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolGroup, PromptModule } from './classifier';

function resolvePromptPath(...segments: string[]): string {
  const srcPath = path.join(__dirname, '..', '..', '..', 'src', 'main', 'agent', ...segments);
  if (fs.existsSync(srcPath)) return srcPath;
  return path.join(__dirname, ...segments);
}

function readPromptFile(...segments: string[]): string {
  const filePath = resolvePromptPath(...segments);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw
      .split('\n')
      .filter(line => !line.startsWith('#') || line.startsWith('##'))
      .join('\n')
      .replace(/^##\s*/gm, '')
      .trim();
  } catch (err) {
    console.warn(`[prompt] Failed to read ${filePath}:`, (err as Error).message);
    return '';
  }
}

let cachedStaticPrompt: Map<string, string> = new Map();

export function buildStaticPrompt(
  toolGroup: ToolGroup,
  modules: Set<PromptModule>,
): string {
  const cacheKey = `${toolGroup}:${[...modules].sort().join(',')}`;
  if (cachedStaticPrompt.has(cacheKey)) {
    return cachedStaticPrompt.get(cacheKey)!;
  }

  const parts: string[] = [];
  parts.push(readPromptFile('prompt', 'CORE.md'));
  parts.push(readPromptFile('tools', 'groups', toolGroup, 'CONTEXT.md'));

  const MODULE_FILES: Record<PromptModule, string> = {
    coding: 'CODING.md',
    research: 'RESEARCH.md',
    document: 'DOCUMENT.md',
    desktop_apps: 'DESKTOP_APPS.md',
    self_knowledge: 'SELF_KNOWLEDGE.md',
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
 * Includes memory context, desktop capabilities, and browser state.
 */
export function buildDynamicPrompt(opts: {
  model: string;
  toolGroup: ToolGroup;
  browserUrl?: string;
  memoryContext?: string;
  desktopContext?: string;
  isGreeting?: boolean;
}): string {
  const now = new Date();
  const year = now.getFullYear();
  const date = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';

  const lines: string[] = [
    `DATE: ${date} | TIME: ${time} | TZ: ${tz} | YEAR: ${year}`,
    `SYSTEM: ${os.type()} ${os.release()} (${os.arch()}) | ${os.userInfo().username}@${os.hostname()} | ${os.homedir()}`,
    `MODEL: ${opts.model}`,
    `TOOLS: ${opts.toolGroup} group active`,
  ];

  if (opts.desktopContext) {
    lines.push('', opts.desktopContext);
  }

  if (opts.memoryContext) {
    lines.push('', opts.memoryContext);
  }

  if (opts.browserUrl) {
    lines.push(`BROWSER: ${opts.browserUrl}`);
  }

  if (opts.isGreeting) {
    lines.push('', 'The user sent a greeting. Reply in one sentence — acknowledge and ask what they need. No lists, no summaries.');
  }

  return lines.join('\n');
}

export function clearPromptCache(): void {
  cachedStaticPrompt.clear();
}
