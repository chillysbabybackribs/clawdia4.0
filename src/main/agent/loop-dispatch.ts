/**
 * Loop Dispatch — Parallel tool dispatch with batching.
 *
 * Partitions tool-use blocks into ordered batches and dispatches each
 * batch concurrently. Sequential tools (GUI, shell) get their own batch.
 * Includes mid-loop escalation, verification, and deviation tracking.
 *
 * Extracted from loop.ts for testability and separation of concerns.
 */

import { executeTool, isKnownTool, getToolsForGroup, filterTools } from './tool-builder';
import type { NormalizedToolDefinition, NormalizedToolResultBlock, NormalizedToolUseBlock } from './client';
import { resolveVerificationRule, verify, logVerification, type VerificationResult } from './verification';
import { recordSurfaceDeviation, type ExecutionPlan } from '../db/app-registry';
import { appendRunEvent } from '../db/run-events';
import { buildTextDiff, createRunChange } from '../db/run-changes';
import { maybeRequireApproval, recordPolicyBlocked, requestApproval, waitForApproval } from './approval-manager';
import { guardFileMutation, noteFileMutationSuccess, noteFileRead } from './file-lock-manager';
import { spawnSwarm } from './agent-spawn-executor';
import { SCREENSHOT_PREFIX } from './executors/browser-executors';
import { noteProcessSpecializedTool } from './process-manager';
import { getUnrestrictedMode } from '../store';
import * as fs from 'fs';

// ═══════════════════════════════════
// Batch Partitioning
// ═══════════════════════════════════

const SEQUENTIAL_TOOLS = new Set([
  'gui_interact', 'app_control', 'dbus_control', 'shell_exec',
]);

function isSequentialTool(toolName: string): boolean {
  if (SEQUENTIAL_TOOLS.has(toolName)) return true;
  // Browser workers operate against one active tab unless they explicitly manage tabs.
  // Running stateful browser tools in parallel on the same worker causes tab clobbering
  // and non-deterministic reads. Keep browser_search parallel-safe, but serialize the
  // rest of the browser tool surface by default.
  if (toolName.startsWith('browser_') && toolName !== 'browser_search') return true;
  return false;
}

/**
 * Partition tool-use blocks into ordered batches for parallel dispatch.
 * Each batch can be dispatched with Promise.all.
 *
 * A batch boundary is inserted when:
 *   - A sequential tool is encountered (GUI/shell — order matters)
 *   - A tool's input references the name of a previous tool
 */
