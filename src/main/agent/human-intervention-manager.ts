import { Notification } from 'electron';
import { appendRunEvent } from '../db/run-events';
import {
  createRunHumanIntervention,
  getRunHumanInterventionRecord,
  listRunHumanInterventionRecords,
  resolveRunHumanIntervention,
  type CreateRunHumanInterventionInput,
  type RunHumanInterventionRecord,
} from '../db/run-human-interventions';
import { setProcessStatus } from './process-manager';

type InterventionDecision = 'resolved' | 'dismissed';

const pending = new Map<number, { runId: string; resolve: (decision: InterventionDecision) => void }>();

export function requestHumanIntervention(
  runId: string,
  request: CreateRunHumanInterventionInput,
): RunHumanInterventionRecord {
  const record = createRunHumanIntervention(runId, request);
  setProcessStatus(runId, 'needs_human');
  appendRunEvent(runId, {
    kind: 'human_intervention_requested',
    phase: 'human',
    payload: {
      interventionId: record.id,
      interventionType: record.interventionType,
      target: record.target,
      summary: record.summary,
      instructions: record.instructions,
      request: record.request,
    },
  });

  if (Notification.isSupported()) {
    new Notification({
      title: 'Clawdia needs you',
      body: record.summary,
      urgency: 'critical',
      silent: false,
    }).show();
  }

  return record;
}

export function waitForHumanIntervention(interventionId: number): Promise<InterventionDecision> {
  const record = getRunHumanInterventionRecord(interventionId);
  return new Promise<InterventionDecision>((resolve) => {
    pending.set(interventionId, { runId: record?.runId || '', resolve });
  });
}

export function resolveHumanIntervention(interventionId: number): RunHumanInterventionRecord | null {
  return settleIntervention(interventionId, 'resolved');
}

export function dismissHumanIntervention(interventionId: number): RunHumanInterventionRecord | null {
  return settleIntervention(interventionId, 'dismissed');
}

export function listHumanInterventionsForRun(runId: string): RunHumanInterventionRecord[] {
  return listRunHumanInterventionRecords(runId);
}

export function cancelPendingHumanInterventions(
  runId?: string,
  reason = 'Run cancelled while awaiting human intervention.',
): void {
  for (const interventionId of [...pending.keys()]) {
    const pendingEntry = pending.get(interventionId);
    if (runId && pendingEntry?.runId !== runId) continue;
    const record = getRunHumanInterventionRecord(interventionId);
    if (!record || record.status !== 'pending') continue;
    const dismissed = resolveRunHumanIntervention(interventionId, 'dismissed');
    if (!dismissed) continue;
    setProcessStatus(dismissed.runId, 'running');
    appendRunEvent(dismissed.runId, {
      kind: 'human_intervention_resolved',
      phase: 'human',
      payload: {
        interventionId: dismissed.id,
        decision: 'dismissed',
        summary: dismissed.summary,
        reason,
      },
    });
    pendingEntry?.resolve('dismissed');
    pending.delete(interventionId);
  }
}

/**
 * Poll the BrowserView's webContents to detect when a DOM blocker is resolved.
 * Uses executeJavaScript polling — consistent with waits.ts patterns.
 * When the selector disappears (or page navigates), calls resolveHumanIntervention.
 *
 * @param view         The BrowserView currently showing the blocked page
 * @param interventionId  The ID of the pending intervention record
 * @param blockerSelector CSS selector for the element that indicates the blocker is present.
 *                        When this element is gone, the blocker is resolved.
 * @param timeoutMs    Max time to wait before giving up (default 10 minutes)
 */
export async function watchForInterventionResolution(
  view: import('electron').BrowserView,
  interventionId: number,
  blockerSelector: string,
  timeoutMs = 10 * 60 * 1_000,
): Promise<'resolved' | 'timeout'> {
  const { wait } = await import('../browser/waits');
  const deadline = Date.now() + timeoutMs;
  const wc = view.webContents;

  while (Date.now() < deadline) {
    if (wc.isDestroyed()) break;
    try {
      const blockerStillPresent = await wc.executeJavaScript(`
        (() => !!document.querySelector(${JSON.stringify(blockerSelector)}))()
      `);
      if (!blockerStillPresent) {
        resolveHumanIntervention(interventionId);
        return 'resolved';
      }
    } catch {
      // Page navigated or context destroyed — treat as resolved
      resolveHumanIntervention(interventionId);
      return 'resolved';
    }
    await wait(1_000);
  }

  return 'timeout';
}

function settleIntervention(
  interventionId: number,
  decision: InterventionDecision,
): RunHumanInterventionRecord | null {
  const record = resolveRunHumanIntervention(interventionId, decision);
  if (!record) return getRunHumanInterventionRecord(interventionId);

  setProcessStatus(record.runId, 'running');
  appendRunEvent(record.runId, {
    kind: 'human_intervention_resolved',
    phase: 'human',
    payload: {
      interventionId: record.id,
      decision,
      summary: record.summary,
      instructions: record.instructions,
    },
  });

  pending.get(interventionId)?.resolve(decision);
  pending.delete(interventionId);
  return record;
}
