import * as fs from 'fs';
import { createHash } from 'crypto';
import { acquireRunFileLock, clearAllRunFileLocks, getRunFileLock, releaseRunFileLock, releaseRunFileLocks } from '../db/run-file-locks';
import { getRun } from '../db/runs';

const readRevisions = new Map<string, Map<string, string | null>>();

export interface MutationGuardSuccess {
  ok: true;
  path: string;
  release: () => void;
  sourceRevision: string | null;
}

export interface MutationGuardFailure {
  ok: false;
  kind: 'conflict' | 'stale_read';
  path: string;
  summary: string;
  instructions: string;
  ownerRunId?: string;
  currentRevision: string | null;
  expectedRevision?: string | null;
}

export type MutationGuardResult = MutationGuardSuccess | MutationGuardFailure;

export function initFileLockManager(): void {
  clearAllRunFileLocks();
}

export function noteFileRead(runId: string, filePath: string): void {
  const revision = computeFileRevision(filePath);
  let paths = readRevisions.get(runId);
  if (!paths) {
    paths = new Map();
    readRevisions.set(runId, paths);
  }
  paths.set(filePath, revision);
}

export function guardFileMutation(runId: string, filePath: string): MutationGuardResult {
  const currentRevision = computeFileRevision(filePath);
  const expectedRevision = readRevisions.get(runId)?.get(filePath);

  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    return {
      ok: false,
      kind: 'stale_read',
      path: filePath,
      summary: `File changed since this run last read it: ${filePath}`,
      instructions: 'Reload or re-read the file before applying another write.',
      currentRevision,
      expectedRevision,
    };
  }

  const run = getRun(runId);
  const conversationId = run?.conversation_id || '';
  const lock = acquireRunFileLock(filePath, runId, conversationId, currentRevision);
  if (!lock.ok) {
    return {
      ok: false,
      kind: 'conflict',
      path: filePath,
      ownerRunId: lock.ownerRunId,
      summary: `Another active run is already editing ${filePath}`,
      instructions: 'Wait for the other run to finish, or reattach to it and resolve the conflict before resuming this run.',
      currentRevision,
    };
  }

  return {
    ok: true,
    path: filePath,
    sourceRevision: currentRevision,
    release: () => releaseRunFileLock(filePath, runId),
  };
}

export function noteFileMutationSuccess(runId: string, filePath: string): void {
  const revision = computeFileRevision(filePath);
  let paths = readRevisions.get(runId);
  if (!paths) {
    paths = new Map();
    readRevisions.set(runId, paths);
  }
  paths.set(filePath, revision);
}

export function clearRunFileState(runId: string): void {
  readRevisions.delete(runId);
  releaseRunFileLocks(runId);
}

export function getCurrentLockOwner(filePath: string): string | undefined {
  return getRunFileLock(filePath)?.run_id || undefined;
}

function computeFileRevision(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return null;
  }
}
