import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NormalizedToolUseBlock } from '../../src/main/agent/client';

const executeToolMock = vi.fn();
const maybeRequireApprovalMock = vi.fn(() => null);
const requestHumanInterventionMock = vi.fn(() => ({ id: 41 }));
const waitForHumanInterventionMock = vi.fn();
const getUnrestrictedModeMock = vi.fn(() => false);

vi.mock('../../src/main/agent/tool-builder', () => ({
  executeTool: executeToolMock,
  isKnownTool: () => false,
  getToolsForGroup: () => [],
  filterTools: (tools: any[]) => tools,
}));

vi.mock('../../src/main/agent/approval-manager', () => ({
  maybeRequireApproval: maybeRequireApprovalMock,
  recordPolicyBlocked: vi.fn(),
  requestApproval: vi.fn(),
  waitForApproval: vi.fn(),
}));

vi.mock('../../src/main/agent/human-intervention-manager', () => ({
  requestHumanIntervention: requestHumanInterventionMock,
  waitForHumanIntervention: waitForHumanInterventionMock,
}));

vi.mock('../../src/main/db/run-events', () => ({ appendRunEvent: vi.fn() }));
vi.mock('../../src/main/db/run-changes', () => ({ buildTextDiff: vi.fn(() => ''), createRunChange: vi.fn() }));
vi.mock('../../src/main/db/app-registry', () => ({ recordSurfaceDeviation: vi.fn() }));
vi.mock('../../src/main/agent/file-lock-manager', () => ({
  guardFileMutation: vi.fn(() => ({ ok: true, path: '/tmp/out', sourceRevision: 0, release: vi.fn() })),
  noteFileMutationSuccess: vi.fn(),
  noteFileRead: vi.fn(),
}));
vi.mock('../../src/main/agent/agent-spawn-executor', () => ({ spawnSwarm: vi.fn() }));
vi.mock('../../src/main/agent/process-manager', () => ({ noteProcessSpecializedTool: vi.fn() }));
vi.mock('../../src/main/store', () => ({ getUnrestrictedMode: getUnrestrictedModeMock }));
vi.mock('../../src/main/agent/system-audit', () => ({ recordToolTelemetry: vi.fn() }));
vi.mock('../../src/main/agent/verification', () => ({
  resolveVerificationRule: vi.fn(() => null),
  verify: vi.fn(),
  logVerification: vi.fn(),
}));

function makeBlock(name: string, input: Record<string, any>): NormalizedToolUseBlock {
  return { type: 'tool_use', id: 'tool-1', name, input } as NormalizedToolUseBlock;
}

describe('dispatchTools human intervention wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    getUnrestrictedModeMock.mockReturnValue(false);
  });

  it('blocks on a detected human intervention until it is resolved', async () => {
    executeToolMock.mockResolvedValue('[Error] Please enter the verification code to continue');

    let release!: () => void;
    waitForHumanInterventionMock.mockImplementation(() => new Promise<'resolved'>((resolve) => {
      release = () => resolve('resolved');
    }));

    const { dispatchTools } = await import('../../src/main/agent/loop-dispatch');
    const promise = dispatchTools([makeBlock('browser_click', { target: '#submit' })], {
      runId: 'run-1',
      signal: undefined,
      tools: [],
      executionPlan: null,
      toolGroup: 'browser',
      iterationIndex: 0,
      filesystemQuoteLookupMode: false,
      strongFilesystemQuoteMatch: false,
      escalatedToFull: false,
      toolCallCount: 0,
      allToolCalls: [],
      allVerifications: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestHumanInterventionMock).toHaveBeenCalledOnce();

    let settled = false;
    promise.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    const results = await promise;
    expect(waitForHumanInterventionMock).toHaveBeenCalledWith(41);
    expect(String(results[0].content)).toContain('[Human intervention completed]');
  });

  it('does not request human intervention in unrestricted mode', async () => {
    getUnrestrictedModeMock.mockReturnValue(true);
    executeToolMock.mockResolvedValue('[Error] Please enter the verification code to continue');

    const { dispatchTools } = await import('../../src/main/agent/loop-dispatch');
    const results = await dispatchTools([makeBlock('browser_click', { target: '#submit' })], {
      runId: 'run-1',
      signal: undefined,
      tools: [],
      executionPlan: null,
      toolGroup: 'browser',
      iterationIndex: 0,
      filesystemQuoteLookupMode: false,
      strongFilesystemQuoteMatch: false,
      escalatedToFull: false,
      toolCallCount: 0,
      allToolCalls: [],
      allVerifications: [],
    });

    expect(requestHumanInterventionMock).not.toHaveBeenCalled();
    expect(waitForHumanInterventionMock).not.toHaveBeenCalled();
    expect(String(results[0].content)).toContain('verification code');
  });
});
