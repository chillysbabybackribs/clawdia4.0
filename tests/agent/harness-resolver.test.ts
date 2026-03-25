import { describe, expect, it } from 'vitest';
import { classify } from '../../src/main/agent/classifier';
import {
  applyInLoopHarnessAdjustment,
  applyHarnessPromptModules,
  applyHarnessToolPolicy,
  buildHarnessDirectiveBlock,
  createRuntimeHarnessReactiveState,
  formatResolvedHarnessDebug,
  resolveHarness,
} from '../../src/main/agent/harness-resolver';
import type { SystemAuditSummary } from '../../src/main/agent/system-audit';
import { getToolsForGroup } from '../../src/main/agent/tool-builder';

function makeSummary(overrides: Partial<SystemAuditSummary> = {}): SystemAuditSummary {
  return {
    windowSize: 100,
    observedToolCalls: 0,
    observedRuns: 0,
    mostReliableTools: [],
    leastReliableTools: [],
    averageDurationByTool: {},
    repeatedRecentFailures: [],
    recoveryHeavyTools: [],
    rarelyUsedTools: [],
    categoryReliability: [],
    interventionObservedRecently: false,
    interventionResolvedRecently: false,
    subAgentSpawnObservedRecently: false,
    approvalObservedRecently: false,
    capabilityHealth: [],
    capabilityCategories: [],
    scenarioSummaries: [],
    workflowSummary: {
      strongestWorkflows: [],
      weakestWorkflows: [],
      highestFrictionWorkflows: [],
      sparseDataWarnings: [],
    },
    overallScore: 0,
    autoTuningHints: [],
    harnessLearningSummaries: [],
    ...overrides,
  };
}

