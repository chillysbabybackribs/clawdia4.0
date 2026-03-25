import { applyAgentProfileOverride } from '../src/main/agent/agent-profile-override';
import { classify } from '../src/main/agent/classifier';
import {
  applyInLoopHarnessAdjustment,
  createRuntimeHarnessReactiveState,
  formatResolvedHarnessDebug,
  resolveHarness,
  type RuntimeHarnessSignal,
} from '../src/main/agent/harness-resolver';
import { resolveModelForProvider } from '../src/main/agent/provider/factory';
import { getSystemAuditSummary, type SystemAuditSummary } from '../src/main/agent/system-audit';
import type { ProviderId } from '../src/shared/model-registry';
import * as fs from 'fs';

function parseArgs(argv: string[]): { provider: ProviderId; forcedProfile?: string; auditFixture?: string; runtimeSignalsFixture?: string; message: string } {
  let provider: ProviderId = 'anthropic';
  let forcedProfile: string | undefined;
  let auditFixture: string | undefined;
  let runtimeSignalsFixture: string | undefined;
  const messageParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--provider') {
      provider = (argv[i + 1] as ProviderId) || provider;
      i += 1;
      continue;
    }
    if (arg === '--profile') {
      forcedProfile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--audit-fixture') {
      auditFixture = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--runtime-signals-fixture') {
      runtimeSignalsFixture = argv[i + 1];
      i += 1;
      continue;
    }
    messageParts.push(arg);
  }

  return {
    provider,
    forcedProfile,
    auditFixture,
    runtimeSignalsFixture,
    message: messageParts.join(' ').trim(),
  };
}

function loadAuditSummary(auditFixture?: string): SystemAuditSummary {
  if (!auditFixture) return getSystemAuditSummary();
  return JSON.parse(fs.readFileSync(auditFixture, 'utf-8')) as SystemAuditSummary;
}

function loadRuntimeSignals(runtimeSignalsFixture?: string): RuntimeHarnessSignal[] {
  if (!runtimeSignalsFixture) return [];
  return JSON.parse(fs.readFileSync(runtimeSignalsFixture, 'utf-8')) as RuntimeHarnessSignal[];
}

function main(): void {
  const { provider, forcedProfile, auditFixture, runtimeSignalsFixture, message } = parseArgs(process.argv.slice(2));
  if (!message) {
    console.error('Usage: tsx scripts/debug-harness.ts [--provider anthropic|openai|gemini] [--profile profile] [--audit-fixture path.json] [--runtime-signals-fixture path.json] <task text>');
    process.exit(1);
  }

  const profile = applyAgentProfileOverride(classify(message), forcedProfile as any);
  const initialModel = resolveModelForProvider(provider, profile.model);
  const auditSummary = loadAuditSummary(auditFixture);
  const runtimeSignals = loadRuntimeSignals(runtimeSignalsFixture);
  const harness = resolveHarness({
    userMessage: message,
    profile,
    provider,
    initialModel,
    forcedAgentProfile: forcedProfile,
    systemAuditSummary: auditSummary,
  });

  console.log(`Task: ${message}`);
  console.log(`Provider: ${provider}`);
  console.log(`Classified profile: ${profile.agentProfile}`);
  console.log(`Tool group: ${profile.toolGroup}`);
  console.log(`Prompt modules: ${[...profile.promptModules].join(', ') || '(none)'}`);
  console.log(`Initial model: ${initialModel}`);
  console.log(`Audit source: ${auditFixture ? auditFixture : 'live system summary'}`);
  console.log(`Runtime signal source: ${runtimeSignalsFixture ? runtimeSignalsFixture : 'none'}`);
  console.log('');
  console.log('Initial harness state');
  console.log(formatResolvedHarnessDebug(harness));

  if (runtimeSignals.length > 0) {
    const runtimeState = createRuntimeHarnessReactiveState();
    for (const signal of runtimeSignals) {
      const { adjustments, strategyShifts, goalAdjustments, subGoalAdjustments } = applyInLoopHarnessAdjustment(harness, runtimeState, signal, {
        userMessage: message,
        profile,
        provider,
        initialModel,
        forcedAgentProfile: forcedProfile,
        systemAuditSummary: auditSummary,
      });
      if (adjustments.length > 0 || strategyShifts.length > 0 || goalAdjustments.length > 0 || subGoalAdjustments.length > 0) {
        console.log('');
        console.log(`Applied runtime signal: ${signal.kind}${signal.toolName ? ` (${signal.toolName})` : ''}`);
        for (const adjustment of adjustments) {
          console.log(`  - ${adjustment.id}: ${adjustment.effect}`);
        }
        for (const adjustment of goalAdjustments) {
          console.log(`  - goal ${adjustment.from} -> ${adjustment.to}: ${adjustment.effect}`);
        }
        for (const adjustment of subGoalAdjustments) {
          console.log(`  - subgoal ${adjustment.from} -> ${adjustment.to}: ${adjustment.effect}`);
        }
        for (const shift of strategyShifts) {
          console.log(`  - strategy ${shift.from} -> ${shift.to}: ${shift.effect}`);
        }
      }
    }

    console.log('');
    console.log('Final adapted harness state');
    console.log(formatResolvedHarnessDebug(harness));
  }
}

main();
