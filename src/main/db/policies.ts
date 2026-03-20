import type { PolicyProfile } from '../../shared/types';
import { getDb } from './database';

interface PolicyProfileRow {
  id: string;
  name: string;
  scope_type: 'global' | 'workspace' | 'task_type';
  scope_value: string | null;
  rules_json: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PROFILES: PolicyProfile[] = [
  {
    id: 'standard',
    name: 'Standard',
    scopeType: 'global',
    rules: [
      {
        id: 'standard-git-push',
        enabled: true,
        match: { toolNames: ['shell_exec'], commandPatterns: ['\\bgit\\s+push\\b'] },
        effect: 'require_approval',
        reason: 'External side effect: pushing changes.',
      },
      {
        id: 'standard-sudo',
        enabled: true,
        match: { toolNames: ['shell_exec'], commandPatterns: ['\\bsudo\\b'] },
        effect: 'require_approval',
        reason: 'Privileged command requires explicit approval.',
      },
      {
        id: 'standard-destructive-delete',
        enabled: true,
        match: { toolNames: ['shell_exec'], commandPatterns: ['\\brm\\s+-rf\\b'] },
        effect: 'require_approval',
        reason: 'Destructive delete requires explicit approval.',
      },
      {
        id: 'standard-sensitive-files',
        enabled: true,
        match: { toolNames: ['file_write', 'file_edit'], pathPrefixes: ['.env', '.npmrc', '.git/config', '.ssh/', '/etc/'] },
        effect: 'require_approval',
        reason: 'Sensitive config files require approval before editing.',
      },
    ],
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'coding',
    name: 'Coding Review',
    scopeType: 'global',
    rules: [
      {
        id: 'coding-git-push',
        enabled: true,
        match: { toolNames: ['shell_exec'], commandPatterns: ['\\bgit\\s+push\\b'] },
        effect: 'require_approval',
        reason: 'Pushing code should stay user-approved in coding mode.',
      },
      {
        id: 'coding-package-installs',
        enabled: true,
        match: { toolNames: ['shell_exec'], commandPatterns: ['\\b(?:npm|pnpm|yarn)\\s+install\\b'] },
        effect: 'require_approval',
        reason: 'Dependency changes require review in coding mode.',
      },
      {
        id: 'coding-system-package-changes',
        enabled: true,
        match: { toolNames: ['shell_exec'], commandPatterns: ['\\b(?:apt|apt-get)\\s+(?:install|remove|upgrade)\\b'] },
        effect: 'require_approval',
        reason: 'System package changes require approval.',
      },
      {
        id: 'coding-destructive-db',
        enabled: true,
        match: { toolNames: ['shell_exec'], commandPatterns: ['\\bDROP\\s+(?:TABLE|DATABASE)\\b'] },
        effect: 'deny',
        reason: 'Schema-destructive database commands are blocked by the coding profile.',
      },
      {
        id: 'coding-sensitive-files',
        enabled: true,
        match: { toolNames: ['file_write', 'file_edit'], pathPrefixes: ['.env', '.env.', '.npmrc', '.git/config', '.ssh/', '/etc/'] },
        effect: 'require_approval',
        reason: 'Sensitive project and system config requires approval.',
      },
    ],
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'browser',
    name: 'Browser Review',
    scopeType: 'global',
    rules: [
      {
        id: 'browser-submit',
        enabled: true,
        match: { toolNames: ['browser_click', 'browser_type'], commandPatterns: ['submit|purchase|checkout|publish|post'] },
        effect: 'require_approval',
        reason: 'Potential external submission requires approval.',
      },
      {
        id: 'browser-account',
        enabled: true,
        match: { toolNames: ['browser_click', 'browser_type'], commandPatterns: ['billing|permission|account|settings'] },
        effect: 'require_approval',
        reason: 'Account-changing browser actions require approval.',
      },
    ],
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'locked',
    name: 'Locked Down',
    scopeType: 'global',
    rules: [
      {
        id: 'locked-shell',
        enabled: true,
        match: { toolNames: ['shell_exec'] },
        effect: 'require_approval',
        reason: 'All shell commands require approval in locked-down mode.',
      },
      {
        id: 'locked-writes',
        enabled: true,
        match: { toolNames: ['file_write', 'file_edit'] },
        effect: 'require_approval',
        reason: 'All file mutations require approval in locked-down mode.',
      },
    ],
    createdAt: '',
    updatedAt: '',
  },
];

export function seedPolicyProfiles(): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO policy_profiles (
      id, name, scope_type, scope_value, rules_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const profile of DEFAULT_PROFILES) {
      insert.run(
        profile.id,
        profile.name,
        profile.scopeType,
        profile.scopeValue || null,
        JSON.stringify(profile.rules),
        now,
        now,
      );
    }
  });
  tx();
}

export function listPolicyProfiles(): PolicyProfile[] {
  return getDb()
    .prepare('SELECT * FROM policy_profiles ORDER BY name ASC')
    .all()
    .map((row) => toPolicyProfile(row as PolicyProfileRow)) as PolicyProfile[];
}

export function getPolicyProfile(id: string): PolicyProfile | null {
  const row = getDb().prepare('SELECT * FROM policy_profiles WHERE id = ?').get(id) as PolicyProfileRow | undefined;
  return row ? toPolicyProfile(row) : null;
}

function toPolicyProfile(row: PolicyProfileRow): PolicyProfile {
  return {
    id: row.id,
    name: row.name,
    scopeType: row.scope_type,
    scopeValue: row.scope_value || undefined,
    rules: safeParseRules(row.rules_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseRules(json: string) {
  try {
    return JSON.parse(json || '[]');
  } catch {
    return [];
  }
}