describe('resolveHarness()', () => {
  it('falls back to default_operator when nothing higher priority applies', () => {
    const profile = classify('What can you help me with today?');
    const harness = resolveHarness({
      userMessage: 'What can you help me with today?',
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.id).toBe('default_operator');
    expect(harness.actualExecutionMode).toBe('direct');
  });

  it('uses priority order when multiple harnesses apply', () => {
    const message = 'Compare recent laptop prices and write a report with evidence';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'openai',
      initialModel: 'gpt-5.4-mini',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.id).toBe('research');
    expect(harness.matchedHarnessIds).toContain('default_operator');
  });

  it('downgrades requested planning mode when planning is disabled', () => {
    const profile = classify('Apply a bulk filesystem move plan to sensitive files');
    const harness = resolveHarness({
      userMessage: 'Apply a bulk filesystem move plan to sensitive files',
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.id).toBe('high_safety');
    expect(harness.requestedExecutionMode).toBe('plan_then_execute');
    expect(harness.actualExecutionMode).toBe('direct');
    expect(harness.downgradeReason).toContain('planning disabled');
  });

  it('biases browser over desktop when GUI health is degraded', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary({
        capabilityHealth: [
          {
            subsystem: 'gui_automation',
            category: 'gui',
            status: 'degraded',
            declaredAvailable: true,
            observedRecently: true,
            sampleSize: 5,
            degraded: true,
            disabledStaticConstraint: false,
            functionalityScore: 3,
            reliabilityScore: 3,
            uxScore: 3,
            completenessScore: 3,
            confidenceScore: 8,
          },
          {
            subsystem: 'browser_automation',
            category: 'browser',
            status: 'healthy',
            declaredAvailable: true,
            observedRecently: true,
            sampleSize: 5,
            degraded: false,
            disabledStaticConstraint: false,
            functionalityScore: 8,
            reliabilityScore: 8,
            uxScore: 8,
            completenessScore: 8,
            confidenceScore: 8,
          },
        ],
      }),
    });

    expect(harness.id).toBe('browser_transaction');
    expect(harness.toolPolicy.discourageFamilies).toContain('desktop');
    expect(harness.promptPolicy.directiveLines?.some((line) => line.includes('GUI automation health is degraded'))).toBe(true);
  });

  it('only applies the coding harness when classification warrants it', () => {
    const general = resolveHarness({
      userMessage: 'Open the browser and summarize the page',
      profile: classify('Open the browser and summarize the page'),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const coding = resolveHarness({
      userMessage: 'Edit src/main/agent/loop.ts and fix the bug',
      profile: classify('Edit src/main/agent/loop.ts and fix the bug'),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(general.id).not.toBe('coding');
    expect(coding.id).toBe('coding');
  });

  it('adds narrow-path guidance when workflow cohesion is low', () => {
    const harness = resolveHarness({
      userMessage: 'Compare browser results and write a report',
      profile: classify('Compare browser results and write a report'),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary({
        observedRuns: 5,
        capabilityHealth: [
          {
            subsystem: 'browser_automation',
            category: 'browser',
            status: 'healthy',
            declaredAvailable: true,
            observedRecently: true,
            sampleSize: 5,
            degraded: false,
            disabledStaticConstraint: false,
            functionalityScore: 8,
            reliabilityScore: 8,
            uxScore: 8,
            completenessScore: 8,
            confidenceScore: 0.9,
          },
        ],
        scenarioSummaries: [
          {
            scenario: { id: 's1', name: 'S1', description: 'test', tags: [] },
            runCount: 5,
            completionRate: 0.4,
            avgDurationMs: 1000,
            avgToolCalls: 5,
            workflowCompletionRate: 0.4,
            averageDurationMs: 1000,
            averageToolCalls: 5,
            earlyFailureRate: 0.2,
            lateFailureRate: 0.2,
            interventionRate: 0,
            approvalRate: 0,
            recoveryRate: 0.5,
            crossSubsystemCount: 2,
            retryBurden: 2.2,
            workflowEfficiencyScore: 4.1,
            workflowCohesionScore: 4.5,
            workflowConfidenceScore: 0.8,
            failureStepDistribution: [],
            fragileTransitions: [],
            repeatedFailureClusterCount: 0,
            pathSummary: {},
            failureLocalizationSummary: { failureStepDistribution: [], repeatedFailureClusterCount: 0 },
            transitionSummary: { fragileTransitions: [] },
            recoveryPathSummary: {},
            primaryFailureTools: [],
            primaryFailureSubsystems: [],
          },
        ],
      }),
    });

    expect(harness.branchingGuidance).toBe('narrow_path');
    expect(harness.retryGuidance).toBe('verify_before_retry');
    expect(harness.adaptationReasons).toContain('low workflow cohesion or elevated retry burden');
  });

  it('adds fragile-transition caution and repeated-failure demotion', () => {
    const harness = resolveHarness({
      userMessage: 'Compare browser results and write a report',
      profile: classify('Compare browser results and write a report'),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary({
        observedRuns: 6,
        capabilityHealth: [],
        scenarioSummaries: [
          {
            scenario: { id: 'fragile', name: 'Fragile', description: 'test', tags: [] },
            runCount: 6,
            completionRate: 0.3,
            avgDurationMs: 1000,
            avgToolCalls: 6,
            workflowCompletionRate: 0.3,
            averageDurationMs: 1000,
            averageToolCalls: 6,
            earlyFailureRate: 0.6,
            lateFailureRate: 0.2,
            interventionRate: 0,
            approvalRate: 0,
            recoveryRate: 0.5,
            crossSubsystemCount: 2,
            retryBurden: 2.5,
            workflowEfficiencyScore: 4,
            workflowCohesionScore: 4,
            workflowConfidenceScore: 0.9,
            mostCommonFailureTool: 'shell_exec',
            mostCommonFailureSubsystem: 'shell_cli',
            failureStepDistribution: [{ stepIndex: 1, count: 2 }],
            fragileTransitions: [{ transition: 'browser -> filesystem', failingRuns: 2, totalRuns: 3, failureRate: 0.67 }],
            repeatedFailureClusterCount: 2,
            pathSummary: {},
            failureLocalizationSummary: {
              mostCommonFailureStepIndex: 1,
              mostCommonFailureTool: 'shell_exec',
              mostCommonFailureSubsystem: 'shell_cli',
              failureStepDistribution: [{ stepIndex: 1, count: 2 }],
              repeatedFailureClusterCount: 2,
            },
            transitionSummary: {
              fragileTransitions: [{ transition: 'browser -> filesystem', failingRuns: 2, totalRuns: 3, failureRate: 0.67 }],
            },
            recoveryPathSummary: {},
            primaryFailureTools: [{ toolName: 'shell_exec', count: 2 }],
            primaryFailureSubsystems: [{ subsystem: 'shell_cli', count: 2 }],
          },
        ],
      }),
    });

    expect(harness.promptPolicy.directiveLines?.some((line) => line.includes('Fragile transition observed'))).toBe(true);
    expect(harness.toolPolicy.demotedTools).toContain('shell_exec');
    expect(harness.retryGuidance).toBe('avoid_repeated_retries');
  });

  it('raises verification guidance when late failures dominate', () => {
    const harness = resolveHarness({
      userMessage: 'Open LibreOffice and export the current document',
      profile: classify('Open LibreOffice and export the current document'),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary({
        observedRuns: 6,
        scenarioSummaries: [
          {
            scenario: { id: 'late', name: 'Late', description: 'test', tags: [] },
            runCount: 6,
            completionRate: 0.4,
            avgDurationMs: 1000,
            avgToolCalls: 6,
            workflowCompletionRate: 0.4,
            averageDurationMs: 1000,
            averageToolCalls: 6,
            earlyFailureRate: 0.1,
            lateFailureRate: 0.7,
            interventionRate: 0,
            approvalRate: 0,
            recoveryRate: 0.5,
            crossSubsystemCount: 2,
            retryBurden: 1.5,
            workflowEfficiencyScore: 5,
            workflowCohesionScore: 5,
            workflowConfidenceScore: 0.9,
            failureStepDistribution: [{ stepIndex: 4, count: 3 }],
            fragileTransitions: [],
            repeatedFailureClusterCount: 0,
            pathSummary: {},
            failureLocalizationSummary: {
              mostCommonFailureStepIndex: 4,
              failureStepDistribution: [{ stepIndex: 4, count: 3 }],
              repeatedFailureClusterCount: 0,
            },
            transitionSummary: { fragileTransitions: [] },
            recoveryPathSummary: {},
            primaryFailureTools: [],
            primaryFailureSubsystems: [],
          },
        ],
      }),
    });

    expect(harness.safetyPolicy.elevatedVerification).toBe(true);
    expect(harness.responsePolicy.requireVerificationSummary).toBe(true);
  });

  it('applies learned browser-over-gui starting bias when confidence is sufficient', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary({
        harnessLearningSummaries: [
          {
            patternKey: 'browser_transaction:complete_action',
            harnessId: 'browser_transaction',
            baseGoal: 'complete_action',
            sampleSize: 4,
            completionRate: 0.75,
            successfulHarnesses: [{ harnessId: 'browser_transaction', count: 3 }],
            failingHarnesses: [{ harnessId: 'browser_transaction', count: 1 }],
            successfulStartingStrategies: [{ strategy: 'browser_over_gui', count: 2 }],
            failingStartingStrategies: [{ strategy: 'direct_balanced', count: 1 }],
            repeatedGoalTightenings: [],
            repeatedStageStalls: [],
            repeatedFragileTransitions: [],
            repeatedFailingToolFamilies: [{ family: 'desktop', count: 2 }],
            evidenceSummary: ['browser_transaction:complete_action completed 3/4 recent runs.'],
            confidence: { score: 0.8, sampleSize: 4, recentWindowSize: 12, sparse: false },
            optimizationHints: [
              {
                id: 'prefer_harness_start',
                kind: 'prefer_harness_start',
                reason: 'Recent browser_transaction runs completed reliably.',
                effect: 'Prefer browser_transaction when this class matches.',
                confidence: { score: 0.8, sampleSize: 4, recentWindowSize: 12, sparse: false },
                preferHarnessId: 'browser_transaction',
              },
              {
                id: 'prefer_browser_over_gui_start',
                kind: 'prefer_strategy_start',
                reason: 'Recent similar runs repeatedly shifted toward browser-over-GUI execution.',
                effect: 'Start closer to browser_over_gui and demote desktop paths earlier.',
                confidence: { score: 0.8, sampleSize: 4, recentWindowSize: 12, sparse: false },
                preferStrategy: 'browser_over_gui',
                demoteFamily: 'desktop',
              },
            ],
          },
        ],
      }),
    });

    expect(harness.learningPatternKey).toBe('browser_transaction:complete_action');
    expect(harness.currentStrategy).toBe('browser_over_gui');
    expect(harness.toolPolicy.discourageFamilies).toContain('desktop');
    expect(harness.learningInfluencedStart).toBe(true);
    expect(harness.appliedLearningHints.map((hint) => hint.id)).toContain('prefer_browser_over_gui_start');
  });

  it('ignores sparse learning summaries', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary({
        harnessLearningSummaries: [
          {
            patternKey: 'coding:modify_workspace',
            harnessId: 'coding',
            baseGoal: 'modify_workspace',
            sampleSize: 1,
            completionRate: 1,
            successfulHarnesses: [{ harnessId: 'coding', count: 1 }],
            failingHarnesses: [],
            successfulStartingStrategies: [{ strategy: 'low_shell_dependence', count: 1 }],
            failingStartingStrategies: [],
            repeatedGoalTightenings: [],
            repeatedStageStalls: [],
            repeatedFragileTransitions: [],
            repeatedFailingToolFamilies: [{ family: 'shell', count: 1 }],
            evidenceSummary: ['Only 1 recent run matched coding:modify_workspace; learning stayed advisory.'],
            confidence: { score: 0.2, sampleSize: 1, recentWindowSize: 12, sparse: true },
            optimizationHints: [
              {
                id: 'prefer_low_shell_dependence',
                kind: 'prefer_strategy_start',
                reason: 'One run shifted away from shell-heavy execution.',
                effect: 'Start with lower shell dependence.',
                confidence: { score: 0.2, sampleSize: 1, recentWindowSize: 12, sparse: true },
                preferStrategy: 'low_shell_dependence',
                demoteFamily: 'shell',
              },
            ],
          },
        ],
      }),
    });

    expect(harness.currentStrategy).not.toBe('low_shell_dependence');
    expect(harness.learningInfluencedStart).toBe(false);
    expect(harness.appliedLearningHints).toHaveLength(0);
  });

  it('keeps adaptation minimal when audit data is sparse', () => {
    const harness = resolveHarness({
      userMessage: 'Compare browser results and write a report',
      profile: classify('Compare browser results and write a report'),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary({
        observedRuns: 1,
        workflowSummary: {
          strongestWorkflows: [],
          weakestWorkflows: [],
          highestFrictionWorkflows: [],
          sparseDataWarnings: ['not enough runs'],
        },
      }),
    });

    expect(harness.adaptationReasons).toContain('sparse audit data guard');
    expect(harness.auditSignalsUsed).toContain('audit:sparse_data');
  });
});

