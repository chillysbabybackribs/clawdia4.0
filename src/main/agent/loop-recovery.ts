/**
 * Loop Recovery — Post-loop file verification and LLM recovery.
 *
 * After the main loop ends, checks that files claimed by the task
 * actually exist and are non-empty. If verification fails, gives
 * the LLM one recovery iteration to fix the issue.
 *
 * Extracted from loop.ts for testability.
 */

import type { ProviderClient } from './client';
import type { LLMResponse, NormalizedMessage, NormalizedTextBlock, NormalizedToolDefinition, NormalizedToolResultBlock, NormalizedToolUseBlock } from './client';
import { type VerificationResult } from './verification';
import { dispatchTools, type DispatchContext } from './loop-dispatch';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ═══════════════════════════════════
// File Outcome Verification
// ═══════════════════════════════════

/** Resolve ~ and $HOME in file paths to absolute. */
function resolvePath(p: string): string {
  if (p.startsWith('~/')) return p.replace('~', os.homedir());
  if (p.startsWith('$HOME/')) return p.replace('$HOME', os.homedir());
  return p;
}

/**
 * Verify that files claimed by the task actually exist and are non-empty.
 * Returns null if all checks pass, or a description of the first failure.
 */
export function verifyFileOutcomes(
  finalText: string,
  toolCalls: Array<{ name: string; status: string; input?: Record<string, any> }>,
): string | null {
  const checkedPaths = new Set<string>();

  // Source 1: Successful file_write / create_document calls
  for (const tc of toolCalls) {
    if (tc.status !== 'success') continue;
    let filePath: string | undefined;

    if (tc.name === 'file_write' && tc.input?.path) {
      filePath = resolvePath(tc.input.path);
    } else if (tc.name === 'create_document' && tc.input?.filename) {
      const dir = tc.input.output_dir || path.join(os.homedir(), 'Documents', 'Clawdia');
      filePath = path.join(dir, tc.input.filename);
    }

    if (filePath && !checkedPaths.has(filePath)) {
      checkedPaths.add(filePath);
      try {
        const stat = fs.statSync(filePath);
        if (stat.size === 0) {
          console.warn(`[Verify] File exists but is empty: ${filePath}`);
          return `File was created but is empty (0 bytes): ${filePath}`;
        }
      } catch {
        console.warn(`[Verify] File not found: ${filePath}`);
        return `File does not exist: ${filePath}`;
      }
    }
  }

  // Source 2: File paths mentioned in the final response text
  const pathRe = /(?:~\/|\$HOME\/|\/home\/\w+\/|\/tmp\/)[^\s,;"')>]+/g;
  const mentioned = finalText.match(pathRe) || [];
  for (const raw of mentioned) {
    const cleaned = raw.replace(/[.!?)]+$/, '');
    const abs = resolvePath(cleaned);
    if (checkedPaths.has(abs)) continue;
    checkedPaths.add(abs);
    if (!/\.[a-zA-Z0-9]{1,6}$/.test(abs)) continue;

    try {
      const stat = fs.statSync(abs);
      if (stat.size === 0) {
        console.warn(`[Verify] Mentioned file is empty: ${abs}`);
        return `File mentioned in response is empty (0 bytes): ${abs}`;
      }
    } catch {
      console.warn(`[Verify] Mentioned file not found: ${abs}`);
      return `File mentioned in response does not exist: ${abs}`;
    }
  }

  return null;
}

// ═══════════════════════════════════
// Recovery Iteration
// ═══════════════════════════════════

export interface RecoveryOptions {
  runId?: string;
  client: ProviderClient;
  messages: NormalizedMessage[];
  tools: NormalizedToolDefinition[];
  staticPrompt: string;
  dynamicPrompt: string;
  signal?: AbortSignal;
  iterationIndex: number;
  onStreamText?: (text: string) => void;
  onToolActivity?: (activity: { name: string; status: string; detail?: string }) => void;
  onToolStream?: (payload: { toolId: string; toolName: string; chunk: string }) => void;
  allToolCalls: { name: string; status: string; detail?: string; input?: Record<string, any> }[];
  toolCallCount: number;
}

/**
 * Run one recovery iteration after verification failure.
 * Tells the LLM what failed and gives it one chance to fix it.
 * Returns the updated final text.
 */
export async function runRecoveryIteration(
  issue: string,
  currentText: string,
  opts: RecoveryOptions,
): Promise<string> {
  const { client, messages, tools, staticPrompt, dynamicPrompt, signal, onStreamText, onToolActivity, allToolCalls } = opts;

  console.warn(`[Verify] Task verification failed: ${issue}`);
  onStreamText?.('\n\n__RESET__');
  messages.push({ role: 'assistant', content: currentText });
  messages.push({
    role: 'user',
    content: `[SYSTEM] Verification failed: ${issue}. The file you claimed to create does not exist or is empty. Fix this now — create or re-create the file, then confirm.`,
  });

  let finalText = currentText;

  try {
    let recoveryText = '';
    const recoveryResponse = await client.chat(
      messages, tools, staticPrompt, dynamicPrompt,
      (chunk) => { recoveryText += chunk; onStreamText?.(chunk); },
      { signal },
    );

    const recoveryToolUses = recoveryResponse.content.filter(
      (b): b is NormalizedToolUseBlock => b.type === 'tool_use',
    );

    if (recoveryToolUses.length > 0) {
      messages.push({ role: 'assistant', content: recoveryResponse.content as any });
      const dispatchCtx: DispatchContext = {
        runId: opts.runId,
        signal,
        tools,
        executionPlan: null,
        toolGroup: 'full',
        iterationIndex: opts.iterationIndex,
        filesystemQuoteLookupMode: false,
        strongFilesystemQuoteMatch: false,
        escalatedToFull: false,
        toolCallCount: opts.toolCallCount,
        allToolCalls,
        allVerifications: [],
        onToolActivity,
        onToolStream: opts.onToolStream,
      };
      const recoveryResults = await dispatchTools(recoveryToolUses, dispatchCtx);
      opts.toolCallCount = dispatchCtx.toolCallCount;

      messages.push({ role: 'user', content: recoveryResults as any });

      // Final LLM call for updated response text
      let finalRecoveryText = '';
      await client.chat(
        messages, [], staticPrompt, dynamicPrompt,
        (chunk) => { finalRecoveryText += chunk; onStreamText?.(chunk); },
        { signal },
      );
      if (finalRecoveryText) finalText = finalRecoveryText;
    } else {
      const textBlocks = recoveryResponse.content.filter(
        (b): b is NormalizedTextBlock => b.type === 'text',
      );
      const text = textBlocks.map(b => b.text).join('');
      if (text) finalText = text;
    }

    console.log(`[Verify] Recovery iteration complete`);
  } catch (err: any) {
    console.warn(`[Verify] Recovery failed: ${err.message}`);
  }

  return finalText;
}

/**
 * Log verification summary to console.
 */
export function logVerificationSummary(verifications: VerificationResult[]): void {
  if (verifications.length === 0) return;
  const passed = verifications.filter(v => v.passed).length;
  const failed = verifications.filter(v => !v.passed).length;
  console.log(`[Verify] Summary: ${passed} passed, ${failed} failed out of ${verifications.length} checks`);
  if (failed > 0) {
    for (const v of verifications.filter(v => !v.passed)) {
      console.warn(`[Verify]   ✗ ${v.rule.surface}/${v.rule.type}: expected="${v.rule.expected.slice(0, 40)}" actual="${v.actual.slice(0, 60)}"`);
    }
  }
}
