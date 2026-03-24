/**
 * Process Manager — Tracks agent processes for the Cursor-style UX.
 *
 * Pattern:
 *   1. User sends a message → loop starts → attached (streaming to renderer)
 *   2. User clicks "Detach" → loop keeps running, events buffered
 *   3. User starts new chat → new loop starts attached
 *   4. Old loop completes in background → shows in process list
 *   5. User clicks process → loads conversation from DB
 *
 * Multiple loops may run concurrently.
 * The process manager tracks which one is currently attached to the chat surface,
 * routes live events for that run, and keeps background history for the rest.
 */

import type { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import {
  completeRun,
  createRun,
  deleteRun,
  evictOldRuns,
  getRun,
  incrementRunToolCount,
  listRuns,
  reconcileInterruptedRuns,
  setRunExecutionInfo,
  setRunStatus,
  setRunDetached,
  setRunWorkflowStage,
} from '../db/runs';
import { reconcilePendingRunApprovals } from '../db/run-approvals';
import { reconcilePendingRunHumanInterventions } from '../db/run-human-interventions';
import { appendRunEvent, getLastSpecializedTool, getRunAgentProfile } from '../db/run-events';
import { clearRunFileState, initFileLockManager } from './file-lock-manager';
import { setBrowserExecutionMode } from '../browser/manager';
import type { AgentProfile, ProviderId, WorkflowStage } from '../../shared/types';
import { createStreamBatcher, type StreamBatcher } from './stream-batcher';
import { finalizeRunAudit } from './system-audit';

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export type ProcessStatus = 'running' | 'awaiting_approval' | 'needs_human' | 'completed' | 'failed' | 'cancelled';

export interface ProcessInfo {
  id: string;
  conversationId: string;
  status: ProcessStatus;
  summary: string;
  startedAt: number;
  completedAt?: number;
  toolCallCount: number;
  error?: string;
  isAttached: boolean;
  wasDetached: boolean;
  provider?: ProviderId;
  model?: string;
  agentProfile?: AgentProfile;
  lastSpecializedTool?: string;
  workflowStage?: WorkflowStage;
}

interface InternalProcess extends ProcessInfo {
  outputBuffer: Array<{ type: string; data: any }>;
}

// ═══════════════════════════════════
// State
// ═══════════════════════════════════

const processes: Map<string, InternalProcess> = new Map();
let attachedId: string | null = null;
let win: BrowserWindow | null = null;
const MAX_HISTORY = 20;
const MAX_BUFFER = 1500;

// Per-process stream batcher: coalesces CHAT_STREAM_TEXT chunks into 16ms windows
const streamBatchers: Map<string, StreamBatcher> = new Map();

// ═══════════════════════════════════
// Init
// ═══════════════════════════════════

export function initProcessManager(mainWindow: BrowserWindow): void {
  win = mainWindow;
  reconcileInterruptedRuns();
  reconcilePendingRunApprovals();
  reconcilePendingRunHumanInterventions();
  initFileLockManager();
  hydratePersistedRuns();
  broadcast();
}

// ═══════════════════════════════════
// Lifecycle
// ═══════════════════════════════════

/**
 * Register a new process when the agent loop starts.
 * Called from the CHAT_SEND handler in main.ts.
 */
export function registerProcess(conversationId: string, message: string, provider?: ProviderId, model?: string): string {
  const id = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  if (attachedId) {
    const previous = processes.get(attachedId);
    if (previous && (previous.status === 'running' || previous.status === 'awaiting_approval' || previous.status === 'needs_human')) {
      previous.isAttached = false;
      previous.wasDetached = true;
      setRunDetached(previous.id, true);
      setBrowserExecutionMode('headless', 'run_detached');
      appendRunEvent(previous.id, {
        kind: 'run_detached',
        phase: 'lifecycle',
        payload: { reason: 'Switched to a new active chat' },
      });
      appendRunEvent(previous.id, {
        kind: 'browser_mode_changed',
        phase: 'browser',
        payload: { mode: 'headless', reason: 'run_detached' },
      });
    }
  }

  const proc: InternalProcess = {
    id,
    conversationId,
    status: 'running',
    summary: message.length > 80 ? message.slice(0, 77) + '...' : message,
    startedAt: Date.now(),
    toolCallCount: 0,
    isAttached: true,
    wasDetached: false,
    provider,
    model,
    agentProfile: undefined,
    lastSpecializedTool: undefined,
    workflowStage: 'starting',
    outputBuffer: [],
  };

  processes.set(id, proc);
  createRun(id, conversationId, message, provider, model);
  setBrowserExecutionMode('headed', 'run_attached');
  appendRunEvent(id, {
    kind: 'run_started',
    phase: 'lifecycle',
    payload: { conversationId, goal: message },
  });
  appendRunEvent(id, {
    kind: 'browser_mode_changed',
    phase: 'browser',
    payload: { mode: 'headed', reason: 'run_attached' },
  });
  attachedId = id;
  broadcast();
  return id;
}

/**
 * Mark a process as completed/failed.
 * Called when runAgentLoop resolves or rejects.
 */
export function completeProcess(processId: string, status: 'completed' | 'failed' | 'cancelled', error?: string): void {
  const proc = processes.get(processId);
  if (!proc) {
    completeRun(processId, status, error);
    finalizeRunAudit(processId, status);
    evictOldRuns(MAX_HISTORY);
    return;
  }
  proc.status = status;
  proc.completedAt = Date.now();
  if (error) proc.error = error;
  completeRun(processId, status, error);
  clearRunFileState(processId);
  // Flush any buffered stream text before completing
  streamBatchers.get(processId)?.flushImmediate();
  streamBatchers.delete(processId);
  appendRunEvent(processId, {
    kind: status === 'completed' ? 'run_completed' : status === 'cancelled' ? 'run_cancelled' : 'run_failed',
    phase: 'lifecycle',
    payload: { error },
  });
  finalizeRunAudit(processId, status);

  // If this was attached and completed, auto-detach so user isn't stuck
  // (they might have already started a new chat)
  if (attachedId === processId && status !== 'completed') {
    // Keep attached on success so the response streams through
  }

  broadcast();
  evictOld();

  const dur = ((proc.completedAt - proc.startedAt) / 1000).toFixed(1);
  console.log(`[Process] ${processId} ${status} (${proc.toolCallCount} tools, ${dur}s)`);
}

/**
 * Increment tool call count for a running process.
 */
export function recordToolCall(processId: string): void {
  const proc = processes.get(processId);
  if (proc) proc.toolCallCount++;
  incrementRunToolCount(processId);
}

export function setProcessAgentProfile(processId: string, agentProfile: AgentProfile): boolean {
  const proc = processes.get(processId);
  if (!proc) return false;
  if (proc.agentProfile === agentProfile) return true;
  proc.agentProfile = agentProfile;
  broadcast();
  return true;
}

export function setProcessExecutionInfo(processId: string, provider: ProviderId, model: string): boolean {
  const proc = processes.get(processId);
  if (!proc) {
    setRunExecutionInfo(processId, provider, model);
    return false;
  }
  proc.provider = provider;
  proc.model = model;
  setRunExecutionInfo(processId, provider, model);
  broadcast();
  return true;
}

export function noteProcessSpecializedTool(processId: string, toolName: string): boolean {
  const proc = processes.get(processId);
  if (!proc || !toolName.startsWith('fs_')) return false;
  proc.lastSpecializedTool = toolName;
  broadcast();
  return true;
}

export function setProcessWorkflowStage(processId: string, workflowStage: WorkflowStage): boolean {
  const proc = processes.get(processId);
  if (!proc) {
    setRunWorkflowStage(processId, workflowStage);
    return false;
  }
  proc.workflowStage = workflowStage;
  setRunWorkflowStage(processId, workflowStage);
  broadcast();
  return true;
}

export function setProcessStatus(
  processId: string,
  status: Extract<ProcessStatus, 'running' | 'awaiting_approval' | 'needs_human'>,
  error?: string,
): boolean {
  const proc = processes.get(processId);
  if (!proc) {
    setRunStatus(processId, status, error);
    return false;
  }

  proc.status = status;
  if (error) proc.error = error;
  setRunStatus(processId, status, error);
  if (proc.id === attachedId && status === 'needs_human') {
    setBrowserExecutionMode('persistent_session', 'needs_human');
    appendRunEvent(processId, {
      kind: 'browser_mode_changed',
      phase: 'browser',
      payload: { mode: 'persistent_session', reason: 'needs_human' },
    });
  }
  broadcast();
  return true;
}

/**
 * Detach the current process to background.
 * Events will be buffered instead of sent to renderer.
 * Returns the detached process ID.
 */
export function detachCurrent(): string | null {
  const id = attachedId;
  if (!id) return null;

  const proc = processes.get(id);
  if (proc) {
    proc.isAttached = false;
    proc.wasDetached = true;
    setRunDetached(id, true);
  }
  attachedId = null;
  setBrowserExecutionMode('headless', 'run_detached');
  appendRunEvent(id, {
    kind: 'run_detached',
    phase: 'lifecycle',
    payload: {},
  });
  appendRunEvent(id, {
    kind: 'browser_mode_changed',
    phase: 'browser',
    payload: { mode: 'headless', reason: 'run_detached' },
  });

  broadcast();
  console.log(`[Process] Detached ${id} to background`);
  return id;
}

/**
 * Attach to a process — switch the renderer to show it.
 * Returns buffered events for replay.
 */
export function attachTo(processId: string): { process: ProcessInfo; buffer: Array<{ type: string; data: any }> } | null {
  const proc = processes.get(processId);
  if (!proc) return null;

  // Detach current if any
  if (attachedId && attachedId !== processId) {
    const current = processes.get(attachedId);
    if (current) current.isAttached = false;
  }

  attachedId = processId;
  proc.isAttached = true;
  const mode = proc.status === 'needs_human' ? 'persistent_session' : 'headed';
  setBrowserExecutionMode(mode, 'run_attached');
  broadcast();
  appendRunEvent(processId, {
    kind: 'run_attached',
    phase: 'lifecycle',
    payload: { bufferedEventCount: proc.outputBuffer.length },
  });
  appendRunEvent(processId, {
    kind: 'browser_mode_changed',
    phase: 'browser',
    payload: { mode, reason: 'run_attached' },
  });

  console.log(`[Process] Attached to ${processId} (${proc.outputBuffer.length} buffered events)`);
  return { process: serialize(proc), buffer: [...proc.outputBuffer] };
}

/**
 * Route an event from the agent loop. If the process is attached,
 * send to renderer. Always buffer.
 *
 * CHAT_STREAM_TEXT chunks are micro-batched into 16ms windows before
 * sending to reduce IPC overhead during high-frequency token streaming.
 * All other events are sent immediately.
 */
export function routeEvent(processId: string, ipcChannel: string, data: any): void {
  const proc = processes.get(processId);
  if (!proc) return;

  // Buffer (with cap)
  proc.outputBuffer.push({ type: ipcChannel, data });
  if (proc.outputBuffer.length > MAX_BUFFER) {
    proc.outputBuffer = proc.outputBuffer.slice(-MAX_BUFFER + 500);
  }

  if (processId !== attachedId || !win) return;

  // Stream text: coalesce chunks within a 16ms window into one IPC send
  if (ipcChannel === IPC_EVENTS.CHAT_STREAM_TEXT && typeof data === 'string') {
    let batcher = streamBatchers.get(processId);
    if (!batcher) {
      batcher = createStreamBatcher((combined) => {
        win?.webContents.send(IPC_EVENTS.CHAT_STREAM_TEXT, combined);
      }, 16);
      streamBatchers.set(processId, batcher);
    }
    batcher.push(data);
    return;
  }

  // Stream end: flush any buffered text first, then send the end event
  if (ipcChannel === IPC_EVENTS.CHAT_STREAM_END) {
    streamBatchers.get(processId)?.flushImmediate();
    streamBatchers.delete(processId);
  }

  win.webContents.send(ipcChannel, data);
}

/**
 * Check if a process is currently attached (streaming to renderer).
 */
export function isAttached(processId: string): boolean {
  return attachedId === processId;
}

/**
 * Get the currently attached process ID.
 */
export function getAttachedId(): string | null {
  return attachedId;
}

/**
 * List all processes for the sidebar.
 */
export function listProcesses(): ProcessInfo[] {
  return [...processes.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(serialize);
}

/**
 * Dismiss a completed process from the list.
 */
export function dismissProcess(processId: string): boolean {
  const proc = processes.get(processId);
  const persisted = getRun(processId);
  if (
    (!proc && !persisted) ||
    proc?.status === 'running' ||
    proc?.status === 'awaiting_approval' ||
    proc?.status === 'needs_human' ||
    persisted?.status === 'running' ||
    persisted?.status === 'awaiting_approval' ||
    persisted?.status === 'needs_human'
  ) return false;
  processes.delete(processId);
  deleteRun(processId);
  if (attachedId === processId) attachedId = null;
  broadcast();
  return true;
}

/**
 * Mark a running process as cancelled.
 * The loop cancellation is handled separately by loop.ts.
 */
export function cancelProcess(processId: string): boolean {
  const proc = processes.get(processId);
  if (!proc || (proc.status !== 'running' && proc.status !== 'awaiting_approval' && proc.status !== 'needs_human')) return false;

  completeProcess(processId, 'cancelled');
  return true;
}

/**
 * Check if any process is currently running.
 */
export function hasRunningProcess(): boolean {
  return [...processes.values()].some(p => p.status === 'running' || p.status === 'awaiting_approval' || p.status === 'needs_human');
}

// ═══════════════════════════════════
// Internals
// ═══════════════════════════════════

function serialize(proc: InternalProcess): ProcessInfo {
  return {
    id: proc.id,
    conversationId: proc.conversationId,
    status: proc.status,
    summary: proc.summary,
    startedAt: proc.startedAt,
    completedAt: proc.completedAt,
    toolCallCount: proc.toolCallCount,
    error: proc.error,
    isAttached: proc.id === attachedId,
    wasDetached: proc.wasDetached,
    provider: proc.provider,
    model: proc.model,
    agentProfile: proc.agentProfile,
    lastSpecializedTool: proc.lastSpecializedTool,
    workflowStage: proc.workflowStage,
  };
}

function broadcast(): void {
  win?.webContents.send('process:list', listProcesses());
}

function evictOld(): void {
  const done = [...processes.values()]
    .filter(p => p.status !== 'running' && p.status !== 'awaiting_approval' && p.status !== 'needs_human')
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  while (done.length > MAX_HISTORY) {
    const oldest = done.pop()!;
    processes.delete(oldest.id);
  }
  evictOldRuns(MAX_HISTORY);
}

function hydratePersistedRuns(): void {
  const persisted = listRuns(MAX_HISTORY);
  processes.clear();

  for (const row of persisted) {
    processes.set(row.id, {
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status,
      summary: row.title,
      startedAt: new Date(row.started_at).getTime(),
      completedAt: row.completed_at ? new Date(row.completed_at).getTime() : undefined,
      toolCallCount: row.tool_call_count,
      error: row.error || undefined,
      isAttached: false,
      wasDetached: !!row.was_detached,
      provider: (row.provider as ProviderId | null) || undefined,
      model: row.model || undefined,
      agentProfile: getRunAgentProfile(row.id),
      lastSpecializedTool: getLastSpecializedTool(row.id),
      workflowStage: (row.workflow_stage as WorkflowStage | null) || 'starting',
      outputBuffer: [],
    });
  }
}
