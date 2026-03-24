import { getDb } from './database';

export type CardType = 'visa' | 'mastercard' | 'amex' | 'discover' | 'other';
export type PaymentSource = 'browser_autofill' | 'manual';

export interface PaymentMethod {
  id: number;
  label: string;
  lastFour: string;
  cardType: CardType;
  methodType: 'card' | 'crypto';
  expiryMonth: number;
  expiryYear: number;
  billingName?: string;
  source: PaymentSource;
  vaultRef?: string;
  isPreferred: boolean;
  isBackup: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface NewPaymentMethod {
  label: string;
  lastFour: string;
  cardType: CardType;
  methodType?: 'card' | 'crypto';
  expiryMonth: number;
  expiryYear: number;
  billingName?: string;
  source: PaymentSource;
  vaultRef?: string;
}

interface PaymentMethodRow {
  id: number;
  label: string;
  last_four: string;
  card_type: string;
  method_type: string;
  expiry_month: number;
  expiry_year: number;
  billing_name: string | null;
  source: string;
  vault_ref: string | null;
  is_preferred: number;
  is_backup: number;
  is_active: number;
  created_at: string;
}

function toRecord(row: PaymentMethodRow): PaymentMethod {
  return {
    id: row.id,
    label: row.label,
    lastFour: row.last_four,
    cardType: row.card_type as CardType,
    methodType: row.method_type as 'card' | 'crypto',
    expiryMonth: row.expiry_month,
    expiryYear: row.expiry_year,
    billingName: row.billing_name ?? undefined,
    source: row.source as PaymentSource,
    vaultRef: row.vault_ref ?? undefined,
    isPreferred: row.is_preferred === 1,
    isBackup: row.is_backup === 1,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

export function insertPaymentMethod(pm: NewPaymentMethod): number {
  const now = new Date().toISOString();
  const result = getDb().prepare(`
    INSERT INTO payment_methods
      (label, last_four, card_type, method_type, expiry_month, expiry_year,
       billing_name, source, vault_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pm.label, pm.lastFour, pm.cardType, pm.methodType ?? 'card',
    pm.expiryMonth, pm.expiryYear, pm.billingName ?? null,
    pm.source, pm.vaultRef ?? null, now,
  );
  return Number(result.lastInsertRowid);
}

export function getPaymentMethod(id: number): PaymentMethod | null {
  const row = getDb()
    .prepare('SELECT * FROM payment_methods WHERE id = ?')
    .get(id) as PaymentMethodRow | undefined;
  return row ? toRecord(row) : null;
}

export function listPaymentMethods(): PaymentMethod[] {
  const rows = getDb()
    .prepare('SELECT * FROM payment_methods WHERE is_active = 1 ORDER BY id ASC')
    .all() as PaymentMethodRow[];
  return rows.map(toRecord);
}

export function setPreferred(id: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE payment_methods SET is_preferred = 0').run();
    db.prepare('UPDATE payment_methods SET is_preferred = 1 WHERE id = ?').run(id);
  })();
}

export function setBackup(id: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE payment_methods SET is_backup = 0').run();
    db.prepare('UPDATE payment_methods SET is_backup = 1 WHERE id = ?').run(id);
  })();
}

export function softDeletePaymentMethod(id: number): void {
  getDb().prepare('UPDATE payment_methods SET is_active = 0 WHERE id = ?').run(id);
}

export function getPreferredMethod(): PaymentMethod | null {
  const row = getDb()
    .prepare('SELECT * FROM payment_methods WHERE is_preferred = 1 AND is_active = 1')
    .get() as PaymentMethodRow | undefined;
  return row ? toRecord(row) : null;
}

export function getBackupMethod(): PaymentMethod | null {
  const row = getDb()
    .prepare('SELECT * FROM payment_methods WHERE is_backup = 1 AND is_active = 1')
    .get() as PaymentMethodRow | undefined;
  return row ? toRecord(row) : null;
}
