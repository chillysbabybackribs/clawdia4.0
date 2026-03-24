import Database from 'better-sqlite3';

function buildDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS managed_accounts (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name        TEXT NOT NULL,
      login_url           TEXT NOT NULL DEFAULT '',
      username            TEXT NOT NULL DEFAULT '',
      email_used          TEXT NOT NULL DEFAULT '',
      password_encrypted  TEXT NOT NULL DEFAULT '',
      phone_used          TEXT NOT NULL DEFAULT '',
      phone_method        TEXT NOT NULL DEFAULT '',
      identity_profile_id INTEGER,
      status              TEXT NOT NULL DEFAULT 'unverified',
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      notes               TEXT NOT NULL DEFAULT '',
      UNIQUE(service_name)
    );
    CREATE TABLE IF NOT EXISTS credential_vault (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      label           TEXT NOT NULL,
      type            TEXT NOT NULL,
      service         TEXT NOT NULL DEFAULT '',
      value_encrypted TEXT NOT NULL,
      expires_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(label, service)
    );
  `);
  return db;
}

describe('listAccounts SQL', () => {
  it('returns all rows as ManagedAccount shape (without decryption)', () => {
    const db = buildDb();
    db.prepare(`INSERT INTO managed_accounts (service_name, username, password_encrypted, status)
      VALUES ('reddit.com', 'dp_user', 'enc_pw', 'active')`).run();
    db.prepare(`INSERT INTO managed_accounts (service_name, username, password_encrypted, status)
      VALUES ('github.com', 'dpdev', 'enc_pw2', 'active')`).run();

    const rows = db.prepare('SELECT * FROM managed_accounts').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].service_name).toBe('reddit.com');
    expect(rows[1].service_name).toBe('github.com');
    expect(rows[0].password_encrypted).toBe('enc_pw');
  });
});

describe('deleteAccount SQL', () => {
  it('removes the row matching service_name', () => {
    const db = buildDb();
    db.prepare(`INSERT INTO managed_accounts (service_name, username, password_encrypted)
      VALUES ('reddit.com', 'dp_user', 'enc')`).run();

    db.prepare('DELETE FROM managed_accounts WHERE service_name = ?').run('reddit.com');
    const row = db.prepare('SELECT * FROM managed_accounts WHERE service_name = ?').get('reddit.com');
    expect(row).toBeUndefined();
  });
});

describe('listCredentials masking', () => {
  it('masks values with bullets except last 4 chars', () => {
    const mask = (val: string) =>
      '•'.repeat(Math.max(0, val.length - 4)) + val.slice(-4);

    expect(mask('AC1234567890abcd3f2a')).toBe('••••••••••••••••3f2a');
    expect(mask('abcd')).toBe('abcd');
    expect(mask('ab')).toBe('ab');
    expect(mask('')).toBe('');
  });

  it('listCredentials SQL returns all vault rows', () => {
    const db = buildDb();
    db.prepare(`INSERT INTO credential_vault (label, type, service, value_encrypted)
      VALUES ('twilio-sid', 'api_key', 'twilio', 'enc_val')`).run();
    db.prepare(`INSERT INTO credential_vault (label, type, service, value_encrypted)
      VALUES ('gh-pass', 'app_password', 'github', 'enc_val2')`).run();

    const rows = db.prepare('SELECT label, type, service, value_encrypted FROM credential_vault').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('twilio-sid');
    expect(rows[1].label).toBe('gh-pass');
  });
});

describe('deleteCredential SQL', () => {
  it('removes row matching label AND service (composite key)', () => {
    const db = buildDb();
    db.prepare(`INSERT INTO credential_vault (label, type, service, value_encrypted)
      VALUES ('mykey', 'api_key', 'myservice', 'enc')`).run();
    db.prepare(`INSERT INTO credential_vault (label, type, service, value_encrypted)
      VALUES ('mykey', 'api_key', 'otherservice', 'enc2')`).run();

    db.prepare('DELETE FROM credential_vault WHERE label = ? AND service = ?').run('mykey', 'myservice');

    const remaining = db.prepare('SELECT * FROM credential_vault').all() as any[];
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as any).service).toBe('otherservice');
  });
});
