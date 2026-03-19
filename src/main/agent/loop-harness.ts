/**
 * Harness Pipeline — generates a CLI-Anything harness for an app.
 *
 * Runs a nested agent loop (max 40 iterations, 12 min wall time) that
 * follows the 7-phase CLI-Anything methodology from HARNESS.md.
 *
 * Does NOT touch module-level state in loop.ts.
 * Registers its abort fn via onRegisterCancel so cancelLoop() can reach it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicClient, resolveModelId } from './client';
import { executeTool, getToolsForGroup } from './tool-builder';
import { getAppProfile, updateAppProfile, type AppProfile } from '../db/app-registry';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const HARNESS_MAX_ITERATIONS = 40;
const HARNESS_MAX_MS = 12 * 60 * 1000;

export interface HarnessPipelineOptions {
  apiKey: string;
  onProgress: (text: string) => void;
  onRegisterCancel: (fn: () => void) => void;
}

export interface PreflightResult {
  ok: boolean;
  reason: string;
  harnessContent?: string;
}

/** Exported for testing — checks that required plugin files exist. */
export async function checkPreflight(
  harnessMdPath: string,
  replSkinPath: string,
): Promise<PreflightResult> {
  if (!fs.existsSync(harnessMdPath)) {
    return { ok: false, reason: `HARNESS.md not found at ${harnessMdPath}. Clone CLI-Anything plugin first.` };
  }
  if (!fs.existsSync(replSkinPath)) {
    return { ok: false, reason: `repl_skin.py not found at ${replSkinPath}.` };
  }
  const harnessContent = fs.readFileSync(harnessMdPath, 'utf-8');
  return { ok: true, reason: '', harnessContent };
}

function buildSystemPrompt(appId: string, harnessContent: string, outputDir: string): string {
  return `You are building a CLI-Anything harness for the application "${appId}".

Follow the 7-phase methodology in HARNESS.md exactly. After completing each phase, narrate what you did in plain text before calling the next tool.

Output directory: ${outputDir}
App binary: ${appId}

HARNESS.md methodology:
${harnessContent}

IMPORTANT RULES:
- Use file_write to create all Python files
- Use shell_exec to run commands (pytest, pip install, --help, man, etc.)
- Use file_read / file_edit to refine files
- After Phase 7 (install), verify with: shell_exec("which cli-anything-${appId}")
- If which succeeds, output the exact text: [HARNESS_INSTALLED_SUCCESS]
- If anything blocks you, explain and continue with best effort
- Never use gui_interact, browser tools, or memory tools`;
}

// Only CORE tools — no GUI, browser, memory
const HARNESS_TOOLS = ['shell_exec', 'file_read', 'file_write', 'file_edit', 'directory_tree'];

