import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB layers
const listActiveBudgetsMock = vi.fn();
const sumPeriodSpendMock = vi.fn();
const insertTransactionMock = vi.fn();
const updateTransactionToActualMock = vi.fn();
const deleteTransactionMock = vi.fn();
const updateTransactionStatusMock = vi.fn();

vi.mock('../../src/main/db/spending-budgets', () => ({
  listActiveBudgets: listActiveBudgetsMock,
}));

vi.mock('../../src/main/db/spending-transactions', () => ({
  insertTransaction: insertTransactionMock,
  updateTransactionToActual: updateTransactionToActualMock,
  deleteTransaction: deleteTransactionMock,
  updateTransactionStatus: updateTransactionStatusMock,
  sumPeriodSpend: sumPeriodSpendMock,
}));

describe('spending-budget engine', () => {
  beforeEach(() => {
    listActiveBudgetsMock.mockReset();
    sumPeriodSpendMock.mockReset();
    insertTransactionMock.mockReset();
    updateTransactionToActualMock.mockReset();
    deleteTransactionMock.mockReset();
    updateTransactionStatusMock.mockReset();
  });

  it('checkBudget allows purchase when no budgets configured', async () => {
    listActiveBudgetsMock.mockReturnValue([]);
    const { checkBudget } = await import('../../src/main/agent/spending-budget');
    const result = checkBudget(5000);
    expect(result.allowed).toBe(true);
    expect(result.blockedBy).toBeNull();
  });

  it('checkBudget allows purchase within budget', async () => {
    listActiveBudgetsMock.mockReturnValue([
      { id: 1, period: 'monthly', limitUsd: 10000, isActive: true },
    ]);
    sumPeriodSpendMock.mockReturnValue(3000); // 3000 spent, 5000 requested = 8000 total < 10000
    const { checkBudget } = await import('../../src/main/agent/spending-budget');
    const result = checkBudget(5000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(7000); // 10000 - 3000
  });

  it('checkBudget blocks purchase that exceeds monthly budget', async () => {
    listActiveBudgetsMock.mockReturnValue([
      { id: 1, period: 'monthly', limitUsd: 10000, isActive: true },
    ]);
    sumPeriodSpendMock.mockReturnValue(8000); // 8000 spent, 3000 requested = 11000 > 10000
    const { checkBudget } = await import('../../src/main/agent/spending-budget');
    const result = checkBudget(3000);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('monthly');
    expect(result.remaining).toBe(2000); // 10000 - 8000
  });

  it('checkBudget blocks on most restrictive budget (daily tighter than monthly)', async () => {
    listActiveBudgetsMock.mockReturnValue([
      { id: 1, period: 'monthly', limitUsd: 100000, isActive: true },
      { id: 2, period: 'daily', limitUsd: 1000, isActive: true },
    ]);
    // First call is for monthly (lots of room), second is for daily (almost full)
    sumPeriodSpendMock
      .mockReturnValueOnce(5000)   // monthly: 5000 spent of 100000 (fine)
      .mockReturnValueOnce(800);   // daily: 800 spent of 1000, request 500 = 1300 > 1000
    const { checkBudget } = await import('../../src/main/agent/spending-budget');
    const result = checkBudget(500);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toBe('daily');
  });

  it('failed transactions are not included in sumPeriodSpend (handled at DB layer)', async () => {
    // This is enforced at the sumPeriodSpend level — we just verify checkBudget uses the returned value
    listActiveBudgetsMock.mockReturnValue([
      { id: 1, period: 'monthly', limitUsd: 10000, isActive: true },
    ]);
    sumPeriodSpendMock.mockReturnValue(0); // DB layer correctly excludes failed
    const { checkBudget } = await import('../../src/main/agent/spending-budget');
    const result = checkBudget(9000);
    expect(result.allowed).toBe(true);
  });

  it('reserveEstimate calls insertTransaction with correct args', async () => {
    insertTransactionMock.mockReturnValue(42);
    const { reserveEstimate } = await import('../../src/main/agent/spending-budget');
    const id = reserveEstimate('run-1', 'Amazon', 2000);
    expect(id).toBe(42);
    expect(insertTransactionMock).toHaveBeenCalledWith({
      runId: 'run-1',
      merchant: 'Amazon',
      amountUsd: 2000,
      isEstimated: true,
      status: 'pending',
    });
  });

  it('confirmTransaction calls updateTransactionToActual', async () => {
    const { confirmTransaction } = await import('../../src/main/agent/spending-budget');
    confirmTransaction(5, 2100);
    expect(updateTransactionToActualMock).toHaveBeenCalledWith(5, 2100);
  });

  it('cancelReservation marks transaction as failed', async () => {
    const { cancelReservation } = await import('../../src/main/agent/spending-budget');
    cancelReservation(7);
    expect(updateTransactionStatusMock).toHaveBeenCalledWith(7, 'failed');
  });

  it('getRemainingBudgets returns correct remaining for active budgets', async () => {
    listActiveBudgetsMock.mockReturnValue([
      { id: 1, period: 'monthly', limitUsd: 10000, isActive: true },
    ]);
    sumPeriodSpendMock.mockReturnValue(3000);
    const { getRemainingBudgets } = await import('../../src/main/agent/spending-budget');
    const budgets = getRemainingBudgets();
    expect(budgets).toHaveLength(1);
    expect(budgets[0].period).toBe('monthly');
    expect(budgets[0].remaining).toBe(7000);
    expect(budgets[0].spent).toBe(3000);
    expect(budgets[0].limit).toBe(10000);
  });

  it('checkBudget correctly handles monthly budget with resetDay=31 without date overflow', async () => {
    listActiveBudgetsMock.mockReturnValue([
      { id: 1, period: 'monthly', limitUsd: 10000, isActive: true, resetDay: 31 },
    ]);
    sumPeriodSpendMock.mockReturnValue(0);
    const { checkBudget } = await import('../../src/main/agent/spending-budget');
    // Main thing: should not throw, should return a valid result
    const result = checkBudget(5000);
    expect(result.allowed).toBe(true);
    // Verify sumPeriodSpend was called with a valid ISO date string
    const sinceArg = sumPeriodSpendMock.mock.calls[0][0];
    expect(() => new Date(sinceArg)).not.toThrow();
    expect(new Date(sinceArg).getTime()).not.toBeNaN();
  });
});
