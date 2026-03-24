/**
 * Bloodhound Recorder — post-run sequence capture pipeline.
 *
 * Called from completeRun() after a run finishes. Checks recording
 * thresholds, distills run_events into SequenceStep[], and persists
 * to task_sequences. Async LLM distillation and embedding are
 * fire-and-forget — failures are logged and ignored.
 */

import { getRun } from '../../db/runs';
import type { RunStatus } from '../../db/runs';
import { getRunEventRecords } from '../../db/run-events';
import { insertTaskSequence, updateTaskSequenceSteps, updateTaskSequenceEmbedding } from '../../db/task-sequences';
import type { Surface } from '../../db/task-sequences';
import { distillSteps, distillWithLLM } from './distiller';
import { embedGoal } from './embedder';

const MIN_TOOL_CALLS = 3;
const MIN_DURATION_MS = 15_000;

export async function maybeRecordSequence(
  runId: string,
  status: RunStatus,
): Promise<void> {
  try {
    const run = getRun(runId);
    if (!run) return;

    const events = getRunEventRecords(runId);
    const steps = distillSteps(events);

    const successfulSteps = steps.filter(s => s.success).length;
    // RunRow fields are snake_case (raw DB row)
    const durationMs = run.completed_at
      ? new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()
      : Date.now() - new Date(run.started_at).getTime();

    const surfaces = [...new Set(steps.map(s => s.surface))] as Surface[];
    const hasSwarm = events.some(e => e.kind === 'tool_started' && e.toolName === 'agent_spawn');

    const meetsThreshold =
      run.tool_call_count >= MIN_TOOL_CALLS ||
      surfaces.length >= 2 ||
      hasSwarm ||
      durationMs > MIN_DURATION_MS;

    if (!meetsThreshold) return;

    const isFailedOrCancelled = status === 'cancelled' || status === 'failed';
    if (isFailedOrCancelled && successfulSteps === 0) return;

    const outcome = status === 'completed' ? 'success' : 'partial';

    const goal = run.goal || run.title || '';

    const sequenceId = insertTaskSequence({
      runId,
      goal,
      surfaces,
      steps,
      outcome,
      toolCallCount: run.tool_call_count,
      durationMs,
      createdAt: new Date().toISOString(),
    });

    setImmediate(() => {
      distillWithLLM(goal, steps)
        .then(improved => updateTaskSequenceSteps(sequenceId, improved))
        .catch(err => console.warn('[Bloodhound] distillWithLLM failed:', err.message));
    });

    setImmediate(() => {
      embedGoal(goal)
        .then(vec => updateTaskSequenceEmbedding(sequenceId, vec))
        .catch(err => console.warn('[Bloodhound] embedGoal failed:', err.message));
    });

  } catch (err: any) {
    console.warn('[Bloodhound] maybeRecordSequence failed:', err.message);
  }
}
