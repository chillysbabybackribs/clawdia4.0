import type { PolicyProfile, PolicyRule } from '../../shared/types';
import { getPolicyProfile } from '../db/policies';
import { getSelectedPolicyProfile } from '../store';

export interface PolicyEvaluation {
  ruleId: string;
  effect: 'allow' | 'deny' | 'require_approval';
  reason: string;
  profileId: string;
  profileName: string;
}

export function evaluatePolicy(
  toolName: string,
  input: Record<string, any>,
): PolicyEvaluation | null {
  const profile = resolveActiveProfile();
  if (!profile) return null;

  for (const rule of profile.rules) {
    if (!rule.enabled) continue;
    if (matchesRule(rule, toolName, input)) {
      return {
        ruleId: rule.id,
        effect: rule.effect,
        reason: rule.reason,
        profileId: profile.id,
        profileName: profile.name,
      };
    }
  }

  return null;
}

function resolveActiveProfile(): PolicyProfile | null {
  const id = getSelectedPolicyProfile();
  return getPolicyProfile(id) || getPolicyProfile('standard');
}

function matchesRule(rule: PolicyRule, toolName: string, input: Record<string, any>): boolean {
  const match = rule.match || {};
  const command = String(input.command || input.cmd || input.text || '').trim();
  const targetPath = String(input.path || '').trim();

  if (match.toolNames?.length && !match.toolNames.includes(toolName)) return false;

  if (match.commandPatterns?.length) {
    if (!command) return false;
    const matched = match.commandPatterns.some((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(command);
      } catch {
        return false;
      }
    });
    if (!matched) return false;
  }

  if (match.pathPrefixes?.length) {
    if (!targetPath) return false;
    const normalized = normalizePath(targetPath);
    const matched = match.pathPrefixes.some((prefix) => normalized.includes(normalizePath(prefix)));
    if (!matched) return false;
  }

  return true;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}
