import { getDb } from './database';

export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'refunded';

export interface SpendingTransaction {
  id: number;
  runId?: string;
  merchant: string;
  amountUsd: number;  // cents
  description?: string;
  paymentMethodId?: number;
  status: TransactionStatus;
  isEstimated: boolean;
  createdAt: string;
}

export interface NewTransaction {
  runId?: string;
  merchant: string;
  amountUsd: number;
  description?: string;
  paymentMethodId?: number;
  isEstimated: boolean;
  status?: TransactionStatus;
}

interface SpendingTransactionRow {
  id: number;
  run_id: string | null;
  merchant: string;
  amount_usd: number;
  description: string | null;
  payment_method_id: number | null;
  status: string;
  is_estimated: number;
  created_at: string;
}

function toRecord(row: SpendingTransactionRow): SpendingTransaction {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    merchant: row.merchant,
    amountUsd: row.amount_usd,
    description: row.description ?? undefined,
    paymentMethodId: row.payment_method_id ?? undefined,
    status: row.status as TransactionStatus,
    isEstimated: row.is_estimated === 1,
    createdAt: row.created_at,
  };
}

export function insertTransaction(tx: NewTransaction): number {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO spending_transactions
      (run_id, merchant, amount_usd, description, payment_method_id, status, is_estimated, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tx.runId ?? null, tx.merchant, tx.amountUsd,
    tx.description ?? null, tx.paymentMethodId ?? null,
    tx.status ?? 'pending', tx.isEstimated ? 1 : 0, now,
  );
  return Number(result.lastInsertRowid);
}

export function getTransaction(id: number): SpendingTransaction | null {
  const row = getDb()
    .prepare('SELECT * FROM spending_transactions WHERE id = ?')
    .get(id) as SpendingTransactionRow | undefined;
  return row ? toRecord(row) : null;
}

export function updateTransactionToActual(id: number, actualCents: number): void {
  getDb().prepare(`
    UPDATE spending_transactions
    SET amount_usd = ?, is_estimated = 0, status = 'completed'
    WHERE id = ?
  `).run(actualCents, id);
}

export function deleteTransaction(id: number): void {
  getDb().prepare('DELETE FROM spending_transactions WHERE id = ?').run(id);
}

export function updateTransactionStatus(id: number, status: TransactionStatus): void {
  getDb().prepare(
    'UPDATE spending_transactions SET status = ? WHERE id = ?'
  ).run(status, id);
}

export function listTransactions(limit = 50): SpendingTransaction[] {
  const rows = getDb()
    .prepare('SELECT * FROM spending_transactions ORDER BY id DESC LIMIT ?')
    .all(limit) as SpendingTransactionRow[];
  return rows.map(toRecord);
}

// Sum pending + completed transactions since `since` ISO string
export function sumPeriodSpend(since: string): number {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(amount_usd), 0) as total
    FROM spending_transactions
    WHERE created_at >= ?
      AND status IN ('pending', 'completed')
  `).get(since) as { total: number };
  return row.total;
}
