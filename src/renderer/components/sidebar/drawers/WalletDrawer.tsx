import React, { useState, useEffect, useCallback } from 'react';

const api = (window as any).clawdia;

interface PaymentMethod {
  id: number;
  label: string;
  lastFour: string;
  cardType: string;
  expiryMonth: number;
  expiryYear: number;
  source: string;
  isPreferred: boolean;
  isBackup: boolean;
}

interface Budget {
  period: string;
  limitUsd: number;
  isActive: boolean;
  resetDay?: number;
}

interface Transaction {
  id: number;
  merchant: string;
  amountUsd: number;
  description?: string;
  status: string;
  isEstimated: boolean;
  createdAt: string;
  paymentMethodId?: number;
}

interface RemainingBudget {
  period: string;
  remaining: number;
  limit: number;
  spent: number;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function StatusBadge({ status, isEstimated }: { status: string; isEstimated: boolean }) {
  const label = isEstimated ? 'estimated' : status;
  const color = {
    completed: 'text-green-400',
    pending: 'text-yellow-400',
    failed: 'text-red-400',
    estimated: 'text-text-muted',
    refunded: 'text-blue-400',
  }[label] ?? 'text-text-muted';
  return <span className={`text-[10px] font-medium uppercase ${color}`}>{label}</span>;
}

function BudgetBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const color = pct < 60 ? 'bg-green-500' : pct < 85 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="w-full h-[3px] bg-surface-1 rounded-full mt-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function WalletDrawer() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [remaining, setRemaining] = useState<RemainingBudget[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [importCandidates, setImportCandidates] = useState<any[] | null>(null);
  const [selectedImportIndices, setSelectedImportIndices] = useState<Set<number>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({
    label: '', lastFour: '', cardType: 'visa',
    expiryMonth: '', expiryYear: '', billingName: '', cardNumber: '',
  });

