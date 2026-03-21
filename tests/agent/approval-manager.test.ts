import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/db/run-events', () => ({
  appendRunEvent: vi.fn(),
}));

vi.mock('../../src/main/db/run-approvals', () => ({
  createRunApproval: vi.fn(),
  getRunApprovalRecord: vi.fn(),
  listRunApprovalRecords: vi.fn(() => []),
  resolveRunApproval: vi.fn(),
}));

vi.mock('../../src/main/agent/policy-engine', () => ({
  evaluatePolicy: vi.fn(() => null),
}));

vi.mock('../../src/main/store', () => ({
  getUnrestrictedMode: vi.fn(() => false),
}));

vi.mock('../../src/main/agent/process-manager', () => ({
  setProcessStatus: vi.fn(),
}));

describe('approval-manager browser_eval gating', () => {
  it('requires approval for storage and cookie reads', async () => {
    const { maybeRequireApproval } = await import('../../src/main/agent/approval-manager');
    const decision = maybeRequireApproval('browser_eval', { expression: '({ cookie: document.cookie, store: localStorage.getItem("x") })' });
    expect(decision?.effect).toBe('require_approval');
    expect(decision?.actionType).toBe('browser_eval_sensitive');
  });

  it('blocks browser_eval expressions that attempt navigation side effects', async () => {
    const { maybeRequireApproval } = await import('../../src/main/agent/approval-manager');
    const decision = maybeRequireApproval('browser_eval', { expression: 'location.assign("https://example.com")' });
    expect(decision?.effect).toBe('deny');
    expect(decision?.actionType).toBe('policy:browser_eval');
  });
});
