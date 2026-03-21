## Hybrid Browser Executor Design

### Goal

Evolve Bloodhound from a whole-task short-circuit into a hybrid browser execution system that can:

- preserve zero-API exact executor hits for simple repeated tasks
- avoid hijacking compound tasks with fuzzy whole-task replay
- allow saved browser playbooks to be invoked inside larger LLM-driven tasks
- create a path toward a mature executor system without introducing a heavy workflow engine yet

### Current Problem

Today `runAgentLoop()` attempts saved Bloodhound replay before the normal LLM loop for any browser task. A successful replay returns immediately. This works for exact repeated tasks, but it breaks compound requests when a fuzzy executor match covers only the first segment of the task.

### Target Modes

The browser pipeline should support three execution modes:

1. `exact_executor`
Run a saved Bloodhound playbook before any LLM call when the whole request exactly matches a validated playbook.

2. `hybrid`
Use a small planning step or deterministic compiler to break the task into ordered subgoals. Some steps run saved playbooks; the rest stay in the normal browser LLM loop.

3. `llm_only`
Fallback to the current browser loop when no safe executor insertion point exists.

### Phase 1 Scope

Phase 1 is intentionally narrow:

- change whole-task pre-loop replay from fuzzy matching to exact-only matching
- add a callable `browser_run_playbook` tool so future planner work can insert executors mid-run
- expose playbook IDs in prompt context so the tool can be used deterministically

This phase does not add a planner yet.

### Phase 1 Control Flow

#### Exact Fast Path

In `loop.ts`:

- before the main LLM loop, call `executeSavedBloodhoundPlaybook(userMessage, currentUrl, { exactOnly: true })`
- if it succeeds, return immediately as today
- if it fails or no exact playbook exists, continue into the normal LLM loop

#### Callable Playbook Tool

In `tool-builder.ts`:

- register `browser_run_playbook`
- input: `{ playbook_id: number }`
- execution: replay the saved Bloodhound playbook by ID

In `browser-playbooks.ts`:

- add `findExactPlaybook()`
- add `executeSavedBloodhoundPlaybookById()`
- refactor replay logic into a shared `executeSavedBloodhoundPlaybookByPlaybook()`

### Phase 2 Scope

Add a minimal task compiler for compound browser tasks.

New file:

- `src/main/agent/task-compiler.ts`

Responsibilities:

- detect likely compound browser tasks
- decompose the task into ordered subgoals
- attach exact or high-confidence executor candidates where available
- produce a small execution sketch

Suggested output shape:

```ts
type PlannedBrowserStep =
  | { kind: 'executor'; playbookId: number; goal: string }
  | { kind: 'llm'; goal: string }
  | { kind: 'approval'; goal: string; risk: 'low' | 'medium' | 'high' };

type BrowserExecutionSketch = {
  mode: 'exact_executor' | 'hybrid' | 'llm_only';
  confidence: number;
  steps: PlannedBrowserStep[];
};
```

The planner should be invoked only when deterministic routing decides the task is compound or ambiguous.

### Phase 3 Scope

Inject the execution sketch into the main loop.

Pragmatic first implementation:

- include the sketch in the dynamic prompt
- instruct the model to complete the current unfinished step only
- allow `browser_run_playbook` when an executor step is specified

This keeps the existing loop architecture intact while enabling hybrid execution.

### Matching Rules

Whole-task pre-loop replay must be stricter than subgoal matching.

Whole-task replay:

- exact normalized task pattern only
- current-domain exact match preferred when a URL exists
- cross-domain exact replay allowed only when the exact pattern maps to a single domain

Subgoal matching:

- may use fuzzy candidate ranking
- should return top candidates with confidence scores
- should never auto-replay without either planner selection or host-level confirmation

### Telemetry Requirements

For each hybrid browser run, record:

- whether mode was `exact_executor`, `hybrid`, or `llm_only`
- which subgoals used playbooks
- playbook success or failure per subgoal
- browser tool count and runtime saved estimates
- fallback reasons when an executor candidate was not used

### Acceptance Cases

1. `navigate to reddit`
- if exact playbook exists, replay with zero LLM calls

2. `navigate to reddit and check my messages and then post to r/example`
- must not be hijacked by a fuzzy `reddit` opener playbook in the whole-task short-circuit
- should remain eligible for hybrid execution once the planner is added

3. `check my GitHub notifications`
- if exact playbook exists, replay pre-loop

4. `check my GitHub notifications and summarize the top three`
- no whole-task fuzzy short-circuit
- future hybrid mode may replay the navigation executor, then let the LLM summarize