  const reload = useCallback(async () => {
    const [m, b, r, t] = await Promise.all([
      api.wallet.getPaymentMethods(),
      api.wallet.getBudgets(),
      api.wallet.getRemainingBudgets(),
      api.wallet.getTransactions({ limit: 30 }),
    ]);
    setMethods(m ?? []);
    setBudgets(b ?? []);
    setRemaining(r ?? []);
    setTransactions(t ?? []);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleImport = async () => {
    const candidates = await api.wallet.importBrowserCards();
    setImportCandidates(candidates ?? []);
    setSelectedImportIndices(new Set((candidates ?? []).map((_: any, i: number) => i)));
  };

  const handleConfirmImport = async (selected: any[]) => {
    await api.wallet.confirmImport(selected);
    setImportCandidates(null);
    reload();
  };

  const handleAddManual = async () => {
    await api.wallet.addManualCard({
      ...addForm,
      expiryMonth: Number(addForm.expiryMonth),
      expiryYear: Number(addForm.expiryYear),
    });
    setShowAddForm(false);
    setAddForm({ label: '', lastFour: '', cardType: 'visa', expiryMonth: '', expiryYear: '', billingName: '', cardNumber: '' });
    reload();
  };

  const setBudgetValue = async (period: string, limitUsd: number) => {
    await api.wallet.setBudget({ period, limitUsd });
    reload();
  };

  const toggleBudget = async (period: string, current?: Budget) => {
    if (current?.isActive) {
      await api.wallet.disableBudget(period);
    } else {
      await api.wallet.setBudget({ period, limitUsd: 10000 }); // default $100
    }
    reload();
  };

  const periods = ['daily', 'weekly', 'monthly'] as const;

  return (
    <div className="flex flex-col h-full overflow-y-auto text-xs text-text-primary">

      {/* ── Section 1: Payment Methods ── */}
      <div className="px-3 pt-3 pb-2">
        <div className="font-semibold text-[11px] uppercase tracking-wide text-text-muted mb-2">Payment Methods</div>

        <div className="flex gap-1 mb-2">
          <button onClick={handleImport}
            className="flex-1 text-[11px] px-2 py-1 rounded bg-surface-1 hover:bg-surface-2 text-text-primary">
            Import from browser
          </button>
          <button onClick={() => setShowAddForm(v => !v)}
            className="flex-1 text-[11px] px-2 py-1 rounded bg-surface-1 hover:bg-surface-2 text-text-primary">
            Add manually
          </button>
        </div>

        {/* Import candidates */}
        {importCandidates !== null && (
          <div className="mb-2 p-2 bg-surface-1 rounded">
            <div className="text-text-muted mb-1">Found {importCandidates.length} card(s)</div>
            {importCandidates.length === 0
              ? <div className="text-text-muted">No saved cards found in browser.</div>
              : importCandidates.map((c, i) => (
                <div key={i} className="flex items-center gap-1 mb-1">
                  <input
                    type="checkbox"
                    checked={selectedImportIndices.has(i)}
                    onChange={e => {
                      setSelectedImportIndices(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(i); else next.delete(i);
                        return next;
                      });
                    }}
                    id={`imp-${i}`}
                  />
                  <label htmlFor={`imp-${i}`} className="text-text-primary">{c.label}</label>
                </div>
              ))
            }
            <div className="flex gap-1 mt-1">
              <button onClick={() => handleConfirmImport(importCandidates.filter((_: any, i: number) => selectedImportIndices.has(i)))}
                className="text-[11px] px-2 py-0.5 rounded bg-accent text-white">Import</button>
              <button onClick={() => { setImportCandidates(null); setSelectedImportIndices(new Set()); }}
                className="text-[11px] px-2 py-0.5 rounded bg-surface-2 text-text-muted">Cancel</button>
            </div>
          </div>
        )}

        {/* Manual add form */}
        {showAddForm && (
          <div className="mb-2 p-2 bg-surface-1 rounded flex flex-col gap-1">
            <input placeholder="Label (e.g. Visa ••••4242)" value={addForm.label}
              onChange={e => setAddForm(f => ({ ...f, label: e.target.value }))}
              className="w-full bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
            <input placeholder="Card number" value={addForm.cardNumber} type="password"
              onChange={e => setAddForm(f => ({ ...f, cardNumber: e.target.value, lastFour: e.target.value.replace(/\s/g, '').slice(-4) }))}
              className="w-full bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
            <div className="flex gap-1">
              <input placeholder="MM" value={addForm.expiryMonth} maxLength={2}
                onChange={e => setAddForm(f => ({ ...f, expiryMonth: e.target.value }))}
                className="w-12 bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
              <input placeholder="YYYY" value={addForm.expiryYear} maxLength={4}
                onChange={e => setAddForm(f => ({ ...f, expiryYear: e.target.value }))}
                className="w-16 bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
              <select value={addForm.cardType} onChange={e => setAddForm(f => ({ ...f, cardType: e.target.value }))}
                className="flex-1 bg-surface-0 border border-border rounded px-1 py-1 text-xs">
                {['visa','mastercard','amex','discover','other'].map(t => (
                  <option key={t} value={t}>{capitalize(t)}</option>
                ))}
              </select>
            </div>
            <input placeholder="Name on card (optional)" value={addForm.billingName}
              onChange={e => setAddForm(f => ({ ...f, billingName: e.target.value }))}
              className="w-full bg-surface-0 border border-border rounded px-2 py-1 text-xs" />
            <div className="flex gap-1">
              <button onClick={handleAddManual}
                className="text-[11px] px-2 py-0.5 rounded bg-accent text-white">Save</button>
              <button onClick={() => setShowAddForm(false)}
                className="text-[11px] px-2 py-0.5 rounded bg-surface-2 text-text-muted">Cancel</button>
            </div>
          </div>
        )}

        {/* Card list */}
        {methods.length === 0
          ? <div className="text-text-muted py-2">No cards added yet.</div>
          : methods.map(m => (
            <div key={m.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
              <div>
                <div className="text-text-primary">{m.label}</div>
                <div className="text-text-muted text-[10px]">
                  {m.expiryMonth}/{m.expiryYear} · {m.source === 'browser_autofill' ? 'browser' : 'manual'}
                </div>
              </div>
              <div className="flex gap-1 items-center">
                {m.isPreferred && <span className="text-[9px] font-bold text-accent uppercase">Preferred</span>}
                {m.isBackup && <span className="text-[9px] font-bold text-yellow-400 uppercase">Backup</span>}
                <button onClick={async () => { await api.wallet.setPreferred(m.id); reload(); }}
                  title="Set as preferred"
                  className="text-[10px] text-text-muted hover:text-text-primary px-1">★</button>
                <button onClick={async () => { await api.wallet.removeCard(m.id); reload(); }}
                  title="Remove card"
                  className="text-[10px] text-text-muted hover:text-red-400 px-1">✕</button>
              </div>
            </div>
          ))
        }
      </div>

      <div className="h-px bg-border mx-3" />

      {/* ── Section 2: Spending Limits ── */}
      <div className="px-3 py-2">
        <div className="font-semibold text-[11px] uppercase tracking-wide text-text-muted mb-2">Spending Limits</div>
        {periods.map(period => {
          const budget = budgets.find(b => b.period === period);
          const rem = remaining.find(r => r.period === period);
          return (
            <div key={period} className="mb-2">
              <div className="flex items-center justify-between">
                <span className="text-text-primary">{capitalize(period)}</span>
                <div className="flex items-center gap-2">
                  {budget?.isActive && rem && (
                    <span className="text-text-muted">{formatCents(rem.remaining)} left</span>
                  )}
                  <button
                    onClick={() => toggleBudget(period, budget)}
                    className={`relative w-8 h-4 rounded-full transition-colors ${budget?.isActive ? 'bg-accent' : 'bg-surface-2'}`}
                  >
                    <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${budget?.isActive ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              </div>
              {budget?.isActive && (
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-text-muted">$</span>
                  <input
                    key={`budget-${period}-${budget.limitUsd}`}
                    type="number"
                    defaultValue={budget.limitUsd > 0 ? (budget.limitUsd / 100).toFixed(0) : ''}
                    onBlur={e => setBudgetValue(period, Math.round(Number(e.target.value) * 100))}
                    className="w-20 bg-surface-0 border border-border rounded px-1 py-0.5 text-xs"
                  />
                </div>
              )}
              {budget?.isActive && rem && (
                <BudgetBar spent={rem.spent} limit={rem.limit} />
              )}
            </div>
          );
        })}
      </div>

      <div className="h-px bg-border mx-3" />

      {/* ── Section 3: Transaction History ── */}
      <div className="px-3 py-2 flex-1">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold text-[11px] uppercase tracking-wide text-text-muted">Transactions</div>
          {remaining.find(r => r.period === 'monthly') && (
            <div className="text-[10px] text-text-muted">
              {formatCents(remaining.find(r => r.period === 'monthly')!.spent)} / {formatCents(remaining.find(r => r.period === 'monthly')!.limit)} this month
            </div>
          )}
        </div>
        {transactions.length === 0
          ? <div className="text-text-muted py-2">No transactions yet.</div>
          : transactions.map(tx => (
            <div key={tx.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
              <div>
                <div className="text-text-primary">{tx.merchant}</div>
                {tx.description && <div className="text-text-muted text-[10px]">{tx.description}</div>}
                <div className="text-text-muted text-[10px]">
                  {new Date(tx.createdAt).toLocaleDateString()}
                </div>
              </div>
              <div className="text-right">
                <div className="text-text-primary">{formatCents(tx.amountUsd)}</div>
                <StatusBadge status={tx.status} isEstimated={tx.isEstimated} />
              </div>
            </div>
          ))
        }
      </div>

    </div>
  );
}