describe('harness policy helpers', () => {
  it('injects harness prompt modules minimally', () => {
    const modules = applyHarnessPromptModules(new Set(['browser']), {
      addModules: ['research'],
    });

    expect(modules.has('browser')).toBe(true);
    expect(modules.has('research')).toBe(true);
  });

  it('reorders tools to prefer deterministic browser paths first', () => {
    const tools = applyHarnessToolPolicy(getToolsForGroup('full'), {
      deterministicBrowserFirst: true,
      preferFamilies: ['browser'],
      discourageFamilies: ['desktop'],
    });
    const firstNames = tools.slice(0, 6).map((tool) => tool.name);
    expect(firstNames).toContain('browser_run_harness');
    expect(firstNames).toContain('browser_run_playbook');
  });

  it('suppresses a family and demotes repeated-failure tools when requested', () => {
    const tools = applyHarnessToolPolicy(getToolsForGroup('full'), {
      suppressFamilies: ['desktop'],
      demotedTools: ['shell_exec'],
    });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('gui_interact');
    expect(names[names.length - 1]).toBe('shell_exec');
  });

  it('builds a compact directive block and debug summary', () => {
    const harness = resolveHarness({
      userMessage: 'Compare browser results and write a report',
      profile: classify('Compare browser results and write a report'),
      provider: 'openai',
      initialModel: 'gpt-5.4-mini',
      systemAuditSummary: makeSummary(),
    });

    expect(buildHarnessDirectiveBlock(harness)).toContain('[HARNESS]');
    expect(buildHarnessDirectiveBlock(harness)).toContain('reactive_note=');
    expect(formatResolvedHarnessDebug(harness)).toContain(`Harness: ${harness.id}`);
    expect(formatResolvedHarnessDebug(harness)).toContain('Adaptation reasons:');
  });

  it('applies repeated tool failure as an in-loop demotion while preserving the base harness', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'shell_exec',
      toolFamily: 'shell',
      success: false,
    }, {
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'shell_exec',
      toolFamily: 'shell',
      success: false,
    }, {
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.baseHarnessId).toBe('coding');
    expect(harness.hadInLoopAdaptation).toBe(true);
    expect(harness.toolPolicy.demotedTools).toContain('shell_exec');
    expect(harness.retryGuidance).toBe('verify_before_retry');
    expect(harness.currentStrategy).toBe('low_shell_dependence');
    expect(result.adjustments[0]?.trigger).toBe('repeated tool failure in current run');
  });

  it('suppresses desktop mid-run after repeated desktop failures when browser remains viable', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: false,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: false,
    }, input);

    expect(harness.toolPolicy.suppressFamilies).toContain('desktop');
    expect(harness.toolPolicy.preferFamilies).toContain('browser');
    expect(harness.branchingGuidance).toMatch(/narrow_path|deterministic_first/);
  });

  it('escalates verification posture after late verification failure in the same run', () => {
    const message = 'Compare browser findings and write a report to disk';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'browser_extract',
      toolFamily: 'browser',
      success: true,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'file_write',
      toolFamily: 'filesystem',
      success: true,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'verification_failed',
      iterationIndex: 2,
      verificationType: 'file_exists',
    }, input);

    expect(harness.safetyPolicy.elevatedVerification).toBe(true);
    expect(harness.responsePolicy.requireVerificationSummary).toBe(true);
    expect(result.adjustments[0]?.trigger).toBe('late verification failure in current run');
  });

  it('includes in-loop adjustments in the directive block and debug summary', () => {
    const message = 'Compare browser findings and write a report to disk';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'human_intervention_required',
      iterationIndex: 1,
      toolName: 'browser_click',
      toolFamily: 'browser',
      detail: 'captcha required',
    }, input);

    expect(buildHarnessDirectiveBlock(harness)).toContain('in_loop_adjustments=1');
    expect(buildHarnessDirectiveBlock(harness)).toContain('base_strategy=');
    expect(buildHarnessDirectiveBlock(harness)).toContain('strategy=');
    expect(buildHarnessDirectiveBlock(harness)).toContain('runtime_adjustment=');
    expect(formatResolvedHarnessDebug(harness)).toContain('Had in-loop adaptation: yes');
    expect(formatResolvedHarnessDebug(harness)).toContain('Base strategy:');
    expect(formatResolvedHarnessDebug(harness)).toContain('Current strategy:');
  });

  it('shifts to browser_over_gui after repeated desktop failures', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: false,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: false,
    }, input);

    expect(harness.currentStrategy).toBe('browser_over_gui');
    expect(harness.strategyShiftHistory[0]?.to).toBe('browser_over_gui');
    expect(result.strategyShifts[0]?.trigger).toBe('gui path collapse');
  });

  it('shifts to low_shell_dependence after repeated shell failures', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'shell_exec',
      toolFamily: 'shell',
      success: false,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'shell_exec',
      toolFamily: 'shell',
      success: false,
    }, input);

    expect(harness.currentStrategy).toBe('low_shell_dependence');
    expect(harness.toolPolicy.discourageFamilies).toContain('shell');
    expect(harness.toolPolicy.demotedTools).toContain('shell_exec');
  });

  it('shifts to deterministic_browser_first after repeated browser underperformance', () => {
    const message = 'Compare browser findings and write a report to disk';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'browser_navigate',
      toolFamily: 'browser',
      success: false,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'browser_navigate',
      toolFamily: 'browser',
      success: false,
    }, input);

    expect(harness.currentStrategy).toBe('deterministic_browser_first');
    expect(harness.toolPolicy.deterministicBrowserFirst).toBe(true);
    expect(result.strategyShifts[0]?.trigger).toBe('open-ended browser underperformance');
  });

  it('shifts to verify_before_write after a late verification failure on write-heavy work', () => {
    const message = 'Compare browser findings and write a report to disk';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'browser_extract',
      toolFamily: 'browser',
      success: true,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'file_write',
      toolFamily: 'filesystem',
      success: true,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'verification_failed',
      iterationIndex: 3,
      verificationType: 'file_exists',
    }, input);

    expect(harness.currentStrategy).toBe('verify_before_write');
    expect(result.strategyShifts[0]?.trigger).toBe('late-stage workflow fragility');
  });

  it('shifts to recovery_constrained after repeated recovery pressure', () => {
    const message = 'Compare browser findings and write a report to disk';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'recovery_invoked',
      iterationIndex: 1,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'recovery_invoked',
      iterationIndex: 2,
    }, input);

    expect(harness.currentStrategy).toBe('recovery_constrained');
    expect(result.strategyShifts[0]?.to).toBe('recovery_constrained');
  });

  it('shifts to intervention_waiting when human intervention is required', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'human_intervention_required',
      iterationIndex: 1,
      toolName: 'browser_click',
      toolFamily: 'browser',
      detail: 'captcha required',
    }, input);

    expect(harness.currentStrategy).toBe('intervention_waiting');
    expect(result.strategyShifts[0]?.trigger).toBe('human intervention required');
  });

  it('infers complete_action for transactional browser work', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const harness = resolveHarness({
      userMessage: message,
      profile: classify(message),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.baseGoal).toBe('complete_action');
  });

  it('infers compare_and_report for research comparison work', () => {
    const message = 'Compare browser findings and write a report to disk';
    const harness = resolveHarness({
      userMessage: message,
      profile: classify(message),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.baseGoal).toBe('compare_and_report');
  });

  it('infers modify_workspace for coding work', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const harness = resolveHarness({
      userMessage: message,
      profile: classify(message),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.baseGoal).toBe('modify_workspace');
  });

  it('tightens evidence tasks back toward evidence collection when action drift appears', () => {
    const message = 'Compare browser findings and write a report to disk';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: true,
    }, input);

    expect(result.goalAdjustments[0]?.trigger).toBe('evidence goal being treated like an action goal');
    expect(harness.responsePolicy.evidenceOrientedFinish).toBe(true);
  });

  it('tightens action tasks back toward completion when exploration fails repeatedly', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'browser_search',
      toolFamily: 'browser',
      success: false,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'browser_search',
      toolFamily: 'browser',
      success: false,
    }, input);

    expect(result.goalAdjustments.some((adjustment) => adjustment.trigger === 'action goal being treated like an exploratory goal')).toBe(true);
    expect(harness.currentGoal).toBe('complete_action');
  });

  it('tightens change work toward safe verified application on verification failure', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'file_edit',
      toolFamily: 'filesystem',
      success: true,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'file_write',
      toolFamily: 'filesystem',
      success: true,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'verification_failed',
      iterationIndex: 3,
      verificationType: 'file_exists',
    }, input);

    expect(harness.currentGoal).toBe('safely_apply_change');
    expect(result.goalAdjustments[0]?.to).toBe('safely_apply_change');
  });

  it('specializes to intervention_gated_completion when intervention is required', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'human_intervention_required',
      iterationIndex: 1,
      toolName: 'browser_click',
      toolFamily: 'browser',
      detail: 'captcha required',
    }, input);

    expect(harness.currentGoal).toBe('intervention_gated_completion');
    expect(result.goalAdjustments[0]?.trigger).toBe('intervention-gated goal');
  });

  it('decomposes complete_action into bounded stages', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const harness = resolveHarness({
      userMessage: message,
      profile: classify(message),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.baseSubGoalPlan).toEqual(['navigate', 'locate_target', 'perform_action', 'verify_outcome']);
    expect(harness.currentSubGoal).toBe('navigate');
  });

  it('decomposes compare_and_report into bounded stages', () => {
    const message = 'Compare browser findings and write a report to disk';
    const harness = resolveHarness({
      userMessage: message,
      profile: classify(message),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.baseSubGoalPlan).toEqual(['gather', 'extract', 'compare', 'synthesize', 'produce_report']);
    expect(harness.currentSubGoal).toBe('gather');
  });

  it('decomposes modify_workspace into bounded stages', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const harness = resolveHarness({
      userMessage: message,
      profile: classify(message),
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    expect(harness.baseSubGoalPlan).toEqual(['inspect_state', 'prepare_change', 'apply_change', 'verify_change']);
    expect(harness.currentSubGoal).toBe('inspect_state');
  });

  it('advances complete_action from navigate to locate_target on navigation success', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'browser_navigate',
      toolFamily: 'browser',
      success: true,
    }, input);

    expect(harness.currentSubGoal).toBe('locate_target');
    expect(result.subGoalAdjustments[0]?.trigger).toBe('navigation success');
  });

  it('keeps verification stage on late verification failure', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'file_read',
      toolFamily: 'filesystem',
      success: true,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'file_edit',
      toolFamily: 'filesystem',
      success: true,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 3,
      toolName: 'file_write',
      toolFamily: 'filesystem',
      success: true,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'verification_failed',
      iterationIndex: 4,
      verificationType: 'file_exists',
    }, input);

    expect(harness.currentSubGoal).toBe('verify_change');
    expect(result.subGoalAdjustments.some((adjustment) => adjustment.trigger === 'verification-stage fragility')).toBe(true);
  });

  it('corrects evidence-stage drift back toward gather/extract', () => {
    const message = 'Compare browser findings and write a report to disk';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'browser_read_page',
      toolFamily: 'browser',
      success: true,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: false,
    }, input);

    expect(result.subGoalAdjustments.some((adjustment) => adjustment.trigger === 'premature action on evidence/report goal')).toBe(true);
    expect(harness.currentSubGoal).toBe('gather');
  });

  it('prevents premature writes by keeping change work in inspect/prepare stages', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'file_write',
      toolFamily: 'filesystem',
      success: false,
    }, input);

    expect(harness.currentSubGoal).toBe('inspect_state');
    expect(result.subGoalAdjustments[0]?.trigger).toBe('apply-before-inspect on change goals');
  });

  it('moves to wait_for_intervention on intervention signals', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'human_intervention_required',
      iterationIndex: 1,
      toolName: 'browser_click',
      toolFamily: 'browser',
    }, input);

    expect(harness.currentSubGoal).toBe('wait_for_intervention');
    expect(result.subGoalAdjustments[0]?.to).toBe('wait_for_intervention');
  });

  it('prevents false stage advancement when verification does not support progress', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'browser_navigate',
      toolFamily: 'browser',
      success: true,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'browser_click',
      toolFamily: 'browser',
      success: true,
    }, input);
    const result = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'verification_failed',
      iterationIndex: 3,
      verificationType: 'dom_state',
    }, input);

    expect(harness.currentSubGoal).toBe('verify_outcome');
    expect(result.subGoalAdjustments.some((adjustment) => adjustment.to === 'verify_outcome')).toBe(true);
  });

  it('does not re-apply identical sub-goal adjustments redundantly', () => {
    const message = 'Edit src/main/agent/loop.ts and fix the bug';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'file_write',
      toolFamily: 'filesystem',
      success: false,
    }, input);
    const second = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'file_write',
      toolFamily: 'filesystem',
      success: false,
    }, input);

    expect(harness.subGoalAdjustments).toHaveLength(1);
    expect(second.subGoalAdjustments).toHaveLength(0);
  });

  it('prevents redundant identical goal tightening', () => {
    const message = 'Compare browser findings and write a report to disk';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: true,
    }, input);
    const second = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: true,
    }, input);

    expect(harness.goalAdjustments).toHaveLength(1);
    expect(second.goalAdjustments).toHaveLength(0);
  });

  it('does not re-apply the same strategy shift redundantly', () => {
    const message = 'Go to the signup page, fill the form, and submit it';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });
    const state = createRuntimeHarnessReactiveState();
    const input = {
      userMessage: message,
      profile,
      provider: 'anthropic' as const,
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    };

    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 1,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: false,
    }, input);
    applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 2,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: false,
    }, input);
    const secondAttempt = applyInLoopHarnessAdjustment(harness, state, {
      kind: 'tool_result',
      iterationIndex: 3,
      toolName: 'gui_interact',
      toolFamily: 'desktop',
      success: false,
    }, input);

    expect(harness.strategyShiftHistory).toHaveLength(1);
    expect(secondAttempt.strategyShifts).toHaveLength(0);
  });

  it('adds anti-blank-navigation guidance to the research harness', () => {
    const message = 'Research 3 competitors and save a markdown comparison with pricing and links';
    const profile = classify(message);
    const harness = resolveHarness({
      userMessage: message,
      profile,
      provider: 'anthropic',
      initialModel: 'claude-sonnet-4-6',
      systemAuditSummary: makeSummary(),
    });

    const directiveBlock = buildHarnessDirectiveBlock(harness);
    expect(directiveBlock).toContain('base_goal=');
    expect(directiveBlock).toContain('goal=');
    expect(directiveBlock).toContain('subgoal=');
    expect(directiveBlock).toContain('Never navigate to about:blank or any empty URL during research.');
    expect(directiveBlock).toContain('use browser_read_page or browser_extract instead of navigating away');
    expect(formatResolvedHarnessDebug(harness)).toContain('Base sub-goal plan:');
    expect(formatResolvedHarnessDebug(harness)).toContain('Current sub-goal:');
  });
});
