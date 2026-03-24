import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ get: getMock, run: runMock, all: allMock }),
  }),
}));

describe('spending-transactions', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    allMock.mockReset();
  });

  it('insertTransaction returns the new row id', async () => {
    runMock.mockReturnValue({ lastInsertRowid: 7 });
    const { insertTransaction } = await import('../../src/main/db/spending-transactions');
    const id = insertTransaction({ merchant: 'Amazon', amountUsd: 999, isEstimated: true });
    expect(id).toBe(7);
    expect(runMock).toHaveBeenCalledOnce();
  });

  it('getTransaction returns null when not found', async () => {
    getMock.mockReturnValue(undefined);
    const { getTransaction } = await import('../../src/main/db/spending-transactions');
    expect(getTransaction(999)).toBeNull();
  });

  it('getTransaction deserializes row correctly', async () => {
    getMock.mockReturnValue({
      id: 1, run_id: 'run-1', merchant: 'Amazon', amount_usd: 999,
      description: 'Test item', payment_method_id: null,
      status: 'pending', is_estimated: 1, created_at: '2026-01-01',
    });
    const { getTransaction } = await import('../../src/main/db/spending-transactions');
    const tx = getTransaction(1);
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe('pending');
    expect(tx!.isEstimated).toBe(true);
    expect(tx!.runId).toBe('run-1');
  });

  it('updateTransactionToActual calls run with actual amount and id', async () => {
    const { updateTransactionToActual } = await import('../../src/main/db/spending-transactions');
    updateTransactionToActual(5, 1050);
    expect(runMock).toHaveBeenCalledWith(1050, 5);
  });

  it('deleteTransaction calls run with correct id', async () => {
    const { deleteTransaction } = await import('../../src/main/db/spending-transactions');
    deleteTransaction(3);
    expect(runMock).toHaveBeenCalledWith(3);
  });

  it('sumPeriodSpend returns total from get', async () => {
    getMock.mockReturnValue({ total: 800 });
    const { sumPeriodSpend } = await import('../../src/main/db/spending-transactions');
    const total = sumPeriodSpend('2026-01-01T00:00:00.000Z');
    expect(total).toBe(800);
  });

  it('listTransactions returns mapped records', async () => {
    allMock.mockReturnValue([{
      id: 1, run_id: null, merchant: 'Test', amount_usd: 500,
      description: null, payment_method_id: null,
      status: 'completed', is_estimated: 0, created_at: '2026-01-01',
    }]);
    const { listTransactions } = await import('../../src/main/db/spending-transactions');
    const txns = listTransactions();
    expect(txns).toHaveLength(1);
    expect(txns[0].isEstimated).toBe(false);
  });
});
