/**
 * Agent Spawn Executor — Runs a sub-agent with an isolated context.
 *
 * Each spawned agent gets:
 *   - Its own runId (child-${parentRunId}-${index})
 *   - A scoped role profile (scout, builder, analyst, etc.)
 *   - A role-specific iteration budget enforced at the child loop boundary
 *   - Clean history (no parent conversation bleed)
 *   - Its own AbortController tied to the parent's signal
 *
 * Returns the sub-agent's final text response as a string.
 */

import { runAgentLoop } from './loop';
import { getApiKey, getSelectedProvider, getSelectedModel } from '../store';
import { IPC_EVENTS } from '../../shared/ipc-channels';
import type { AgentProfile, SwarmAgent, SwarmState } from '../../shared/types';
import type { BrowserWindow } from 'electron';
import { allocateIsolatedTab, releaseIsolatedTab } from '../browser/manager';

// ─── Swarm State Registry ─────────────────────────────────────────────────────

const activeSwarms = new Map<string, SwarmState>();
let mainWindow: BrowserWindow | null = null;

export function initAgentSpawnExecutor(win: BrowserWindow): void {
  mainWindow = win;
}

function broadcastSwarm(runId: string): void {
  const state = activeSwarms.get(runId);
  if (!state || !mainWindow) return;
  mainWindow.webContents.send(IPC_EVENTS.SWARM_STATE_CHANGED, state);
}

export function getSwarmState(runId: string): SwarmState | null {
  return activeSwarms.get(runId) ?? null;
}

export function getAllActiveSwarms(): SwarmState[] {
  return [...activeSwarms.values()].filter(s => !s.completedAt || Date.now() - s.completedAt < 30_000);
}

// ─── Role → Profile mapping ───────────────────────────────────────────────────

// Maps the role string the coordinator sends to our AgentProfile union.
const VALID_ROLES: AgentProfile[] = [
  'scout', 'builder', 'analyst', 'writer', 'reviewer',
  'data', 'devops', 'security', 'synthesizer', 'general', 'filesystem',
];

function resolveRole(role: string): AgentProfile {
  const lower = role.toLowerCase() as AgentProfile;
  return VALID_ROLES.includes(lower) ? lower : 'general';
}

// ─── Token Budget per role ────────────────────────────────────────────────────

const ROLE_MAX_ITERATIONS: Partial<Record<AgentProfile, number>> = {
  scout: 8,
  analyst: 10,
  writer: 8,
  reviewer: 6,
  data: 10,
  devops: 12,
  security: 10,
  synthesizer: 8,
  builder: 15,
  general: 12,
  filesystem: 12,
};

// ─── Single Sub-Agent Runner ──────────────────────────────────────────────────

export interface SpawnOptions {
  parentRunId: string;
  agentIndex: number;
  role: string;
  goal: string;
  context?: string;       // optional extra context to pass to the sub-agent
  signal?: AbortSignal;  // parent's abort signal
}

export function getRoleMaxIterations(role: string): number {
  const resolvedRole = resolveRole(role);
  return ROLE_MAX_ITERATIONS[resolvedRole] ?? ROLE_MAX_ITERATIONS.general ?? 12;
}

