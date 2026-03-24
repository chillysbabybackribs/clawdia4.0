import { listActiveBudgets, type BudgetPeriod } from '../db/spending-budgets';
import {
  insertTransaction,
  updateTransactionToActual,
  deleteTransaction,
  sumPeriodSpend,
} from '../db/spending-transactions';

export interface BudgetCheckResult {
  allowed: boolean;
  remaining: number;      // cents remaining in most restrictive active budget
  blockedBy: BudgetPeriod | null;
  periodSpent: number;
  periodLimit: number;
}

function periodStartIso(period: BudgetPeriod, resetDay?: number): string {
  const now = new Date();
  if (period === 'daily') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  if (period === 'weekly') {
    const day = resetDay ?? 1; // default Monday
    const start = new Date(now);
    const diff = (start.getDay() - day + 7) % 7;
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  // monthly
  const start = new Date(now);
  start.setDate(resetDay ?? 1);
  start.setHours(0, 0, 0, 0);
  // If we haven't reached reset_day yet this month, go back one month
  if (start > now) {
    start.setMonth(start.getMonth() - 1);
  }
  return start.toISOString();
}

export function checkBudget(amountUsdCents: number): BudgetCheckResult {
  const budgets = listActiveBudgets();
  let mostRestrictive: BudgetCheckResult = {
    allowed: true,
    remaining: Infinity,
    blockedBy: null,
    periodSpent: 0,
    periodLimit: 0,
  };

  for (const budget of budgets) {
    const since = periodStartIso(budget.period, budget.resetDay);
    const spent = sumPeriodSpend(since);
    const remaining = budget.limitUsd - spent;
    const wouldExceed = spent + amountUsdCents > budget.limitUsd;

    if (wouldExceed) {
      // Track most restrictive (least remaining)
      if (mostRestrictive.allowed || remaining < mostRestrictive.remaining) {
        mostRestrictive = {
          allowed: false,
          remaining,
          blockedBy: budget.period,
          periodSpent: spent,
          periodLimit: budget.limitUsd,
        };
      }
    } else if (mostRestrictive.allowed && remaining < mostRestrictive.remaining) {
      mostRestrictive = {
        allowed: true,
        remaining,
        blockedBy: null,
        periodSpent: spent,
        periodLimit: budget.limitUsd,
      };
    }
  }

  return mostRestrictive;
}

export function reserveEstimate(runId: string, merchant: string, estimatedCents: number): number {
  return insertTransaction({
    runId,
    merchant,
    amountUsd: estimatedCents,
    isEstimated: true,
    status: 'pending',
  });
}

export function confirmTransaction(transactionId: number, actualCents: number): void {
  updateTransactionToActual(transactionId, actualCents);
}

export function cancelReservation(transactionId: number): void {
  deleteTransaction(transactionId);
}

export function resetExpiredPeriods(): void {
  // No-op: period windows are calculated dynamically from created_at.
  // Called on startup and hourly as a hook for future cleanup.
}

export function getRemainingBudgets(): Array<{ period: string; remaining: number; limit: number; spent: number }> {
  const budgets = listActiveBudgets();
  return budgets.map(budget => {
    const since = periodStartIso(budget.period, budget.resetDay);
    const spent = sumPeriodSpend(since);
    return {
      period: budget.period,
      remaining: budget.limitUsd - spent,
      limit: budget.limitUsd,
      spent,
    };
  });
}
