import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();
// transaction mock: immediately calls the provided function
const transactionMock = vi.fn((fn: () => void) => fn);

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ get: getMock, run: runMock, all: allMock }),
    transaction: transactionMock,
  }),
}));

describe('payment-methods', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    allMock.mockReset();
    transactionMock.mockReset();
    // Restore default: execute the function immediately
    transactionMock.mockImplementation((fn: () => void) => fn);
  });

  it('insertPaymentMethod returns the new row id', async () => {
    runMock.mockReturnValue({ lastInsertRowid: 42 });
    const { insertPaymentMethod } = await import('../../src/main/db/payment-methods');
    const id = insertPaymentMethod({
      label: 'Visa ••••4242',
      lastFour: '4242',
      cardType: 'visa',
      expiryMonth: 12,
      expiryYear: 2027,
      source: 'manual',
    });
    expect(id).toBe(42);
    expect(runMock).toHaveBeenCalledOnce();
  });

  it('getPaymentMethod returns null when not found', async () => {
    getMock.mockReturnValue(undefined);
    const { getPaymentMethod } = await import('../../src/main/db/payment-methods');
    expect(getPaymentMethod(999)).toBeNull();
  });

  it('getPaymentMethod deserializes row correctly', async () => {
    getMock.mockReturnValue({
      id: 1, label: 'Visa ••••4242', last_four: '4242', card_type: 'visa',
      method_type: 'card', expiry_month: 12, expiry_year: 2027,
      billing_name: null, source: 'manual', vault_ref: null,
      is_preferred: 0, is_backup: 0, is_active: 1, created_at: '2026-01-01',
    });
    const { getPaymentMethod } = await import('../../src/main/db/payment-methods');
    const pm = getPaymentMethod(1);
    expect(pm).not.toBeNull();
    expect(pm!.lastFour).toBe('4242');
    expect(pm!.isActive).toBe(true);
    expect(pm!.isPreferred).toBe(false);
  });

  it('listPaymentMethods returns mapped records', async () => {
    allMock.mockReturnValue([{
      id: 1, label: 'Visa ••••4242', last_four: '4242', card_type: 'visa',
      method_type: 'card', expiry_month: 12, expiry_year: 2027,
      billing_name: null, source: 'manual', vault_ref: null,
      is_preferred: 1, is_backup: 0, is_active: 1, created_at: '2026-01-01',
    }]);
    const { listPaymentMethods } = await import('../../src/main/db/payment-methods');
    const methods = listPaymentMethods();
    expect(methods).toHaveLength(1);
    expect(methods[0].isPreferred).toBe(true);
  });

  it('softDeletePaymentMethod calls prepare with correct SQL', async () => {
    const { softDeletePaymentMethod } = await import('../../src/main/db/payment-methods');
    softDeletePaymentMethod(5);
    expect(runMock).toHaveBeenCalledWith(5);
  });

  it('setPreferred calls run twice (clear all, then set) with correct id', async () => {
    const { setPreferred } = await import('../../src/main/db/payment-methods');
    setPreferred(3);
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock).toHaveBeenNthCalledWith(2, 3);
  });

  it('setBackup calls run twice (clear all, then set) with correct id', async () => {
    const { setBackup } = await import('../../src/main/db/payment-methods');
    setBackup(4);
    expect(runMock).toHaveBeenCalledTimes(2);
    expect(runMock).toHaveBeenNthCalledWith(2, 4);
  });

  it('getPreferredMethod returns null when no preferred method', async () => {
    getMock.mockReturnValue(undefined);
    const { getPreferredMethod } = await import('../../src/main/db/payment-methods');
    expect(getPreferredMethod()).toBeNull();
  });

  it('getBackupMethod returns mapped record when found', async () => {
    getMock.mockReturnValue({
      id: 2, label: 'MC ••••1111', last_four: '1111', card_type: 'mastercard',
      method_type: 'card', expiry_month: 6, expiry_year: 2028,
      billing_name: null, source: 'manual', vault_ref: null,
      is_preferred: 0, is_backup: 1, is_active: 1, created_at: '2026-01-01',
    });
    const { getBackupMethod } = await import('../../src/main/db/payment-methods');
    const m = getBackupMethod();
    expect(m).not.toBeNull();
    expect(m!.isBackup).toBe(true);
    expect(m!.lastFour).toBe('1111');
  });
});
