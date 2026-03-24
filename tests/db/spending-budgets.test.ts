import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ get: getMock, run: runMock, all: allMock }),
  }),
}));

describe('spending-budgets', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    allMock.mockReset();
  });

  it('upsertBudget calls run with correct args', async () => {
    const { upsertBudget } = await import('../../src/main/db/spending-budgets');
    upsertBudget({ period: 'monthly', limitUsd: 20000 });
    expect(runMock).toHaveBeenCalledWith('monthly', 20000, null, expect.any(String));
  });

  it('getBudget returns null when not found', async () => {
    getMock.mockReturnValue(undefined);
    const { getBudget } = await import('../../src/main/db/spending-budgets');
    expect(getBudget('monthly')).toBeNull();
  });

  it('getBudget deserializes row correctly', async () => {
    getMock.mockReturnValue({ id: 1, period: 'monthly', limit_usd: 20000, is_active: 1, reset_day: null, created_at: '2026-01-01' });
    const { getBudget } = await import('../../src/main/db/spending-budgets');
    const b = getBudget('monthly');
    expect(b).not.toBeNull();
    expect(b!.limitUsd).toBe(20000);
    expect(b!.isActive).toBe(true);
    expect(b!.resetDay).toBeUndefined();
  });

  it('listActiveBudgets returns mapped records', async () => {
    allMock.mockReturnValue([
      { id: 1, period: 'daily', limit_usd: 1000, is_active: 1, reset_day: null, created_at: '2026-01-01' },
    ]);
    const { listActiveBudgets } = await import('../../src/main/db/spending-budgets');
    const budgets = listActiveBudgets();
    expect(budgets).toHaveLength(1);
    expect(budgets[0].period).toBe('daily');
  });

  it('disableBudget calls run with correct period', async () => {
    const { disableBudget } = await import('../../src/main/db/spending-budgets');
    disableBudget('weekly');
    expect(runMock).toHaveBeenCalledWith('weekly');
  });
});