export async function runHarnessPipeline(
  appId: string,
  options: HarnessPipelineOptions,
): Promise<boolean> {
  const { apiKey, onProgress, onRegisterCancel } = options;
  const homedir = os.homedir();

  // Pre-flight: verify plugin files exist
  const harnessMdPath = path.join(homedir, 'CLI-Anything', 'cli-anything-plugin', 'HARNESS.md');
  const replSkinPath = path.join(homedir, 'CLI-Anything', 'cli-anything-plugin', 'repl_skin.py');
  const preflight = await checkPreflight(harnessMdPath, replSkinPath);
  if (!preflight.ok) {
    onProgress(`[Harness] Cannot generate: ${preflight.reason}`);
    return false;
  }

  const outputDir = path.join(homedir, 'CLI-Anything', appId, 'agent-harness');
  fs.mkdirSync(outputDir, { recursive: true });

  // Copy repl_skin.py to output utils dir
  const utilsDir = path.join(outputDir, 'cli_anything', appId, 'utils');
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.copyFileSync(replSkinPath, path.join(utilsDir, 'repl_skin.py'));

  // Private abort controller — never touches loop.ts module state
  const abortController = new AbortController();
  onRegisterCancel(() => abortController.abort());

  const client = new AnthropicClient(apiKey, resolveModelId('sonnet'));
  const systemPrompt = buildSystemPrompt(appId, preflight.harnessContent!, outputDir);

  // Get app version for context
  let versionInfo = '';
  try {
    const { stdout } = await execAsync(`${appId} --version 2>&1`, { timeout: 5000 });
    versionInfo = stdout.trim().split('\n')[0];
  } catch { /* non-fatal */ }

  const initialMessage = `Build a complete CLI-Anything harness for "${appId}"${versionInfo ? ` (${versionInfo})` : ''}.

Follow all 7 phases from HARNESS.md. The output goes to: ${outputDir}

Start with Phase 1: run \`${appId} --help\` and \`man ${appId}\` (if available) to understand the app.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialMessage },
  ];

  // Get tool schemas for CORE tools only (static import at top of file)
  const allTools = getToolsForGroup('full');
  const harnessToolSchemas = allTools.filter(t => HARNESS_TOOLS.includes(t.name));

  let installed = false;
  const startMs = Date.now();

  onProgress(`Building CLI harness for ${appId}... (this takes several minutes)`);

  for (let iteration = 0; iteration < HARNESS_MAX_ITERATIONS; iteration++) {
    if (abortController.signal.aborted) {
      onProgress(`[Harness] Generation cancelled.`);
      break;
    }
    if (Date.now() - startMs > HARNESS_MAX_MS) {
      onProgress(`[Harness] Generation timed out after 12 minutes.`);
      break;
    }

    let response: Awaited<ReturnType<typeof client.chat>>;
    try {
      response = await client.chat(
        messages,
        harnessToolSchemas,
        systemPrompt,
        '',
        (text) => {
          // Forward LLM narration to user in real time
          if (text.trim()) onProgress(text);
        },
        { signal: abortController.signal },
      );
    } catch (err: any) {
      if (abortController.signal.aborted) break;
      console.error(`[Harness] LLM error at iteration ${iteration}:`, err.message);
      break;
    }

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    const responseText = textBlocks.map(b => b.text).join('');

    // Check for success signal
    if (responseText.includes('[HARNESS_INSTALLED_SUCCESS]')) {
      installed = true;
      onProgress(`✓ CLI harness for ${appId} installed successfully!`);
      break;
    }

    // No tools = final answer
    if (toolUseBlocks.length === 0) {
      console.log(`[Harness] No tool calls at iteration ${iteration} — stopping.`);
      break;
    }

    messages.push({ role: 'assistant', content: response.content as any });

    // Execute tools sequentially (order matters for file creation)
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      if (!HARNESS_TOOLS.includes(toolUse.name)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `[Error] Tool "${toolUse.name}" not available in harness mode.`,
        });
        continue;
      }
      let result: string;
      try {
        result = await executeTool(toolUse.name, toolUse.input as any);
      } catch (err: any) {
        result = `[Error] ${err.message}`;
      }
      console.log(`[Harness] ${toolUse.name}: ${result.slice(0, 100)}`);
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults as any });
  }

  // Update registry if installed
  if (installed) {
    try {
      // Discover commands
      let commands: string[] | undefined;
      try {
        const { stdout } = await execAsync(
          `cli-anything-${appId} --help 2>/dev/null | grep -E '^  [a-z]' | awk '{print $1}'`,
          { timeout: 5000 },
        );
        const parsed = stdout.trim().split('\n').filter(Boolean);
        if (parsed.length > 0) commands = parsed;
      } catch { /* non-fatal */ }

      // Find SKILL.md
      let skillContent: string | undefined;
      const skillPath = path.join(outputDir, 'cli_anything', appId, 'skills', 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        skillContent = fs.readFileSync(skillPath, 'utf-8');
      }

      const existingProfile = getAppProfile(appId);
      if (existingProfile) {
        existingProfile.cliAnything = {
          command: `cli-anything-${appId}`,
          installed: true,
          commands,
          skillPath: fs.existsSync(skillPath) ? skillPath : undefined,
          skillContent,
        };
        if (!existingProfile.availableSurfaces.includes('cli_anything')) {
          existingProfile.availableSurfaces.unshift('cli_anything');
        }
        existingProfile.lastScanned = new Date().toISOString();
        updateAppProfile(existingProfile);
      } else {
        const newProfile: AppProfile = {
          appId,
          displayName: appId.charAt(0).toUpperCase() + appId.slice(1),
          binaryPath: appId,
          availableSurfaces: ['cli_anything', 'native_cli', 'gui'],
          cliAnything: {
            command: `cli-anything-${appId}`,
            installed: true,
            commands,
            skillPath: fs.existsSync(skillPath) ? skillPath : undefined,
            skillContent,
          },
          windowMatcher: appId,
          confidence: 0.8,
          lastScanned: new Date().toISOString(),
        };
        updateAppProfile(newProfile);
      }
      console.log(`[Harness] Registry updated for ${appId}`);
    } catch (err: any) {
      console.warn(`[Harness] Registry update failed: ${err.message}`);
    }
  }

  return installed;
}
