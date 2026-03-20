import { appendRunEvent } from '../db/run-events';
import {
  createRunApproval,
  getRunApprovalRecord,
  listRunApprovalRecords,
  resolveRunApproval,
  type RunApprovalRecord,
} from '../db/run-approvals';
import { evaluatePolicy } from './policy-engine';
import { getUnrestrictedMode } from '../store';
import { setProcessStatus } from './process-manager';

type ApprovalDecision = 'approved' | 'denied' | 'revise';

const pending = new Map<number, { runId: string; resolve: (decision: ApprovalDecision) => void }>();

export interface ApprovalRequirement {
  actionType: string;
  target: string;
  summary: string;
  request?: Record<string, any>;
}

export interface PolicyDecision {
  effect: 'deny' | 'require_approval';
  actionType: string;
  target: string;
  summary: string;
  reason: string;
  request?: Record<string, any>;
}

export function maybeRequireApproval(
  toolName: string,
  input: Record<string, any>,
): PolicyDecision | null {
  if (getUnrestrictedMode()) return null;

  const policyEval = evaluatePolicy(toolName, input);
  if (policyEval) {
    const target = inferTarget(toolName, input);
    if (policyEval.effect === 'deny') {
      return {
        effect: 'deny',
        actionType: `policy:${toolName}`,
        target,
        summary: policyEval.reason,
        reason: policyEval.reason,
        request: {
          toolName,
          input,
          policyRuleId: policyEval.ruleId,
          policyProfileId: policyEval.profileId,
          policyProfileName: policyEval.profileName,
        },
      };
    }
    if (policyEval.effect === 'require_approval') {
      return {
        effect: 'require_approval',
        actionType: `policy:${toolName}`,
        target,
        summary: policyEval.reason,
        reason: policyEval.reason,
        request: {
          toolName,
          input,
          policyRuleId: policyEval.ruleId,
          policyProfileId: policyEval.profileId,
          policyProfileName: policyEval.profileName,
        },
      };
    }
  }

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

  if (toolName === 'fs_apply_plan') {
    const moves = Array.isArray(input.moves) ? input.moves : [];
    if (moves.length === 0) return null;

    const sensitiveMove = moves.find((move) => isSensitivePath(String(move?.source || '')) || isSensitivePath(String(move?.destination || '')));
    if (sensitiveMove) {
      return approval(
        'sensitive_file_change',
        `${String(sensitiveMove.source || '')} -> ${String(sensitiveMove.destination || '')}`,
        'Approval required before applying filesystem plan touching sensitive paths.',
        { toolName, moves },
      );
    }

    if (moves.length > 3) {
      return approval(
        'bulk_file_change',
        `${moves.length} moves`,
        `Approval required before applying ${moves.length} filesystem moves.`,
        { toolName, moves },
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

export function recordPolicyBlocked(runId: string, decision: PolicyDecision): void {
  appendRunEvent(runId, {
    kind: 'policy_blocked',
    phase: 'policy',
    payload: {
      actionType: decision.actionType,
      target: decision.target,
      summary: decision.summary,
      reason: decision.reason,
      request: decision.request || {},
    },
  });
}

export function waitForApproval(approvalId: number): Promise<ApprovalDecision> {
  const record = getRunApprovalRecord(approvalId);
  return new Promise<ApprovalDecision>((resolve) => {
    pending.set(approvalId, { runId: record?.runId || '', resolve });
  });
}

export function approveRunApproval(approvalId: number): RunApprovalRecord | null {
  return resolveApproval(approvalId, 'approved');
}

export function denyRunApproval(approvalId: number): RunApprovalRecord | null {
  return resolveApproval(approvalId, 'denied');
}

export function reviseRunApproval(approvalId: number): RunApprovalRecord | null {
  return resolveApproval(approvalId, 'revise');
}

export function listApprovalsForRun(runId: string): RunApprovalRecord[] {
  return listRunApprovalRecords(runId);
}

export function cancelPendingApprovals(runId?: string, reason = 'Run cancelled while awaiting approval.'): void {
  for (const approvalId of [...pending.keys()]) {
    const pendingEntry = pending.get(approvalId);
    if (runId && pendingEntry?.runId !== runId) continue;
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
    pendingEntry?.resolve('denied');
    pending.delete(approvalId);
  }
}

function resolveApproval(approvalId: number, decision: ApprovalDecision): RunApprovalRecord | null {
  const record = resolveRunApproval(approvalId, decision === 'revise' ? 'denied' : decision);
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

  pending.get(approvalId)?.resolve(decision);
  pending.delete(approvalId);
  return record;
}

function approval(
  actionType: string,
  target: string,
  summary: string,
  request?: Record<string, any>,
): PolicyDecision {
  return { effect: 'require_approval', actionType, target, summary, reason: summary, request };
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

function inferTarget(toolName: string, input: Record<string, any>): string {
  if (toolName === 'shell_exec') {
    return String(input.command || input.cmd || toolName);
  }
  if (toolName === 'file_write' || toolName === 'file_edit') {
    return String(input.path || toolName);
  }
  if (toolName === 'fs_apply_plan') {
    const moves = Array.isArray(input.moves) ? input.moves.length : 0;
    return `${moves} filesystem move${moves === 1 ? '' : 's'}`;
  }
  return toolName;
}
