/**
 * Loop Dispatch — Parallel tool dispatch with batching.
 *
 * Partitions tool-use blocks into ordered batches and dispatches each
 * batch concurrently. Sequential tools (GUI, shell) get their own batch.
 * Includes mid-loop escalation, verification, and deviation tracking.
 *
 * Extracted from loop.ts for testability and separation of concerns.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { executeTool, isKnownTool, getToolsForGroup, filterTools } from './tool-builder';
import { resolveVerificationRule, verify, logVerification, type VerificationResult } from './verification';
import { recordSurfaceDeviation, type ExecutionPlan } from '../db/app-registry';
import { appendRunEvent } from '../db/run-events';
import { buildTextDiff, createRunChange } from '../db/run-changes';
import { maybeRequireApproval, requestApproval, waitForApproval } from './approval-manager';
import * as fs from 'fs';

// ═══════════════════════════════════
// Batch Partitioning
// ═══════════════════════════════════

const SEQUENTIAL_TOOLS = new Set([
  'gui_interact', 'app_control', 'dbus_control', 'shell_exec',
]);

/**
 * Partition tool-use blocks into ordered batches for parallel dispatch.
 * Each batch can be dispatched with Promise.all.
 *
 * A batch boundary is inserted when:
 *   - A sequential tool is encountered (GUI/shell — order matters)
 *   - A tool's input references the name of a previous tool
 */
export function partitionIntoBatches(
  blocks: Anthropic.ToolUseBlock[],
): Anthropic.ToolUseBlock[][] {
  const batches: Anthropic.ToolUseBlock[][] = [];
  let current: Anthropic.ToolUseBlock[] = [];
  const seenNames: string[] = [];

  for (const block of blocks) {
    const isSeq = SEQUENTIAL_TOOLS.has(block.name);
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
  directory_tree: 5_000, browser_search: 5_000, browser_navigate: 10_000,
  browser_read_page: 10_000, browser_click: 5_000, browser_type: 500,
  browser_extract: 10_000, browser_screenshot: 1_000, browser_scroll: 10_000,
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
  tools: Anthropic.Tool[];
  executionPlan: ExecutionPlan | null;
  toolGroup: string;
  escalatedToFull: boolean;
  toolCallCount: number;
  allToolCalls: { name: string; status: string; detail?: string; input?: Record<string, any> }[];
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
  toolUseBlocks: Anthropic.ToolUseBlock[],
  ctx: DispatchContext,
): Promise<Anthropic.ToolResultBlockParam[]> {
  const batches = partitionIntoBatches(toolUseBlocks);
  const parallelBatchCount = batches.filter(b => b.length > 1).length;
  if (parallelBatchCount > 0) {
    console.log(`[Agent] Parallel dispatch: ${toolUseBlocks.length} tools → ${batches.length} batch(es), ${parallelBatchCount} parallel`);
  }

  const toolResults: Anthropic.ToolResultBlockParam[] = [];

  for (const batch of batches) {
    const batchResults = await Promise.all(batch.map(async (toolUse) => {
      ctx.toolCallCount++;
      const startMs = Date.now();
      const detail = summarizeInput(toolUse.name, toolUse.input as any);
      const surface = inferSurface(toolUse.name);
      const fileBefore = captureFileBefore(toolUse.name, toolUse.input as Record<string, any>);
      const approvalRequirement = maybeRequireApproval(toolUse.name, toolUse.input as Record<string, any>);

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
        if (approvalRequirement && ctx.runId) {
          const approval = requestApproval(ctx.runId, {
            ...approvalRequirement,
            request: {
              ...(approvalRequirement.request || {}),
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
            result = await executeApprovedTool(toolUse, ctx, surface);
          }
        } else {
          result = await executeApprovedTool(toolUse, ctx, surface);
        }
      } catch (err: any) {
        result = `[Error] ${err.message}`;
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
          result = await executeApprovedTool(toolUse, ctx, surface);
        } catch (err: any) {
          result = `[Error] ${err.message}`;
        }
      }

      const durationMs = Date.now() - startMs;
      const status = result.startsWith('[Error') || result.startsWith('[Approval denied]') ? 'error' : 'success';

      ctx.onToolActivity?.({ name: toolUse.name, status, detail });
      ctx.allToolCalls.push({ name: toolUse.name, status, detail, input: toolUse.input as Record<string, any> });
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
            resultPreview: result.slice(0, 500),
            status,
          },
        });
      }
      console.log(`[Agent] Result (${durationMs}ms): ${result.slice(0, 200)}`);

      if (ctx.runId && status === 'success') {
        persistStructuredChange(ctx.runId, completionEventId, toolUse.name, toolUse.input as Record<string, any>, fileBefore);
      }

      // Post-action verification
      if (status === 'success') {
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

      // Cap result length
      const cap = TOOL_RESULT_CAPS[toolUse.name] || DEFAULT_RESULT_CAP;
      if (result.length > cap) {
        result = result.slice(0, cap) + `\n\n[Truncated — ${result.length} chars, showing first ${cap}]`;
      }

      return { id: toolUse.id, content: result } as const;
    }));

    for (const r of batchResults) {
      toolResults.push({ type: 'tool_result', tool_use_id: r.id, content: r.content });
    }
  }

  return toolResults;
}

async function executeApprovedTool(
  toolUse: Anthropic.ToolUseBlock,
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

  return executeTool(toolUse.name, toolUse.input as any, chunkCb);
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
  if (toolName.startsWith('file_') || toolName === 'directory_tree') return 'filesystem';
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
