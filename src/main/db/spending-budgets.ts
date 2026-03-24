import { getDb } from './database';

export type BudgetPeriod = 'daily' | 'weekly' | 'monthly';

export interface SpendingBudget {
  id: number;
  period: BudgetPeriod;
  limitUsd: number;   // cents
  isActive: boolean;
  resetDay?: number;
  createdAt: string;
}

interface SpendingBudgetRow {
  id: number;
  period: string;
  limit_usd: number;
  is_active: number;
  reset_day: number | null;
  created_at: string;
}

function toRecord(row: SpendingBudgetRow): SpendingBudget {
  return {
    id: row.id,
    period: row.period as BudgetPeriod,
    limitUsd: row.limit_usd,
    isActive: row.is_active === 1,
    resetDay: row.reset_day ?? undefined,
    createdAt: row.created_at,
  };
}

export function upsertBudget(input: { period: BudgetPeriod; limitUsd: number; resetDay?: number }): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO spending_budgets (period, limit_usd, is_active, reset_day, created_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(period) DO UPDATE SET limit_usd = excluded.limit_usd,
      reset_day = excluded.reset_day, is_active = 1
  `).run(input.period, input.limitUsd, input.resetDay ?? null, now);
}

export function getBudget(period: BudgetPeriod): SpendingBudget | null {
  const row = getDb()
    .prepare('SELECT * FROM spending_budgets WHERE period = ?')
    .get(period) as SpendingBudgetRow | undefined;
  return row ? toRecord(row) : null;
}

export function listActiveBudgets(): SpendingBudget[] {
  const rows = getDb()
    .prepare('SELECT * FROM spending_budgets WHERE is_active = 1')
    .all() as SpendingBudgetRow[];
  return rows.map(toRecord);
}

export function disableBudget(period: BudgetPeriod): void {
  getDb().prepare('UPDATE spending_budgets SET is_active = 0 WHERE period = ?').run(period);
}
