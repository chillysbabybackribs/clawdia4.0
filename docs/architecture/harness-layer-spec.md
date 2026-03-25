# Clawdia Harness Layer Specification

Source basis: current `src/main` and `tests/agent` implementation as audited on 2026-03-24.

## 1. Executive Summary

Clawdia already has a real runtime stack: the core agent loop classifies tasks, assembles prompts, chooses provider clients, dispatches tools, applies approvals and human intervention gates, records audit telemetry, and persists run artifacts and scorecards. The missing piece is not another runtime, but a small behavior layer that can consistently choose orchestration posture above runtime execution and below task UX.

The proposed harness layer is that behavior layer. It should sit between task classification/runtime context and the existing loop/provider/tool surfaces. Its job is to choose execution posture, prompt policy, tool preference, model strategy, safety posture, and finish/verification contract for a run. It should not replace tool implementations, provider adapters, audit storage, or renderer routing.

Clawdia should build this now, but narrowly. The current codebase already exposes the right integration points in [`src/main/agent/loop.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts), [`src/main/agent/loop-setup.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-setup.ts), [`src/main/agent/prompt-builder.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/prompt-builder.ts), [`src/main/agent/workflow.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/workflow.ts), [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts), and [`src/main/agent/tool-builder.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/tool-builder.ts). The first version should reuse those surfaces rather than introduce a second policy or health plane.

## 2. Goals / Non-Goals

### Goals

- Add a first-class, provider-neutral behavior/orchestration layer above runtime and below UX.
- Reuse the existing loop, prompt, provider, tool, approval, verification, memory, playbook, browser harness, and audit infrastructure.
- Make runtime health and drift data from [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts) the canonical source for harness-level adaptation.
- Support app-wide operator workflows, not only coding.
- Keep v1 minimal enough to wire into the current loop without redesigning it.

### Non-Goals

- Not a Claude-first abstraction. Provider wire logic stays in [`src/main/agent/provider/*.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider).
- Not a coding-only product posture. Coding remains one harness specialization among browser, filesystem, desktop, research, and other operator work.
- Not a new runtime. Raw tool execution, browser/session management, file mutation guards, approval queues, and run persistence remain where they are.
- Not a giant policy matrix. V1 should avoid per-provider x per-tool x per-mode configuration sprawl.
- Not a duplicate audit/health system. Harnesses consume system-audit outputs; they do not create a second health score pipeline.

## 3. Current-State Audit Summary

### Existing capabilities that support a harness layer

- The core orchestration spine already exists in [`src/main/agent/loop.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts). `runAgentLoop()` classifies the task, applies profile overrides, builds prompts, runs pre-LLM setup, optionally runs execution planning, optionally short-circuits through site harness or Bloodhound executors, dispatches tool calls, and records verification and run telemetry.
- Pre-LLM context assembly already exists in [`src/main/agent/loop-setup.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-setup.ts). `runPreLLMSetup()` concurrently gathers memory, conversation recall, site context, playbooks, site harness context, browser execution sketches, execution graph scaffolds, desktop capability state, and app routing decisions.
- Prompt assembly is already modular in [`src/main/agent/prompt-builder.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/prompt-builder.ts). `buildStaticPrompt()` composes module-specific prompt files; `buildDynamicPrompt()` injects execution constraints, system awareness, memory/recall/site/playbook/harness context, desktop state, and optional project root grounding.
- Provider abstraction is already normalized in [`src/main/agent/provider/base.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/base.ts), [`src/main/agent/provider/types.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/types.ts), and [`src/main/agent/provider/factory.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/factory.ts). The rest of the app consumes `ProviderClient`, `NormalizedMessage`, `NormalizedToolDefinition`, and `LLMResponse` rather than provider-native wire objects.
- Tool routing and execution are already layered in [`src/main/agent/classifier.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/classifier.ts), [`src/main/agent/tool-builder.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/tool-builder.ts), and [`src/main/agent/loop-dispatch.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-dispatch.ts).
- Safety and guarded execution already exist through [`src/main/agent/approval-manager.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/approval-manager.ts), [`src/main/agent/human-intervention-manager.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/human-intervention-manager.ts), [`src/main/agent/file-lock-manager.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/file-lock-manager.ts), and [`src/main/agent/verification.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/verification.ts).
- Memory and learned execution hints already exist in [`src/main/db/memory.ts`](/home/dp/Desktop/clawdia4.0/src/main/db/memory.ts), [`src/main/db/browser-playbooks.ts`](/home/dp/Desktop/clawdia4.0/src/main/db/browser-playbooks.ts), and the Bloodhound-related modules under [`src/main/agent/bloodhound`](/home/dp/Desktop/clawdia4.0/src/main/agent/bloodhound).
- Browser-native deterministic harnessing already exists in [`src/main/browser/site-harness.ts`](/home/dp/Desktop/clawdia4.0/src/main/browser/site-harness.ts) and is surfaced through [`src/main/browser/manager.ts`](/home/dp/Desktop/clawdia4.0/src/main/browser/manager.ts).
- Runtime truth and scorecard plumbing already exist in [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts), backed by telemetry in [`src/main/db/audit-tool-telemetry.ts`](/home/dp/Desktop/clawdia4.0/src/main/db/audit-tool-telemetry.ts) and run records in [`src/main/db/runs.ts`](/home/dp/Desktop/clawdia4.0/src/main/db/runs.ts).

### Important gaps and blockers

- Execution planning is present but statically disabled: [`src/main/agent/runtime-constraints.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/runtime-constraints.ts) sets `EXECUTION_PLANNING_ENABLED = false`. A harness can choose planning posture conceptually, but must treat plan approval flow as partially wired and disabled by runtime policy today.
- Execution graph scaffolding and graph execution exist, but they are not general runtime foundations yet. [`src/main/agent/task-compiler.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/task-compiler.ts) and [`src/main/agent/graph-executor.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/graph-executor.ts) expose usable scaffolding, but loop code already guards them, and the graph path is explicitly stoppable rather than canonical.
- Provider capability metadata is still thin. The shared model registry in [`src/shared/model-registry.ts`](/home/dp/Desktop/clawdia4.0/src/shared/model-registry.ts) exposes provider, family, and tier, but not richer harness-facing capability flags beyond what adapters expose directly, such as `supportsHarnessGeneration`.
- Existing naming is overloaded. [`src/main/agent/loop-harness.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-harness.ts) is a CLI-Anything harness-generation pipeline, and [`src/main/browser/site-harness.ts`](/home/dp/Desktop/clawdia4.0/src/main/browser/site-harness.ts) is a deterministic form harness system. The new architecture must not reuse "harness" to mean "CLI plugin generator" or "browser form replay" at the top level.

## 4. Conceptual Stack

### Clawdia runtime

The runtime is the execution substrate that owns:

- run-loop orchestration and iteration control in [`src/main/agent/loop.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts)
- pre-LLM context loading in [`src/main/agent/loop-setup.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-setup.ts)
- tool schemas and tool dispatch in [`src/main/agent/tool-builder.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/tool-builder.ts) and [`src/main/agent/loop-dispatch.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-dispatch.ts)
- browser/session/tab execution in [`src/main/browser/manager.ts`](/home/dp/Desktop/clawdia4.0/src/main/browser/manager.ts)
- desktop/shell/filesystem/browser executors under [`src/main/agent/executors`](/home/dp/Desktop/clawdia4.0/src/main/agent/executors)
- approvals, human intervention, file locking, and verification
- run events, artifacts, telemetry, and persistence

### Harness layer

The harness layer should be a behavior-selection layer that determines how a run should use the runtime. To avoid collision with existing subsystem names such as [`src/main/agent/loop-harness.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-harness.ts) and [`src/main/browser/site-harness.ts`](/home/dp/Desktop/clawdia4.0/src/main/browser/site-harness.ts), internal implementation names should prefer `behavior harness` or `execution harness`. It should output a run profile such as execution mode, prompt modules/policies, provider strategy, tool preference, safety posture, memory posture, and finish contract.

### Provider/model layer

Provider adapters convert normalized prompt/tool/message structures to provider-native APIs. This layer is defined today by [`src/main/agent/provider/base.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/base.ts), [`src/main/agent/provider/types.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/types.ts), and concrete adapters in [`src/main/agent/provider/anthropic-adapter.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/anthropic-adapter.ts), [`src/main/agent/provider/openai-adapter.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/openai-adapter.ts), and [`src/main/agent/provider/gemini-adapter.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/gemini-adapter.ts).

### UX/task-selection layer

Renderer/UI surfaces, run views, workflow plan approval UI, and operator-facing task entry remain above harness. This includes shared UI state and run display types in [`src/shared/types.ts`](/home/dp/Desktop/clawdia4.0/src/shared/types.ts) and renderer surfaces under [`src/renderer`](/home/dp/Desktop/clawdia4.0/src/renderer).

## 5. Harness Responsibilities

The harness layer should own:

- selecting an execution posture for the task: direct, plan-first, step-controlled, deterministic replay preferred, high-safety, or similar
- selecting prompt-policy modules and dynamic directives to add or suppress
- selecting provider/model strategy by phase, using normalized provider capabilities rather than provider-specific prompts
- selecting tool preference order, not tool implementation
- selecting safety and approval posture defaults
- selecting memory/recall/playbook/harness usage posture
- selecting verification depth and finish/reporting contract

The harness layer should not own:

- raw tool implementations
- browser/session/tab mechanics
- shell execution mechanics
- provider SDK calls and tool-call translation
- audit persistence internals
- scorecard computation logic
- renderer task routing or UI components

## 6. Harness Inputs

V1 harness resolution should consume only inputs that already exist in the source tree:

- task classification and prompt-module hints from [`src/main/agent/classifier.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/classifier.ts)
- forced agent profile overrides from [`src/main/agent/agent-profile-override.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/agent-profile-override.ts)
- provider/model registry data from [`src/shared/model-registry.ts`](/home/dp/Desktop/clawdia4.0/src/shared/model-registry.ts)
- runtime system awareness and capability health from [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts)
- scenario/workflow metrics from [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts), including `workflowEfficiencyScore`, `workflowCohesionScore`, failure-localization summaries, fragile transitions, and recovery-burden signals exposed through `ScenarioSummary`
- workspace/runtime context assembled in [`src/main/agent/loop-setup.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-setup.ts)
- current policy profile from [`src/main/agent/policy-engine.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/policy-engine.ts)
- execution-plan/router constraints from [`src/main/db/app-registry.ts`](/home/dp/Desktop/clawdia4.0/src/main/db/app-registry.ts) as already surfaced into `executionPlan`
- user/task mode signals already carried in `LoopOptions`, including provider, forced profile, allowed tools, and performance stance in [`src/main/agent/loop.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts)

## 7. Harness Outputs

The harness layer should produce a small resolved run contract:

- execution mode
  - requested by harness, but downgradable by runtime constraints
  - `direct`
  - `plan_then_execute`
  - `step_controlled`
  - `deterministic_first`
- prompt policy
  - prompt modules to include
  - additional harness directive block
  - memory/recall/playbook/harness injection posture
- provider strategy
  - preferred model tier or explicit model by phase
  - provider restrictions or fallbacks if a capability is unavailable
- tool policy
  - preferred tool families
  - discouraged tool families
  - whether deterministic browser harnesses and playbooks should be tried before open-ended exploration
- safety policy
  - baseline approval strictness
  - whether to bias toward browser over GUI based on degraded health
- verification contract
  - normal verification
  - elevated verification
  - deterministic replay success criteria
- response contract
  - expected finish shape, such as concise completion, artifact-oriented result, or trace-oriented summary

The resolved contract should record both requested and actual execution mode.

Example:

- requested: `plan_then_execute`
- actual: `direct`
- reason: planning disabled by [`src/main/agent/runtime-constraints.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/runtime-constraints.ts)

## 8. Minimal Harness Definition Schema

V1 should stay smaller than the earlier behavioral taxonomy. The following schema matches current source reality without introducing a giant matrix:

```ts
export interface HarnessDefinition {
  id: string;
  description: string;
  priority: number;
  applies(input: HarnessResolutionInput): boolean;
  executionMode: 'direct' | 'plan_then_execute' | 'step_controlled' | 'deterministic_first';
  promptPolicy?: {
    addModules?: Array<'browser' | 'coding' | 'filesystem' | 'research' | 'document' | 'desktop_apps' | 'self_knowledge' | 'bloodhound'>;
    directiveBlock?: string;
    preferSystemAwareness?: boolean;
    preferWorkspaceGrounding?: boolean;
  };
  providerStrategy?: {
    preferredTier?: 'fast' | 'balanced' | 'deep';
    phaseModels?: Partial<Record<'planning' | 'execution' | 'verification', string>>;
    requireCapabilities?: string[];
  };
  toolPolicy?: {
    preferFamilies?: Array<'browser' | 'desktop' | 'filesystem' | 'shell' | 'memory'>;
    discourageFamilies?: Array<'browser' | 'desktop' | 'filesystem' | 'shell' | 'memory'>;
    deterministicBrowserFirst?: boolean;
  };
  safetyPolicy?: {
    elevatedApproval?: boolean;
    preferHumanInterventionOverRetry?: boolean;
  };
  responsePolicy?: {
    requireVerificationSummary?: boolean;
    requireArtifactOrientedFinish?: boolean;
  };
}
```

Rationale:

- `memoryPolicy` should not be a top-level object in v1 because memory, recall, site context, playbook injection, and harness context are already loaded together in [`src/main/agent/loop-setup.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-setup.ts). A v1 harness only needs to choose whether they are preferred, suppressed, or elevated through prompt policy.
- `executionPolicy` is collapsed into `executionMode` because runtime execution-policy breadth is still small and planning/graph execution are not fully live.
- `safetyPolicy` and `responsePolicy` remain because they map directly to current runtime behavior without creating a new control plane.

Resolution rules:

- highest `priority` wins
- ties resolve by first match in registration order
- fallback is `default_operator`
- runtime may downgrade requested behavior when a dependency is disabled, degraded, or unavailable

## 9. Runtime Integration Points

The new harness layer should plug into existing runtime points instead of creating a separate loop.

### 1. Resolve harness immediately after classification

In [`src/main/agent/loop.ts:317`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts#L317), the loop currently does:

- `const profile = applyAgentProfileOverride(classify(userMessage), options.forcedAgentProfile);`

Add harness resolution immediately after this point. Inputs should include the classified `TaskProfile`, `LoopOptions`, selected provider/model, and latest `getSystemAuditSummary()` or `getSystemAwarenessBlock()` output.

### 2. Feed harness outputs into prompt assembly

Static prompt assembly is already centralized in [`src/main/agent/prompt-builder.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/prompt-builder.ts). Use harness outputs to:

- add or suppress prompt modules before `buildStaticPrompt()`
- append one harness directive block into `buildDynamicPrompt()`
- decide whether project-root grounding should be requested beyond current `shouldInjectProjectContext()`

### 3. Feed harness outputs into pre-LLM setup

`runPreLLMSetup()` in [`src/main/agent/loop-setup.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-setup.ts) already computes memory, recall, site context, playbooks, site harness context, browser execution sketch, graph scaffold, and desktop routing. The harness layer should not replicate this work. Instead, it should pass preferences such as:

- deterministic browser first
- allow/suppress execution sketch usage
- allow/suppress graph scaffold generation
- elevate desktop capability context for desktop operator harnesses

### 4. Feed harness outputs into execution planning

The hook already exists in [`src/main/agent/workflow.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/workflow.ts) and loop call sites at [`src/main/agent/loop.ts:676`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts#L676) and [`src/main/agent/loop.ts:696`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts#L696). Since `EXECUTION_PLANNING_ENABLED` is currently `false`, the harness should emit desired planning posture now but defer hard dependency on plan-first behavior until that runtime flag is intentionally enabled.

This must remain explicit in runtime state: the harness requests an execution mode, and runtime records the actual mode after applying constraints.

### 5. Feed harness outputs into tool routing and dispatch

Use harness `toolPolicy` to influence:

- allowed/discouraged tools before tool filtering in [`src/main/agent/tool-builder.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/tool-builder.ts)
- dispatch preferences in [`src/main/agent/loop-dispatch.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-dispatch.ts)
- deterministic-first browser behavior before open-ended browser loops

### 6. Feed harness outputs into provider/model selection

Provider neutrality should remain in [`src/main/agent/provider/factory.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/factory.ts) and the adapters. Harness resolution should only choose model tiers or explicit model ids via the existing model registry and `resolveModelForProvider()`.

## 10. Dependency on System Audit / Health

System audit should be the single runtime-truth source for harness adaptation. Harnesses should consume both capability health and workflow/scenario signals from that single audited source.

This is already implemented as:

- tool-level telemetry recording in [`src/main/agent/loop-dispatch.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-dispatch.ts) via `recordToolTelemetry()`
- summary/cache generation in [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts)
- prompt injection through `getSystemAwarenessBlock()` at [`src/main/agent/loop.ts:527`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts#L527)

Harness rules should consume these signals for decisions such as:

- prefer browser over GUI when GUI health is degraded
- avoid planning when planning capability is degraded or unproven
- treat sub-agents as optional when sub-agent swarm health is weak
- use smaller shell chunks when shell timeout drift is detected
- elevate approval expectations when intervention-heavy or recovery-heavy patterns are present
- avoid workflow shapes associated with weak `workflowCohesionScore`
- prefer narrower or more explicit stage boundaries when failure-localization data shows repeated early failure
- bias away from fragile transitions identified in recent scenario summaries
- prefer deterministic or reduced-branch execution when recovery burden is high

The harness layer must not compute its own health snapshot from raw run data. It should consume `SystemAuditSummary`, `CapabilityHealthSignal[]`, `ScenarioSummary[]`, `WorkflowScoreSummary`, `AutoTuningHint[]`, and `getSystemAwarenessBlock()` from [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts).

## 10.1 Closed-Loop Behavior

Harness behavior should be explicitly closed-loop:

- harness resolution influences execution posture
- execution posture changes actual tool usage, retries, verification, and intervention patterns
- execution updates runtime telemetry through [`src/main/agent/loop-dispatch.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-dispatch.ts)
- telemetry updates system-audit summaries and scorecards in [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts)
- subsequent harness resolution consumes those updated capability and workflow signals

This loop is core to the design. Harnesses are runtime behavior selectors informed by observed execution quality, not static presets.

## 11. Provider Neutrality Strategy

Provider neutrality in Clawdia should mean "normalize provider capabilities and pick strategies against that normalized shape," not "make every provider pretend to be Claude."

Rules:

- Provider wire differences stay inside the adapters in [`src/main/agent/provider/*.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider).
- Harnesses may depend on normalized provider facts only:
  - provider id
  - selected model
  - model tier/family from [`src/shared/model-registry.ts`](/home/dp/Desktop/clawdia4.0/src/shared/model-registry.ts)
  - explicit adapter flags such as `supportsHarnessGeneration`
- Harnesses must not inject provider-branded prompt language unless the user explicitly requests a provider-specific workflow.
- Harnesses may choose different model tiers for phases, but should do so through `resolveModelForProvider()` rather than hardcoding provider-native names in harness definitions.

Current reality to preserve:

- Anthropic and OpenAI adapters both expose `supportsHarnessGeneration = true` in [`src/main/agent/provider/anthropic-adapter.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/anthropic-adapter.ts) and [`src/main/agent/provider/openai-adapter.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/openai-adapter.ts).
- Gemini currently exposes `supportsHarnessGeneration = false` in [`src/main/agent/provider/gemini-adapter.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/provider/gemini-adapter.ts).
- Image tool-result handling differs across providers, but that should remain adapter behavior, not harness behavior.

## 12. Initial Harness Set

V1 should ship only a small set of harness definitions.

### 1. `default_operator`

- Default for general cross-domain operator tasks.
- Execution mode: `direct`
- Prompt policy: keep system awareness on, preserve classified modules, balanced response contract.

### 2. `browser_transaction`

- For live browser workflows where site harnesses, Bloodhound executors, or playbooks may be available.
- Execution mode: `deterministic_first`
- Tool policy: prefer `browser_run_harness` and exact playbook execution before open-ended browsing.
- Safety policy: prefer human intervention over repeated blind retries on blockers.

### 3. `research`

- For browse/extract/compare/report tasks.
- Execution mode: `step_controlled` when multi-step browser sketch exists, else `direct`
- Tool policy: prefer browser + extraction tools; discourage GUI unless required.
- Response policy: require evidence-oriented finish.

### 4. `desktop_operator`

- For app-control or GUI-heavy tasks with desktop routing.
- Execution mode: `direct`
- Tool policy: prefer app routing constraints from app registry and current desktop capability state.
- Health dependency: downgrade GUI-first behavior when system audit shows degraded GUI automation.

### 5. `high_safety`

- For tasks likely to touch sensitive paths, destructive shell commands, or broad filesystem changes.
- Execution mode: `plan_then_execute` when planning is enabled, otherwise `direct` with elevated approval.
- Safety policy: elevated approval and stronger verification/finish expectations.

### 6. `coding`

- Optional and explicitly not product-defining.
- Use only when existing classification already indicates coding/filesystem-heavy work.
- Execution mode: `direct` for small edits, `plan_then_execute` only when planning runtime is enabled and task complexity warrants it.

## 13. Phased Implementation Plan

### Phase 1: Minimal framework

- Add `src/main/agent/harness-resolver.ts` with:
  - `HarnessResolutionInput`
  - `HarnessDefinition`
  - `ResolvedHarness`
  - `resolveHarness()`
- Wire harness resolution into [`src/main/agent/loop.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/loop.ts) immediately after classification/profile override.
- Extend prompt assembly with one harness directive block and module adjustments.
- Feed system-audit summary into harness resolution.
- Do not change tool implementations, providers, or audit persistence.

### Phase 2: First harnesses

- Implement `default_operator`, `browser_transaction`, `research`, and `desktop_operator`.
- Use existing browser/site-harness/playbook/Bloodhound short-circuit paths rather than new replay code.
- Add tests that assert harness resolution decisions against mocked system-audit states and task profiles.

### Phase 3: Deeper policy/phase specialization

- Add `high_safety`.
- Add coding harness only as a narrow specialization.
- If execution planning is intentionally enabled later, let harnesses drive whether `createExecutionPlan()` is invoked.
- If graph execution becomes stable later, add a harness flag for graph-eligible workflows, but keep it opt-in and health-gated.

## 14. Risks / Failure Modes

- Over-configuration. If harness definitions become a matrix of provider x task x tool x safety permutations, the layer will duplicate runtime routing logic and become unmaintainable.
- Duplicate routing logic. Classification, app routing, browser deterministic replay, and policy gating already exist. The harness layer must orchestrate them, not reimplement them.
- Provider-shaped behavior. If harnesses start embedding provider-native prompt structures or special-case logic, provider neutrality collapses.
- Stale health signals. `getSystemAwarenessBlock()` is cached in [`src/main/agent/system-audit.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/system-audit.ts). Harness decisions should consume the same cache and respect its staleness model rather than inventing a second refresh scheme.
- Coding-centric bias. The classifier already supports browser, desktop, filesystem, research, document, Bloodhound, and ytdlp flows in [`src/main/agent/classifier.ts`](/home/dp/Desktop/clawdia4.0/src/main/agent/classifier.ts). Harness design must preserve that broader operator identity.
- Prompt-policy sprawl. Prompt composition is already manageable because it is module-based. Harness directives must remain small additive blocks, not a second prompt framework.
- Misreading current harness names. `loop-harness.ts` and `site-harness.ts` are concrete subsystems, not the new architectural layer. Internal naming should prefer `behavior harness` or `execution harness` for the new layer.

## 15. Final Recommendation

Clawdia should build the harness layer now, but only partially and narrowly.

The codebase is ready for a v1 harness resolver because the runtime already exposes the necessary seams: classification, prompt composition, context loading, provider normalization, deterministic browser replay, guarded tool dispatch, and system-audit health and workflow signals are all real and source-backed. The harness should be introduced as a small orchestration contract on top of those seams, ideally named internally as a `behavior harness` or `execution harness` to avoid confusion with existing harness subsystems.

Clawdia should not attempt a full policy matrix, a new execution engine, or a provider-shaped abstraction. The correct next move is a minimal, app-wide, provider-neutral harness resolver that consumes system audit as runtime truth and emits run posture for the existing loop.
