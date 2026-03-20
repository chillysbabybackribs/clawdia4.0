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