export async function spawnAgent(opts: SpawnOptions): Promise<{ result: string; toolCallCount: number }> {
  const { parentRunId, agentIndex, role, goal, context, signal } = opts;
  const resolvedRole = resolveRole(role);
  const subRunId = `${parentRunId}-sub${agentIndex}-${resolvedRole}`;
  const maxIterations = getRoleMaxIterations(resolvedRole);

  // Build the agent's message — goal + any extra context
  const agentMessage = context
    ? `${goal}\n\n[Context from coordinator]: ${context}`
    : goal;

  const provider = getSelectedProvider();
  const apiKey = getApiKey(provider);
  // Scouts/reviewers/writers use haiku for cost efficiency; builders/devops get full sonnet
  const heavyRoles: AgentProfile[] = ['builder', 'devops', 'security', 'data'];
  const modelTier = heavyRoles.includes(resolvedRole) ? undefined : 'haiku';

  // Get swarm entry for this agent
  const swarm = activeSwarms.get(parentRunId);
  const agentEntry = swarm?.agents.find(a => a.id === subRunId);
  if (agentEntry) {
    agentEntry.status = 'running';
    agentEntry.startedAt = Date.now();
    broadcastSwarm(parentRunId);
  }

  let result = '';
  let toolCallCount = 0;

  try {
    if (signal?.aborted) {
      if (agentEntry) {
        agentEntry.status = 'cancelled';
        agentEntry.completedAt = Date.now();
        broadcastSwarm(parentRunId);
      }
      return { result: '[Cancelled by parent run]', toolCallCount: 0 };
    }
    allocateIsolatedTab(subRunId);
    const loopResult = await runAgentLoop(
      agentMessage,
      [], // clean history — no parent bleed
      {
        runId: subRunId,
        provider,
        apiKey,
        forcedAgentProfile: resolvedRole,
        graphExecutionMode: 'disabled',
        parentSignal: signal,
        maxIterations,
        model: modelTier, // undefined = use stored model (sonnet)
        onStreamText: (text) => { result += text; },
        onToolActivity: () => { toolCallCount++; },
      },
    );

    result = loopResult.response || result;
    toolCallCount = loopResult.toolCalls.length;

    if (agentEntry) {
      agentEntry.status = signal?.aborted || result.startsWith('[Cancelled') ? 'cancelled' : 'done';
      agentEntry.completedAt = Date.now();
      agentEntry.toolCallCount = toolCallCount;
      agentEntry.result = result.slice(0, 300);
      broadcastSwarm(parentRunId);
    }

    return { result, toolCallCount };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    if (agentEntry) {
      agentEntry.status = signal?.aborted ? 'cancelled' : 'failed';
      agentEntry.completedAt = Date.now();
      agentEntry.error = errMsg.slice(0, 200);
      broadcastSwarm(parentRunId);
    }
    return {
      result: signal?.aborted ? '[Cancelled by parent run]' : `[Agent ${resolvedRole} failed: ${errMsg}]`,
      toolCallCount,
    };
  } finally {
    releaseIsolatedTab(subRunId);
  }
}

// ─── Batch Spawn ──────────────────────────────────────────────────────────────

export interface AgentTask {
  role: string;
  goal: string;
  context?: string;
}

export interface SwarmResult {
  results: Array<{ role: string; goal: string; result: string; toolCallCount: number }>;
  totalToolCalls: number;
  durationMs: number;
  agentCount: number;
}

/**
 * Spawn a swarm of agents in parallel, collect all results.
 * The parent's runId is used to track the swarm state.
 */
export async function spawnSwarm(
  parentRunId: string,
  tasks: AgentTask[],
  signal?: AbortSignal,
): Promise<SwarmResult> {
  const startedAt = Date.now();
  const capped = tasks.slice(0, 20); // hard cap at 20

  // Register swarm state
  const swarmState: SwarmState = {
    runId: parentRunId,
    totalAgents: capped.length,
    startedAt,
    agents: capped.map((task, i) => ({
      id: `${parentRunId}-sub${i}-${resolveRole(task.role)}`,
      role: resolveRole(task.role),
      goal: task.goal.slice(0, 100),
      status: 'queued' as const,
      toolCallCount: 0,
    })),
  };
  activeSwarms.set(parentRunId, swarmState);
  broadcastSwarm(parentRunId);

  // Run all agents in parallel
  const settled = await Promise.allSettled(
    capped.map((task, i) =>
      spawnAgent({
        parentRunId,
        agentIndex: i,
        role: task.role,
        goal: task.goal,
        context: task.context,
        signal,
      }),
    ),
  );

  const results = settled.map((s, i) => ({
    role: capped[i].role,
    goal: capped[i].goal,
    result: s.status === 'fulfilled' ? s.value.result : `[Failed: ${(s as any).reason?.message || 'unknown'}]`,
    toolCallCount: s.status === 'fulfilled' ? s.value.toolCallCount : 0,
  }));

  const totalToolCalls = results.reduce((sum, r) => sum + r.toolCallCount, 0);

  // Mark swarm complete
  swarmState.completedAt = Date.now();
  broadcastSwarm(parentRunId);

  // Auto-cleanup after 60s
  setTimeout(() => activeSwarms.delete(parentRunId), 60_000);

  return {
    results,
    totalToolCalls,
    durationMs: Date.now() - startedAt,
    agentCount: capped.length,
  };
}
