import { appendRunEvent } from '../db/run-events';
import {
  createRunApproval,
  getRunApprovalRecord,
  listRunApprovalRecords,
  resolveRunApproval,
  type RunApprovalRecord,
} from '../db/run-approvals';
import { getUnrestrictedMode } from '../store';
import { setProcessStatus } from './process-manager';

type ApprovalDecision = 'approved' | 'denied';

const pending = new Map<number, (decision: ApprovalDecision) => void>();

export interface ApprovalRequirement {
  actionType: string;
  target: string;
  summary: string;
  request?: Record<string, any>;
}

export function maybeRequireApproval(
  toolName: string,
  input: Record<string, any>,
): ApprovalRequirement | null {
  if (getUnrestrictedMode()) return null;

  if (toolName === 'shell_exec') {
    const command = String(input.command || input.cmd || '').trim();
    if (!command) return null;

    if (/\bgit\s+push\b/i.test(command)) {
      return approval('git_push', command, `Approval required before pushing changes: ${truncate(command, 120)}`, { command });
    }
    if (/\brm\s+-rf\b/i.test(command)) {
      return approval('destructive_shell', command, `Approval required before destructive delete: ${truncate(command, 120)}`, { command });
    }
    if (/\bsudo\b/i.test(command)) {
      return approval('privileged_shell', command, `Approval required before privileged command: ${truncate(command, 120)}`, { command });
    }
    if (/\b(?:npm|pnpm|yarn)\s+publish\b/i.test(command)) {
      return approval('publish', command, `Approval required before publishing: ${truncate(command, 120)}`, { command });
    }
    if (/\b(?:apt|apt-get)\s+(?:install|remove|upgrade)\b/i.test(command)) {
      return approval('system_package_change', command, `Approval required before changing system packages: ${truncate(command, 120)}`, { command });
    }
  }

  if (toolName === 'file_write' || toolName === 'file_edit') {
    const target = String(input.path || '');
    if (isSensitivePath(target)) {
      return approval(
        'sensitive_file_change',
        target,
        `Approval required before editing sensitive file: ${truncate(target, 120)}`,
        { path: target, toolName },
      );
    }
  }

  return null;
}

export function requestApproval(runId: string, requirement: ApprovalRequirement): RunApprovalRecord {
  const record = createRunApproval(runId, requirement);
  setProcessStatus(runId, 'awaiting_approval');
  appendRunEvent(runId, {
    kind: 'approval_requested',
    phase: 'approval',
    payload: {
      approvalId: record.id,
      actionType: record.actionType,
      target: record.target,
      summary: record.summary,
      request: record.request,
    },
  });
  return record;
}

export function waitForApproval(approvalId: number): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    pending.set(approvalId, resolve);
  });
}

export function approveRunApproval(approvalId: number): RunApprovalRecord | null {
  return resolveApproval(approvalId, 'approved');
}

export function denyRunApproval(approvalId: number): RunApprovalRecord | null {
  return resolveApproval(approvalId, 'denied');
}

export function listApprovalsForRun(runId: string): RunApprovalRecord[] {
  return listRunApprovalRecords(runId);
}

export function cancelPendingApprovals(reason = 'Run cancelled while awaiting approval.'): void {
  for (const approvalId of [...pending.keys()]) {
    const record = getRunApprovalRecord(approvalId);
    if (!record || record.status !== 'pending') continue;
    const denied = resolveRunApproval(approvalId, 'denied');
    if (!denied) continue;
    setProcessStatus(denied.runId, 'running');
    appendRunEvent(denied.runId, {
      kind: 'approval_resolved',
      phase: 'approval',
      payload: {
        approvalId: denied.id,
        decision: 'denied',
        summary: denied.summary,
        reason,
      },
    });
    pending.get(approvalId)?.('denied');
    pending.delete(approvalId);
  }
}

function resolveApproval(approvalId: number, decision: ApprovalDecision): RunApprovalRecord | null {
  const record = resolveRunApproval(approvalId, decision);
  if (!record) return getRunApprovalRecord(approvalId);

  setProcessStatus(record.runId, 'running');
  appendRunEvent(record.runId, {
    kind: 'approval_resolved',
    phase: 'approval',
    payload: {
      approvalId: record.id,
      decision,
      summary: record.summary,
    },
  });

  pending.get(approvalId)?.(decision);
  pending.delete(approvalId);
  return record;
}

function approval(
  actionType: string,
  target: string,
  summary: string,
  request?: Record<string, any>,
): ApprovalRequirement {
  return { actionType, target, summary, request };
}

function isSensitivePath(target: string): boolean {
  return (
    /(^|\/)\.env(?:\.[^/]+)?$/i.test(target) ||
    /(^|\/)\.npmrc$/i.test(target) ||
    /(^|\/)\.git\/config$/i.test(target) ||
    /(^|\/)\.ssh\//i.test(target) ||
    /^\/etc\//i.test(target)
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
