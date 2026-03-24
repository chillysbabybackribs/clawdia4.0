import { checkBudget, reserveEstimate, confirmTransaction, cancelReservation, getRemainingBudgets } from './spending-budget';
import { getPreferredMethod, getBackupMethod, type PaymentMethod } from '../db/payment-methods';
import { emitSpendingEvent } from '../main';
import { IPC_EVENTS } from '../../shared/ipc-channels';

export interface CheckoutOptions {
  runId: string;
  merchant: string;
  estimatedCents: number;
  description?: string;
  /** Execute callback: given the selected card, perform the actual checkout in the browser */
  execute: (card: PaymentMethod, getCvv: () => Promise<string | null>) => Promise<{ actualCents: number }>;
}

export interface CheckoutResult {
  success: boolean;
  error?: string;
  transactionId?: number;
}

export async function runCheckout(opts: CheckoutOptions): Promise<CheckoutResult> {
  const { runId, merchant, estimatedCents, description, execute } = opts;

  // 1. Budget pre-check
  const budgetCheck = checkBudget(estimatedCents);
  if (!budgetCheck.allowed) {
    emitSpendingEvent(IPC_EVENTS.SPENDING_BUDGET_EXCEEDED, {
      merchant,
      amountCents: estimatedCents,
      blockedBy: budgetCheck.blockedBy,
      remainingCents: budgetCheck.remaining,
    });
    return {
      success: false,
      error: `Purchase blocked — ${budgetCheck.blockedBy} spending limit reached ($${(budgetCheck.remaining / 100).toFixed(2)} remaining)`,
    };
  }

  // 2. Check payment methods configured
  const preferred = getPreferredMethod();
  const backup = getBackupMethod();
  if (!preferred && !backup) {
    return { success: false, error: 'No payment method configured. Open the Wallet to add a card.' };
  }

  // 3. Reserve the estimated amount
  const transactionId = reserveEstimate(runId, merchant, estimatedCents);

  try {
    // 4. Provide CVV getter that triggers human intervention if needed
    const getCvv = async (): Promise<string | null> => {
      // Dynamically import to avoid circular dependency
      const { createRunHumanIntervention } = await import('../db/run-human-interventions');
      createRunHumanIntervention(runId, {
        interventionType: 'unknown',
        target: merchant,
        summary: `CVV required to complete purchase at ${merchant} — $${(estimatedCents / 100).toFixed(2)}. Enter your card's security code in the app.`,
        instructions: 'Enter the 3-digit security code from the back of your card to proceed.',
        request: { merchant, amountCents: estimatedCents, cvvRequired: true },
      });
      // The intervention system does not currently support response payloads.
      // CVV must be provided via the execute() callback's own mechanism.
      // Return null to indicate no stored CVV is available from this path.
      return null;
    };

    // 5. Execute the purchase (caller-provided browser automation)
    const card = preferred ?? backup!;
    const { actualCents } = await execute(card, getCvv);

    // 6. Confirm transaction
    confirmTransaction(transactionId, actualCents);

    // 7. Check low-balance notification
    const budgets = getRemainingBudgets();
    for (const b of budgets) {
      if (b.limit > 0 && b.remaining / b.limit < 0.2) {
        emitSpendingEvent(IPC_EVENTS.SPENDING_LOW_BALANCE, {
          period: b.period,
          remainingCents: b.remaining,
          limitCents: b.limit,
        });
      }
    }

    // 8. Purchase complete notification
    const monthlyRemaining = budgets.find(b => b.period === 'monthly');
    emitSpendingEvent(IPC_EVENTS.SPENDING_PURCHASE_COMPLETE, {
      merchant,
      description,
      amountCents: actualCents,
      remainingCents: monthlyRemaining?.remaining,
    });

    return { success: true, transactionId };

  } catch (err: unknown) {
    cancelReservation(transactionId);
    const message = err instanceof Error ? err.message : 'Checkout failed';
    return { success: false, error: message, transactionId };
  }
}