export function partitionIntoBatches(
  blocks: NormalizedToolUseBlock[],
): NormalizedToolUseBlock[][] {
  const batches: NormalizedToolUseBlock[][] = [];
  let current: NormalizedToolUseBlock[] = [];
  const seenNames: string[] = [];

  for (const block of blocks) {
    const isSeq = isSequentialTool(block.name);
    const inputStr = JSON.stringify(block.input).toLowerCase();
    const referencesPrev = seenNames.some(n => inputStr.includes(n.toLowerCase()));

    if (isSeq || referencesPrev) {
      if (current.length > 0) { batches.push(current); current = []; }
      batches.push([block]);
    } else {
      current.push(block);
    }
    seenNames.push(block.name);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ═══════════════════════════════════
// Tool Result Caps
// ═══════════════════════════════════

const TOOL_RESULT_CAPS: Record<string, number> = {
  shell_exec: 10_000, file_read: 20_000, file_write: 500, file_edit: 500,
  directory_tree: 5_000, fs_quote_lookup: 8_000, fs_folder_summary: 8_000, fs_reorg_plan: 12_000, fs_duplicate_scan: 12_000, fs_apply_plan: 12_000, browser_search: 5_000, browser_navigate: 10_000,
  browser_read_page: 10_000, browser_click: 5_000, browser_type: 500,
  browser_extract: 10_000, browser_screenshot: 1_000, browser_eval: 8_000,
  browser_dom_snapshot: 12_000, browser_network_watch: 8_000, browser_scroll: 10_000,
  browser_tab_new: 200, browser_tab_switch: 200, browser_tab_close: 200, browser_tab_list: 2_000,
  create_document: 500,
  memory_search: 3_000, memory_store: 500, recall_context: 5_000,
  app_control: 10_000, gui_interact: 5_000, dbus_control: 8_000,
};
const DEFAULT_RESULT_CAP = 10_000;

// ═══════════════════════════════════
// Dispatch Context — mutable state passed through dispatch
// ═══════════════════════════════════

export interface DispatchContext {
  runId?: string;
  signal?: AbortSignal;
  tools: NormalizedToolDefinition[];
  executionPlan: ExecutionPlan | null;
  toolGroup: string;
  filesystemQuoteLookupMode?: boolean;
  strongFilesystemQuoteMatch?: boolean;
  escalatedToFull: boolean;
  toolCallCount: number;
  allToolCalls: { name: string; status: string; detail?: string; input?: Record<string, any>; durationMs?: number }[];
  allVerifications: VerificationResult[];
  onToolActivity?: (activity: { name: string; status: string; detail?: string }) => void;
  onToolStream?: (payload: { toolId: string; toolName: string; chunk: string }) => void;
}

/**
 * Dispatch all tool-use blocks from one LLM turn, respecting batch ordering.
 * Returns an array of tool results in the original LLM-returned order.
 *
 * Side effects: updates ctx.toolCallCount, ctx.allToolCalls, ctx.allVerifications,
 * and may escalate ctx.tools/ctx.escalatedToFull on mid-loop escalation.
 */
export async function dispatchTools(
  toolUseBlocks: NormalizedToolUseBlock[],
  ctx: DispatchContext,
): Promise<NormalizedToolResultBlock[]> {
  const batches = partitionIntoBatches(toolUseBlocks);
  const parallelBatchCount = batches.filter(b => b.length > 1).length;
  if (parallelBatchCount > 0) {
    console.log(`[Agent] Parallel dispatch: ${toolUseBlocks.length} tools → ${batches.length} batch(es), ${parallelBatchCount} parallel`);
  }

  const toolResults: NormalizedToolResultBlock[] = [];

  for (const batch of batches) {
    const batchResults = await Promise.all(batch.map(async (toolUse) => {
      ctx.toolCallCount++;
      const startMs = Date.now();
      const detail = summarizeInput(toolUse.name, toolUse.input as any);
      const surface = inferSurface(toolUse.name);
      const fileBefore = captureFileBefore(toolUse.name, toolUse.input as Record<string, any>);
      const approvalDecision = maybeRequireApproval(toolUse.name, toolUse.input as Record<string, any>);

      ctx.onToolActivity?.({ name: toolUse.name, status: 'running', detail });
      if (ctx.runId) {
        appendRunEvent(ctx.runId, {
          kind: 'tool_started',
          phase: 'dispatch',
          surface,
          toolName: toolUse.name,
          payload: {
            toolUseId: toolUse.id,
            detail,
            input: toolUse.input as Record<string, any>,
            ordinal: ctx.toolCallCount,
          },
        });
      }
      console.log(`[Agent] Tool #${ctx.toolCallCount}: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);

      let result: string;
      try {
        if (approvalDecision?.effect === 'deny' && ctx.runId) {
          recordPolicyBlocked(ctx.runId, approvalDecision);
          ctx.onToolActivity?.({
            name: toolUse.name,
            status: 'error',
            detail: approvalDecision.summary,
          });
          result = `[Blocked by policy] ${approvalDecision.summary}`;
        } else if (approvalDecision?.effect === 'require_approval' && ctx.runId) {
          const approval = requestApproval(ctx.runId, {
            actionType: approvalDecision.actionType,
            target: approvalDecision.target,
            summary: approvalDecision.summary,
            request: {
              ...(approvalDecision.request || {}),
              toolName: toolUse.name,
              toolUseId: toolUse.id,
              input: toolUse.input as Record<string, any>,
            },
          });

          ctx.onToolActivity?.({
            name: toolUse.name,
            status: 'awaiting_approval',
            detail: approval.summary,
          });

          const decision = await waitForApproval(approval.id);
          if (decision === 'denied') {
            result = `[Approval denied] ${approval.summary}`;
          } else {
            result = await executeGuardedTool(toolUse, ctx, surface);
          }
        } else {
          result = await executeGuardedTool(toolUse, ctx, surface);
        }
      } catch (err: any) {
        result = `[Error] ${err.message}`;
      }

      const humanIntervention = inferHumanInterventionRequirement(
        toolUse.name,
        toolUse.input as Record<string, any>,
        result,
      );

      if (humanIntervention) {
        result = `[Error] ${humanIntervention.summary}`;
      }

      // Mid-loop escalation: upgrade tool group if a known tool was missing
      if (result.startsWith('[Error] Unknown tool:') && !ctx.escalatedToFull && isKnownTool(toolUse.name)) {
        console.warn(`[Escalation] Tool "${toolUse.name}" exists but was not in group "${ctx.toolGroup}". Upgrading to full.`);
        ctx.tools = getToolsForGroup('full');
        if (ctx.executionPlan && ctx.executionPlan.disallowedTools.length > 0) {
          ctx.tools = filterTools(ctx.tools, ctx.executionPlan.disallowedTools);
        }
        ctx.escalatedToFull = true;
        if (ctx.runId) {
          appendRunEvent(ctx.runId, {
            kind: 'tool_escalated',
            phase: 'dispatch',
            surface,
            toolName: toolUse.name,
            payload: {
              detail: `Escalated tool set to full for ${toolUse.name}`,
              previousGroup: ctx.toolGroup,
            },
          });
        }
        try {
          result = await executeGuardedTool(toolUse, ctx, surface);
        } catch (err: any) {
          result = `[Error] ${err.message}`;
        }
      }

      const durationMs = Date.now() - startMs;
      const status = result.startsWith('[Error') || result.startsWith('[Approval denied]') ? 'error' : 'success';

      if (ctx.filesystemQuoteLookupMode && toolUse.name === 'fs_quote_lookup' && inferStrongFilesystemQuoteMatch(result)) {
        ctx.strongFilesystemQuoteMatch = true;
      }

      ctx.onToolActivity?.({ name: toolUse.name, status, detail });
      ctx.allToolCalls.push({ name: toolUse.name, status, detail, input: toolUse.input as Record<string, any>, durationMs });
      let completionEventId: number | undefined;
      if (ctx.runId) {
        completionEventId = appendRunEvent(ctx.runId, {
          kind: status === 'error' ? 'tool_failed' : 'tool_completed',
          phase: 'dispatch',
          surface,
          toolName: toolUse.name,
          payload: {
            toolUseId: toolUse.id,
            detail,
            durationMs,
            resultPreview: result.startsWith(SCREENSHOT_PREFIX) ? '[screenshot image]' : result.slice(0, 500),
            status,
          },
        });
      }
      console.log(`[Agent] Result (${durationMs}ms): ${result.startsWith(SCREENSHOT_PREFIX) ? '[screenshot image]' : result.slice(0, 200)}`);

      if (ctx.runId && status === 'success') {
        persistStructuredChange(ctx.runId, completionEventId, toolUse.name, toolUse.input as Record<string, any>, fileBefore);
        if (toolUse.name.startsWith('fs_')) {
          noteProcessSpecializedTool(ctx.runId, toolUse.name);
        }
      }

      // Post-action verification
      if (status === 'success' && !getUnrestrictedMode()) {
        const vRule = resolveVerificationRule(toolUse.name, toolUse.input as Record<string, any>);
        if (vRule) {
          const vResult = verify(vRule, result);
          logVerification(toolUse.name, toolUse.input as Record<string, any>, vResult);
          ctx.allVerifications.push(vResult);
          if (!vResult.passed) {
            result += `\n[Verification failed: ${vRule.type} — expected "${vRule.expected.slice(0, 60)}" but got "${vResult.actual.slice(0, 80)}"]`;
          }
        }
      }

      // Track surface deviations
      if (ctx.executionPlan?.appId && ctx.executionPlan.selectedSurface) {
        recordSurfaceDeviation(ctx.executionPlan.appId, ctx.executionPlan.selectedSurface, toolUse.name);
      }

      if (status === 'error') result += '\n[Hint: Change your approach — do not retry the same command.]';

      // Cap result length (skip for screenshots — handled as image blocks downstream)
      if (!result.startsWith(SCREENSHOT_PREFIX)) {
        const cap = TOOL_RESULT_CAPS[toolUse.name] || DEFAULT_RESULT_CAP;
        if (result.length > cap) {
          result = result.slice(0, cap) + `\n\n[Truncated — ${result.length} chars, showing first ${cap}]`;
        }
      }

      return { id: toolUse.id, content: result } as const;
    }));

    for (const r of batchResults) {
      // Detect screenshot results — unpack into an image content block so the LLM can see the page.
      if (r.content.startsWith(SCREENSHOT_PREFIX)) {
        try {
          const { base64, width, height, sizeKb } = JSON.parse(r.content.slice(SCREENSHOT_PREFIX.length));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: r.id,
            content: [
              { type: 'text', text: `Screenshot: ${width}x${height}px (${sizeKb}KB)` },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            ],
          });
          continue;
        } catch {
          // Fall through to plain text if JSON parse fails
        }
      }
      toolResults.push({ type: 'tool_result', tool_use_id: r.id, content: r.content });
    }
  }

  return toolResults;
}

function withBrowserRunContext(
  toolUse: NormalizedToolUseBlock,
  ctx: DispatchContext,
): NormalizedToolUseBlock {
  if (!ctx.runId || !toolUse.name.startsWith('browser_')) return toolUse;
  return {
    ...toolUse,
    input: {
      ...(toolUse.input as Record<string, any>),
      __runId: ctx.runId,
    },
  };
}

async function executeApprovedTool(
  toolUse: NormalizedToolUseBlock,
  ctx: DispatchContext,
  surface: string,
): Promise<string> {
  const chunkCb = ctx.onToolStream
    ? (tn: string, chunk: string) => {
        ctx.onToolStream!({ toolId: toolUse.id, toolName: tn, chunk });
        if (ctx.runId) {
          appendRunEvent(ctx.runId, {
            kind: 'tool_progress',
            phase: 'dispatch',
            surface,
            toolName: tn,
            payload: {
              toolUseId: toolUse.id,
              chunk,
            },
          });
        }
      }
    : undefined;

  // ── agent_spawn: needs runId from ctx, handled here before generic dispatch ──
  if (toolUse.name === 'agent_spawn') {
    const input = toolUse.input as { tasks: Array<{ role: string; goal: string; context?: string }> };
    const swarmResult = await spawnSwarm(ctx.runId ?? `swarm-${Date.now()}`, input.tasks ?? []);
    const summary = [
      `Swarm complete: ${swarmResult.agentCount} agents, ${swarmResult.totalToolCalls} tool calls, ${Math.round(swarmResult.durationMs / 1000)}s`,
      '',
      ...swarmResult.results.map((r, i) =>
        `## Agent ${i + 1} [${r.role}]\nGoal: ${r.goal}\n\n${r.result}`,
      ),
    ].join('\n');
    return summary;
  }

  const resolvedToolUse = withBrowserRunContext(toolUse, ctx);
  return executeTool(resolvedToolUse.name, resolvedToolUse.input as any, chunkCb);
}

async function executeGuardedTool(
  toolUse: NormalizedToolUseBlock,
  ctx: DispatchContext,
  surface: string,
): Promise<string> {
  const input = toolUse.input as Record<string, any>;
  if (shouldBlockFilesystemQuoteFollowup(ctx, toolUse.name)) {
    return `[Blocked] Strong filesystem quote match already found. Return the best match instead of running ${toolUse.name}.`;
  }
  const isFileRead = !!ctx.runId && toolUse.name === 'file_read' && typeof input.path === 'string';
  const isFileMutation = !!ctx.runId && (toolUse.name === 'file_write' || toolUse.name === 'file_edit') && typeof input.path === 'string';

  if (!isFileMutation) {
    const result = await executeApprovedTool(toolUse, ctx, surface);
    if (isFileRead && !result.startsWith('[Error')) {
      noteFileRead(ctx.runId!, input.path);
    }
    return result;
  }

  let guard = guardFileMutation(ctx.runId!, input.path);
  if (!guard.ok) {
    appendRunEvent(ctx.runId!, {
      kind: 'file_lock_conflict',
      phase: 'dispatch',
      surface,
      toolName: toolUse.name,
      payload: {
        path: guard.path,
        ownerRunId: guard.ownerRunId,
        expectedRevision: guard.expectedRevision,
        currentRevision: guard.currentRevision,
        summary: guard.summary,
      },
    });

    return `[Error] ${guard.summary}`;
  }

  appendRunEvent(ctx.runId!, {
    kind: 'file_lock_acquired',
    phase: 'dispatch',
    surface,
    toolName: toolUse.name,
    payload: {
      path: guard.path,
      sourceRevision: guard.sourceRevision,
    },
  });

  try {
    const result = await executeApprovedTool(toolUse, ctx, surface);
    if (!result.startsWith('[Error')) {
      noteFileMutationSuccess(ctx.runId!, input.path);
    }
    return result;
  } finally {
    guard.release();
    appendRunEvent(ctx.runId!, {
      kind: 'file_lock_released',
      phase: 'dispatch',
      surface,
      toolName: toolUse.name,
      payload: {
        path: guard.path,
      },
    });
  }
}

export function inferStrongFilesystemQuoteMatch(result: string): boolean {
  const confidenceMatch = result.match(/BEST MATCH CONFIDENCE:\s*([0-9.]+)/i);
  const confidence = confidenceMatch ? Number(confidenceMatch[1]) : 0;
  return Number.isFinite(confidence) && confidence >= 0.8;
}

export function shouldBlockFilesystemQuoteFollowup(
  ctx: Pick<DispatchContext, 'filesystemQuoteLookupMode' | 'strongFilesystemQuoteMatch'>,
  toolName: string,
): boolean {
  if (!ctx.filesystemQuoteLookupMode || !ctx.strongFilesystemQuoteMatch) return false;
  return toolName === 'fs_quote_lookup' || toolName === 'file_read';
}

interface HumanInterventionRequirement {
  type: 'password' | 'otp' | 'captcha' | 'native_dialog' | 'site_confirmation' | 'conflict_resolution' | 'manual_takeover' | 'unknown';
  summary: string;
  instructions: string;
  target?: string;
  detectedFrom: 'tool_result' | 'tool_input';
}

function inferHumanInterventionRequirement(
  toolName: string,
  input: Record<string, any>,
  result: string,
): HumanInterventionRequirement | null {
  const command = String(input.command || input.cmd || '').trim();
  const resultText = String(result || '');

  const explicitMarker = resultText.match(/^\[(?:Needs human|Human intervention required)\]\s*(.+)$/i);
  if (explicitMarker) {
    return {
      type: inferInterventionType(explicitMarker[1]),
      summary: explicitMarker[1].trim(),
      instructions: 'Complete the required step, then return to Clawdia and click Resume.',
      target: inferTarget(toolName, input),
      detectedFrom: 'tool_result',
    };
  }

  if (toolName === 'shell_exec' && /\b(?:sudo|passwd|su)\b/i.test(command)) {
    return {
      type: 'password',
      summary: `Human intervention required for interactive command: ${truncate(command, 120)}`,
      instructions: 'Complete the password or confirmation step in the target environment, then return and click Resume.',
      target: command,
      detectedFrom: 'tool_input',
    };
  }

  if (/(captcha|two-factor|2fa|one-time code|verification code|enter the code)/i.test(resultText)) {
    return {
      type: /(captcha)/i.test(resultText) ? 'captcha' : 'otp',
      summary: truncate(resultText.replace(/^\[Error\]\s*/i, '').trim() || 'Human intervention required', 180),
      instructions: 'Complete the verification step, then return to Clawdia and click Resume.',
      target: inferTarget(toolName, input),
      detectedFrom: 'tool_result',
    };
  }

  return null;
}

function inferInterventionType(value: string): HumanInterventionRequirement['type'] {
  if (/captcha/i.test(value)) return 'captcha';
  if (/(two-factor|2fa|otp|verification code|one-time code)/i.test(value)) return 'otp';
  if (/password/i.test(value)) return 'password';
  if (/(dialog|confirm)/i.test(value)) return 'native_dialog';
  return 'unknown';
}

function inferTarget(toolName: string, input: Record<string, any>): string | undefined {
  if (toolName === 'shell_exec') return String(input.command || input.cmd || '').trim() || undefined;
  if ('path' in input && typeof input.path === 'string') return input.path;
  if ('url' in input && typeof input.url === 'string') return input.url;
  if ('target' in input && typeof input.target === 'string') return input.target;
  return toolName;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

// ═══════════════════════════════════
// Input Summarizer (for activity display)
// ═══════════════════════════════════

export function summarizeInput(toolName: string, input: Record<string, any>): string {
  switch (toolName) {
    case 'shell_exec': return input.command?.slice(0, 80) || '';
    case 'file_read': return input.path || '';
    case 'file_write': return input.path || '';
    case 'file_edit': return input.path || '';
    case 'directory_tree': return input.path || '';
    case 'fs_quote_lookup': return `${input.rootPath || input.path || ''} :: "${input.query?.slice(0, 50) || ''}"`;
    case 'fs_folder_summary': return input.path || input.rootPath || '';
    case 'fs_reorg_plan': return input.path || input.rootPath || '';
    case 'fs_duplicate_scan': return input.path || input.rootPath || '';
    case 'fs_apply_plan': return `${input.moves?.length || 0} move(s)`;
    case 'browser_search': return `"${input.query}"` || '';
    case 'browser_navigate': return input.url || '';
    case 'browser_click': return input.target || '';
    case 'browser_type': return input.text?.slice(0, 40) || '';
    case 'browser_extract': return input.instruction?.slice(0, 60) || '';
    case 'browser_scroll': return `${input.direction || 'down'}${input.amount ? ` ${input.amount}px` : ''}`;
    case 'create_document': return input.filename || '';
    case 'memory_search': return input.query || '';
    case 'memory_store': return `${input.category}/${input.key}` || '';
    case 'app_control': return `${input.app} ${input.command?.slice(0, 50) || ''}`;
    case 'gui_interact': {
      if (input.action === 'batch_actions') return `batch (${input.actions?.length || 0} steps)`;
      return `${input.action}${input.window ? ` "${input.window}"` : ''}${input.x != null ? ` (${input.x},${input.y})` : ''}`;
    }
    case 'dbus_control': return `${input.action}${input.service ? ` ${input.service.split('.').pop()}` : ''}${input.method ? `.${input.method}` : ''}`;
    default: return JSON.stringify(input).slice(0, 60);
  }
}

function inferSurface(toolName: string): string {
  if (toolName.startsWith('browser_')) return 'browser';
  if (toolName === 'gui_interact' || toolName === 'app_control' || toolName === 'dbus_control') return 'desktop';
  if (toolName === 'shell_exec') return 'shell';
  if (toolName.startsWith('file_') || toolName.startsWith('fs_') || toolName === 'directory_tree') return 'filesystem';
  if (toolName.startsWith('memory_') || toolName === 'recall_context') return 'memory';
  if (toolName === 'create_document') return 'document';
  return 'agent';
}

function captureFileBefore(toolName: string, input: Record<string, any>): { path: string; content: string | null; existed: boolean } | null {
  if ((toolName !== 'file_write' && toolName !== 'file_edit') || !input.path) return null;

  try {
    const content = fs.readFileSync(input.path, 'utf-8');
    return { path: input.path, content, existed: true };
  } catch {
    return { path: input.path, content: null, existed: false };
  }
}

function persistStructuredChange(
  runId: string,
  eventId: number | undefined,
  toolName: string,
  input: Record<string, any>,
  fileBefore: { path: string; content: string | null; existed: boolean } | null,
): void {
  if (!fileBefore) return;

  try {
    const after = fs.readFileSync(fileBefore.path, 'utf-8');
    const changeType = fileBefore.existed ? 'file_edit' : 'file_create';
    const summary = toolName === 'file_edit'
      ? `Edited ${fileBefore.path}`
      : `Wrote ${fileBefore.path}`;
    const diffText = buildTextDiff(fileBefore.content, after);

    createRunChange({
      runId,
      eventId,
      changeType,
      target: fileBefore.path,
      summary,
      diffText,
    });
  } catch {
    // Non-fatal: if the file is unreadable after mutation, the run event log still exists.
  }
}
