import { beforeEach, describe, expect, it, vi } from 'vitest';

const runAgentLoopMock = vi.fn();
const allocateIsolatedTabMock = vi.fn();
const releaseIsolatedTabMock = vi.fn();

vi.mock('../../src/main/agent/loop', () => ({
  runAgentLoop: runAgentLoopMock,
}));

vi.mock('../../src/main/store', () => ({
  getSelectedProvider: () => 'anthropic',
  getApiKey: () => 'test-key',
  getSelectedModel: () => 'sonnet',
}));

vi.mock('../../src/main/browser/manager', () => ({
  allocateIsolatedTab: allocateIsolatedTabMock,
  releaseIsolatedTab: releaseIsolatedTabMock,
}));

describe('agent-spawn-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enforces the role-specific max iteration budget at the child loop boundary', async () => {
    runAgentLoopMock.mockResolvedValue({ response: 'done', toolCalls: [] });

    const { spawnAgent } = await import('../../src/main/agent/agent-spawn-executor');
    await spawnAgent({
      parentRunId: 'parent-1',
      agentIndex: 0,
      role: 'reviewer',
      goal: 'Review the patch',
    });

    expect(runAgentLoopMock).toHaveBeenCalledOnce();
    const options = runAgentLoopMock.mock.calls[0][2];
    expect(options.maxIterations).toBe(6);
    expect(options.forcedAgentProfile).toBe('reviewer');
  });

  it('passes the parent abort signal down into the child loop', async () => {
    runAgentLoopMock.mockResolvedValue({ response: '[Cancelled by user]', toolCalls: [] });
    const parentAbort = new AbortController();

    const { spawnAgent } = await import('../../src/main/agent/agent-spawn-executor');
    await spawnAgent({
      parentRunId: 'parent-2',
      agentIndex: 1,
      role: 'builder',
      goal: 'Implement the feature',
      signal: parentAbort.signal,
    });

    const options = runAgentLoopMock.mock.calls[0][2];
    expect(options.parentSignal).toBe(parentAbort.signal);
    expect(options.maxIterations).toBe(15);
  });
});
