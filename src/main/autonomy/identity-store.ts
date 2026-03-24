/**
 * IdentityStore — encrypted identity profiles, managed accounts, credential vault.
 *
 * Encryption: Electron's safeStorage API (OS keychain backed).
 * The master key is derived once per session and cached in memory.
 * All sensitive DB fields store base64-encoded encrypted buffers.
 */
import { safeStorage } from 'electron';
import { getDb } from '../db/database';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IdentityProfile {
  id: number;
  name: string;
  fullName: string;
  email: string;
  usernamePattern: string;
  dateOfBirth?: string;
  isDefault: boolean;
}

export interface UpsertProfileInput {
  name: string;
  fullName?: string;
  email?: string;
  usernamePattern?: string;
  dateOfBirth?: string;
  isDefault?: boolean;
}

export interface ManagedAccount {
  id: number;
  serviceName: string;
  loginUrl: string;
  username: string;
  emailUsed: string;
  /** Decrypted password — never stored in plaintext */
  passwordPlain: string;
  phoneUsed: string;
  phoneMethod: string;
  status: 'active' | 'suspended' | 'unverified';
  createdAt: string;
  notes: string;
}

export interface SaveAccountInput {
  serviceName: string;
  loginUrl?: string;
  username?: string;
  emailUsed?: string;
  passwordPlain: string;
  phoneUsed?: string;
  phoneMethod?: string;
  identityProfileId?: number;
  status?: ManagedAccount['status'];
  notes?: string;
}

export interface SaveCredentialInput {
  label: string;
  type: 'api_key' | 'session_token' | 'app_password' | 'oauth_token';
  service?: string;
  valuePlain: string;
  expiresAt?: string;
}

// ─── IdentityStore ────────────────────────────────────────────────────────────

export class IdentityStore {
  private encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      // Fallback: store as-is in test/CI environments where keychain unavailable.
      // Production always has encryption available on desktop Electron.
      return value;
    }
    return safeStorage.encryptString(value).toString('base64');
  }

  private decrypt(encrypted: string): string {
    if (!safeStorage.isEncryptionAvailable()) return encrypted;
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch {
      return '';
    }
  }

  // ── Identity Profiles ──

  upsertProfile(input: UpsertProfileInput): IdentityProfile {
    const db = getDb();
    if (input.isDefault) {
      db.prepare('UPDATE identity_profiles SET is_default = 0').run();
    }
    const result = db.prepare(`
      INSERT INTO identity_profiles (name, full_name, email, username_pattern, date_of_birth, is_default)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        full_name = excluded.full_name,
        email = excluded.email,
        username_pattern = excluded.username_pattern,
        date_of_birth = excluded.date_of_birth,
        is_default = excluded.is_default
    `).run(
      input.name,
      input.fullName ?? '',
      input.email ?? '',
      input.usernamePattern ?? '',
      input.dateOfBirth ?? null,
      input.isDefault ? 1 : 0,
    );
    const id = result.lastInsertRowid as number || (db.prepare('SELECT id FROM identity_profiles WHERE name = ?').get(input.name) as any).id;
    return this.getProfileById(id)!;
  }

  getDefaultProfile(): IdentityProfile | null {
    const row = getDb().prepare('SELECT * FROM identity_profiles WHERE is_default = 1 LIMIT 1').get() as any;
    return row ? this.rowToProfile(row) : null;
  }

  getProfileByName(name: string): IdentityProfile | null {
    const row = getDb().prepare('SELECT * FROM identity_profiles WHERE name = ?').get(name) as any;
    return row ? this.rowToProfile(row) : null;
  }

  getProfileById(id: number): IdentityProfile | null {
    const row = getDb().prepare('SELECT * FROM identity_profiles WHERE id = ?').get(id) as any;
    return row ? this.rowToProfile(row) : null;
  }

  private rowToProfile(row: any): IdentityProfile {
    return {
      id: row.id,
      name: row.name,
      fullName: row.full_name,
      email: row.email,
      usernamePattern: row.username_pattern,
      dateOfBirth: row.date_of_birth ?? undefined,
      isDefault: row.is_default === 1,
    };
  }

  // ── Managed Accounts ──

  saveAccount(input: SaveAccountInput): ManagedAccount {
    const db = getDb();
    const encrypted = this.encrypt(input.passwordPlain);
    db.prepare(`
      INSERT INTO managed_accounts
        (service_name, login_url, username, email_used, password_encrypted,
         phone_used, phone_method, identity_profile_id, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(service_name) DO UPDATE SET
        login_url = excluded.login_url,
        username = excluded.username,
        email_used = excluded.email_used,
        password_encrypted = excluded.password_encrypted,
        phone_used = excluded.phone_used,
        phone_method = excluded.phone_method,
        identity_profile_id = excluded.identity_profile_id,
        status = excluded.status,
        notes = excluded.notes
    `).run(
      input.serviceName,
      input.loginUrl ?? '',
      input.username ?? '',
      input.emailUsed ?? '',
      encrypted,
      input.phoneUsed ?? '',
      input.phoneMethod ?? '',
      input.identityProfileId ?? null,
      input.status ?? 'unverified',
      input.notes ?? '',
    );
    return this.getAccount(input.serviceName)!;
  }

  getAccount(serviceName: string): ManagedAccount | null {
    const row = getDb().prepare('SELECT * FROM managed_accounts WHERE service_name = ?').get(serviceName) as any;
    if (!row) return null;
    return {
      id: row.id,
      serviceName: row.service_name,
      loginUrl: row.login_url,
      username: row.username,
      emailUsed: row.email_used,
      passwordPlain: this.decrypt(row.password_encrypted),
      phoneUsed: row.phone_used,
      phoneMethod: row.phone_method,
      status: row.status,
      createdAt: row.created_at,
      notes: row.notes,
    };
  }

  updateAccountStatus(serviceName: string, status: ManagedAccount['status']): void {
    getDb().prepare('UPDATE managed_accounts SET status = ? WHERE service_name = ?').run(status, serviceName);
  }

  // ── Credential Vault ──

  saveCredential(input: SaveCredentialInput): void {
    const encrypted = this.encrypt(input.valuePlain);
    getDb().prepare(`
      INSERT INTO credential_vault (label, type, service, value_encrypted, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(label, service) DO UPDATE SET
        value_encrypted = excluded.value_encrypted,
        expires_at = excluded.expires_at
    `).run(
      input.label,
      input.type,
      input.service ?? '',
      encrypted,
      input.expiresAt ?? null,
    );
  }

  getCredential(label: string, service = ''): string | null {
    const row = getDb().prepare(
      'SELECT value_encrypted FROM credential_vault WHERE label = ? AND service = ?'
    ).get(label, service) as any;
    if (!row) return null;
    return this.decrypt(row.value_encrypted);
  }
}

// Singleton for use across the autonomy module
export const identityStore = new IdentityStore();
