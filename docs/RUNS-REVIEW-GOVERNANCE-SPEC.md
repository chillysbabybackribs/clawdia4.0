# Clawdia 4.0 Runs, Review, and Governance Spec

## Goal

Move Clawdia from a powerful operator runtime to a governable operator runtime.

The product already has broad capability:

- browser session automation
- filesystem and shell access
- source code editing
- backend process interaction
- desktop application control
- detached/background process tracking

The next step is not more raw capability. It is durable execution, trustworthy review, and predictable policy behavior.

This spec defines:

- durable task runs
- resumable structured execution logs
- review surfaces for machine changes
- rule-driven behavior by workspace and task type
- approval checkpoints for sensitive boundaries

The design is intended to fit the current architecture:

- Electron main process orchestration in `src/main/main.ts`
- loop control in `src/main/agent/loop.ts`
- process tracking in `src/main/agent/process-manager.ts`
- SQLite persistence in `src/main/db/database.ts`
- renderer views in `src/renderer`
- IPC bridge in `src/main/preload.ts` and `src/shared/ipc-channels.ts`

## Product Principles

1. Every meaningful task is a first-class run.
2. A run is not just chat text. It is an execution record.
3. All sensitive actions are attributable, reviewable, and resumable.
4. Approval is selective, not everywhere.
5. Policy should shape agent behavior before a mistake, not just explain it after.
6. Review UX should compress risk quickly: what changed, where, why, and what remains pending.

## Terminology

### Conversation

The user-facing chat thread. Already exists.

### Run

A single bounded execution attempt tied to one conversation message or resumed task. A run may stream multiple tool calls, span many minutes, pause, await approval, and resume later.

### Event

A structured log item emitted during a run. Examples:

- model thinking status
- tool started
- tool completed
- file modified
- process started
- browser navigation
- approval requested
- approval granted
- checkpoint created
- run failed

### Artifact

A durable object produced or referenced by a run. Examples:

- file diff
- screenshot
- DOM snapshot summary
- command stdout/stderr excerpt
- generated document
- changed files list

### Policy

A ruleset that constrains how the agent behaves for a workspace, task class, or action class.

### Approval Checkpoint

A point where the run cannot continue until the user allows or denies a sensitive action.

## Current Gaps

The current system has a useful start:

- process list
- detach/attach
- tool activity streaming
- conversation persistence

But it is still process-centric, not run-centric.

Current limitations:

- process state is primarily in-memory
- buffered replay is incomplete as a user-facing reattach experience
- logs are card-oriented, not structured for audit/review
- no durable artifact model
- no explicit approval boundary model
- no workspace policy engine
- no run modes

## Target User Experience

### New baseline flow

1. User sends task.
2. Clawdia creates a run.
3. Run shows:
   - goal
   - current phase
   - tools used
   - changed files/apps/sites
   - pending approvals
4. User can:
   - watch live
   - detach
   - inspect logs
   - inspect diffs/artifacts
   - approve or deny sensitive steps
   - resume later
5. When complete, the run remains reviewable from history.

### Run modes

Each run starts in one of:

- `observe`: inspect only, no mutations
- `draft`: prepare actions/diffs, no apply without approval
- `review`: execute low-risk steps automatically, pause at policy boundaries
- `autonomous`: continue unless blocked by policy

Default recommendation:

- browser/research tasks: `review`
- coding tasks: `review`
- desktop control tasks: `review`
- explicit user command like "just do it": `autonomous`

### Review summary

Each finished run should render a compact summary:

- outcome: completed, failed, cancelled, awaiting approval
- files changed
- commands executed
- websites visited
- desktop apps touched
- documents created
- approvals encountered
- unresolved risks

## Architecture Overview

Add a first-class Runs subsystem parallel to conversations.

### Main components

- RunStore: durable persistence for runs, events, artifacts, approvals, policies
- RunManager: in-memory active run registry and event emitter
- ApprovalManager: creates and resolves checkpoints
- PolicyEngine: evaluates actions against rules
- ReviewAssembler: turns raw events/artifacts into review-ready summaries

### Existing components reused

- `process-manager.ts` evolves into active-run attachment and live event routing
- `conversations.ts` remains the chat transcript store
- tool executors emit structured events into RunManager
- renderer reads run state through new IPC surfaces

## Data Model

Add the following tables.

### `runs`

Purpose: top-level durable task record.

Columns:

- `id TEXT PRIMARY KEY`
- `conversation_id TEXT NOT NULL`
- `message_id TEXT`
- `parent_run_id TEXT`
- `title TEXT NOT NULL`
- `goal TEXT NOT NULL`
- `mode TEXT NOT NULL CHECK(mode IN ('observe','draft','review','autonomous'))`
- `status TEXT NOT NULL CHECK(status IN ('queued','running','paused','awaiting_approval','completed','failed','cancelled'))`
- `workspace_scope TEXT`
- `app_scope TEXT`
- `site_scope TEXT`
- `policy_profile TEXT`
- `model TEXT`
- `started_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `completed_at TEXT`
- `error TEXT`
- `result_summary TEXT`
- `was_detached INTEGER NOT NULL DEFAULT 0`

Indexes:

- `idx_runs_conversation`
- `idx_runs_status`
- `idx_runs_updated_at`

### `run_events`

Purpose: immutable event log.

Columns:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `run_id TEXT NOT NULL`
- `seq INTEGER NOT NULL`
- `ts TEXT NOT NULL`
- `kind TEXT NOT NULL`
- `phase TEXT`
- `actor TEXT NOT NULL DEFAULT 'system'`
- `surface TEXT`
- `tool_name TEXT`
- `payload_json TEXT NOT NULL`

Kinds include:

- `run_started`
- `thinking`
- `tool_started`
- `tool_progress`
- `tool_completed`
- `tool_failed`
- `file_changed`
- `browser_navigated`
- `browser_extracted`
- `desktop_action`
- `process_spawned`
- `approval_requested`
- `approval_resolved`
- `policy_blocked`
- `checkpoint_created`
- `run_paused`
- `run_resumed`
- `run_completed`
- `run_failed`
- `run_cancelled`

Indexes:

- `idx_run_events_run_seq`
- `idx_run_events_kind`

### `run_artifacts`

Purpose: durable attachments and review objects.

Columns:

- `id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL`
- `event_id INTEGER`
- `kind TEXT NOT NULL`
- `label TEXT NOT NULL`
- `path TEXT`
- `mime TEXT`
- `summary TEXT`
- `metadata_json TEXT NOT NULL DEFAULT '{}'`
- `created_at TEXT NOT NULL`

Artifact kinds:

- `file_diff`
- `file_snapshot_before`
- `file_snapshot_after`
- `stdout_excerpt`
- `stderr_excerpt`
- `browser_snapshot`
- `screenshot`
- `dom_summary`
- `document_output`
- `app_trace`

### `run_changes`

Purpose: normalized change summary for fast review UI.

Columns:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `run_id TEXT NOT NULL`
- `change_type TEXT NOT NULL`
- `target TEXT NOT NULL`
- `before_ref TEXT`
- `after_ref TEXT`
- `summary TEXT NOT NULL`
- `risk_level TEXT NOT NULL CHECK(risk_level IN ('low','medium','high'))`

Change types:

- `file_edit`
- `file_create`
- `file_delete`
- `command_exec`
- `browser_action`
- `desktop_action`
- `process_action`
- `document_create`

### `run_approvals`

Purpose: pending and historical approvals.

Columns:

- `id TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL`
- `status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired'))`
- `approval_type TEXT NOT NULL`
- `reason TEXT NOT NULL`
- `action_json TEXT NOT NULL`
- `policy_rule_id TEXT`
- `requested_at TEXT NOT NULL`
- `resolved_at TEXT`
- `resolved_by TEXT`
- `resolution_note TEXT`

Approval types:

- `destructive_filesystem`
- `external_side_effect`
- `auth_sensitive`
- `git_push`
- `deploy`
- `system_install`
- `purchase`
- `account_mutation`

### `policy_profiles`

Purpose: reusable policy bundles.

Columns:

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `scope_type TEXT NOT NULL CHECK(scope_type IN ('global','workspace','task_type'))`
- `scope_value TEXT`
- `rules_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### `workspace_profiles`

Purpose: bind a repo/path to default run behavior.

Columns:

- `id TEXT PRIMARY KEY`
- `root_path TEXT NOT NULL UNIQUE`
- `display_name TEXT NOT NULL`
- `default_mode TEXT NOT NULL`
- `policy_profile_id TEXT`
- `preferences_json TEXT NOT NULL DEFAULT '{}'`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

## Shared Types

Add new shared types in `src/shared/types.ts`.

### Core types

- `RunMode`
- `RunStatus`
- `RunSummary`
- `RunDetail`
- `RunEvent`
- `RunArtifact`
- `RunChange`
- `RunApproval`
- `PolicyProfile`
- `WorkspaceProfile`

### Suggested shape

```ts
export type RunMode = 'observe' | 'draft' | 'review' | 'autonomous';
export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface RunSummary {
  id: string;
  conversationId: string;
  title: string;
  goal: string;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  wasDetached: boolean;
  toolCallCount: number;
  changeCount: number;
  pendingApprovalCount: number;
  resultSummary?: string;
}
```

`ProcessInfo` can remain temporarily, but should become a view over `RunSummary` during migration.

## IPC Design

Add a new run-oriented IPC surface instead of overloading the existing process API forever.

### New request channels

- `run:list`
- `run:get`
- `run:get-events`
- `run:get-artifacts`
- `run:get-changes`
- `run:get-approvals`
- `run:attach`
- `run:detach`
- `run:cancel`
- `run:pause`
- `run:resume`
- `run:approve`
- `run:deny`
- `run:set-mode`
- `policy:list`
- `policy:save`
- `workspace-profile:list`
- `workspace-profile:save`

### New push events

- `run:updated`
- `run:event`
- `run:approval-requested`
- `run:approval-resolved`
- `run:list-changed`

### Compatibility

Phase 1 should keep current `process:*` IPC working by mapping it internally onto runs.

## Main Process Changes

### `src/main/main.ts`

Responsibilities after change:

- create a run before invoking `runAgentLoop`
- bind the run id to the active execution
- return `runId` with `chat:send`
- route run updates to renderer
- resolve approvals from renderer IPC
- map stop/pause/resume to a specific run id, not global loop state

### `src/main/agent/loop.ts`

Required evolution:

- replace module-global control with per-run execution context
- `cancelLoop`, `pauseLoop`, `resumeLoop`, `addContext` must become run-scoped
- inject RunManager hooks at each meaningful phase
- emit structured events, not just streaming text

Recommended new concept:

```ts
interface ActiveRunContext {
  runId: string;
  abortController: AbortController;
  paused: boolean;
  pendingContext: string[];
  mode: RunMode;
  policyProfile: PolicyProfile;
}
```

### `src/main/agent/process-manager.ts`

Transition plan:

- rename conceptually to `run-manager.ts` later
- keep current attach/detach behavior for live streaming
- add durable backing via `runs` and `run_events`
- attach should replay events from persistence, not only in-memory buffer

## Event Emission Design

Every tool dispatch should emit at least:

### Start

```json
{
  "kind": "tool_started",
  "toolName": "file_edit",
  "surface": "filesystem",
  "payload": {
    "inputSummary": "edit src/main/main.ts"
  }
}
```

### Progress

For streaming tools:

```json
{
  "kind": "tool_progress",
  "toolName": "shell_exec",
  "payload": {
    "stream": "stdout",
    "chunk": "vite building..."
  }
}
```

### Completion

```json
{
  "kind": "tool_completed",
  "toolName": "file_edit",
  "payload": {
    "durationMs": 180,
    "resultSummary": "edited src/main/main.ts"
  }
}
```

### Change extraction

Tool outputs should additionally create normalized change records where possible.

Examples:

- `file_write` creates `file_create` or `file_edit`
- `shell_exec` may create `command_exec`
- `browser_navigate` creates `browser_action`
- `gui_interact` creates `desktop_action`

## Change Capture

The review system should not depend entirely on parsing human-readable tool output. Capture structured change data at the source.

### File mutations

For `file_write` and `file_edit`:

- read before snapshot when file exists
- apply mutation
- read after snapshot
- compute diff
- persist diff artifact
- persist `run_changes` row

### Shell commands

For `shell_exec`:

- capture command string
- persist stdout/stderr excerpts
- classify risk level based on command
- if command includes file mutation and can be detected, flag it as unstructured mutation

### Browser actions

Capture:

- URL
- page title
- login/authenticated inference
- extracted result summary

### Desktop actions

Capture:

- app
- window title
- action summary
- screenshot ref when taken

## Review Surfaces

Add a dedicated Run Review view in the renderer.

### View model

Sections:

- Overview
- Timeline
- Changes
- Artifacts
- Approvals
- Raw Log

### Overview

Show:

- goal
- mode
- final status
- duration
- model used
- tools used
- touched surfaces

### Timeline

Human-readable event list:

- concise, reversible ordering
- grouped by phase
- expandable details

### Changes

Most important section.

Show grouped chips:

- Files
- Commands
- Browser
- Apps
- Processes

For files:

- path
- change type
- inline diff viewer

For commands:

- command
- cwd if known
- stdout/stderr excerpt

For browser:

- URL visited
- extracted content summary

For apps:

- app name
- action trace

### Artifacts

Preview:

- screenshots
- generated docs
- diffs
- extracted outputs

### Approvals

Show:

- what was requested
- why policy stopped it
- allow once / deny / always allow in this workspace rule shortcut

## Renderer Changes

### New views

Add:

- `runs`
- `run-detail`
- `policies`

### Likely file changes

- `src/renderer/App.tsx`
- `src/renderer/components/Sidebar.tsx`
- new `src/renderer/components/RunsView.tsx`
- new `src/renderer/components/RunDetailView.tsx`
- new `src/renderer/components/RunTimeline.tsx`
- new `src/renderer/components/RunChangesPanel.tsx`
- new `src/renderer/components/ApprovalPanel.tsx`
- new `src/renderer/components/PolicyView.tsx`

### Sidebar behavior

Replace the current process-centric sections with:

- Running Runs
- Awaiting Approval
- Recent Runs
- Conversations

### ToolActivity evolution

Current `ToolActivity.tsx` is a good seed for live logs.

Evolve it to:

- render tool cards from `RunEvent`s
- link from tool card to resulting `RunChange` or artifact
- show policy badge if action was auto-approved, user-approved, or blocked

## Policies

Policies should be explicit JSON rules, not prompt prose alone.

### Rule shape

```ts
interface PolicyRule {
  id: string;
  enabled: boolean;
  match: {
    toolNames?: string[];
    commandPatterns?: string[];
    pathPrefixes?: string[];
    changeTypes?: string[];
    domains?: string[];
    appIds?: string[];
  };
  effect: 'allow' | 'deny' | 'require_approval';
  reason: string;
}
```

### Default global rules

- require approval for deleting files outside workspace
- require approval for `git push`
- require approval for package installs outside project-local dependencies
- require approval for system package installs
- require approval for external posting or purchases
- deny storing secrets in memory
- prefer CLI/harness over GUI when available

### Default coding workspace rules

- always run tests after source edits when test command exists
- require approval before touching `.env`, secrets, deployment configs
- require approval before `git push`
- require approval before schema-destructive database commands

### Default browser/session rules

- require approval before submitting purchases
- require approval before changing account settings, billing, or permissions
- allow navigation and read/extract
- require approval before posting/publicly publishing

## Approval System

Approval should be fine-grained and resumable.

### Approval flow

1. Tool or PolicyEngine detects sensitive action.
2. Run status becomes `awaiting_approval`.
3. `run_approvals` row is created.
4. Renderer shows pending approval.
5. User selects:
   - approve once
   - deny
   - approve and create rule
6. Run resumes or fails gracefully.

### Approval UI fields

- action summary
- risk level
- policy reason
- exact target
- downstream impact
- options

Example:

- `git push origin main`
- risk: high
- reason: external side effect
- scope: workspace `/home/dp/Desktop/clawdia4.0`

## Migration Strategy

### Phase 1: Durable runs under current process UX

Ship without large renderer redesign.

Implement:

- `runs` and `run_events`
- map current process creation to run creation
- persist attach/detach and final status
- add run ids to `chat:send`

Files:

- `src/main/db/database.ts`
- new `src/main/db/runs.ts`
- `src/main/main.ts`
- `src/main/agent/process-manager.ts`
- `src/shared/types.ts`

### Phase 2: Structured event emission

Implement:

- event emission from loop and dispatch
- tool start/progress/complete records
- basic artifact persistence

Files:

- `src/main/agent/loop.ts`
- `src/main/agent/loop-dispatch.ts`
- `src/main/agent/executors/core-executors.ts`
- `src/main/agent/executors/browser-executors.ts`
- `src/main/agent/executors/desktop-executors.ts`
- new `src/main/agent/run-events.ts`

### Phase 3: Review surfaces

Implement:

- Runs list
- Run detail page
- change summary
- artifact previews

Files:

- `src/renderer/App.tsx`
- `src/renderer/components/Sidebar.tsx`
- new run detail components
- `src/main/preload.ts`
- `src/shared/ipc-channels.ts`

### Phase 4: Policies and approvals

Implement:

- policy storage
- policy evaluation
- approval UI
- approval IPC

Files:

- new `src/main/agent/policy-engine.ts`
- new `src/main/db/policies.ts`
- `src/main/main.ts`
- `src/main/preload.ts`
- new approval renderer components

### Phase 5: Per-run loop control

Implement:

- eliminate module-global loop control
- run-scoped pause/resume/cancel/context
- reliable concurrent run handling

This is the largest correctness upgrade.

## Recommended Rollout Order

1. Durable runs
2. Structured run events
3. Review detail UI
4. Approval checkpoints
5. Policy profiles
6. Per-run control refactor

This order maximizes value early while preserving current UX.

## Acceptance Criteria

### Phase 1 done when

- every `chat:send` creates a durable run row
- finished runs remain visible after app restart
- detach state survives restart

### Phase 2 done when

- each tool call creates start and completion events
- shell stdout/stderr progress is persisted
- file mutations create durable change records

### Phase 3 done when

- a user can inspect what changed without reading raw chat
- a user can reopen a completed run and view diffs/artifacts

### Phase 4 done when

- sensitive actions pause the run
- user can approve/deny from UI
- approval resolution is logged durably

### Phase 5 done when

- pause/resume/cancel/context operate by run id
- two runs can coexist without control collisions

## Open Questions

1. Should a run always map 1:1 to a user message, or can one message spawn sub-runs?
2. Should browser session actions have a stronger approval default than code/file actions?
3. Should destructive shell commands be denied outright in `autonomous` mode unless explicitly whitelisted?
4. Should screenshots and DOM snapshots be retained forever or be GC'd after a limit?
5. Should workspace profiles auto-detect from cwd, repo root, or both?

## Recommendation

Start with Phase 1 and Phase 2 in one implementation pass.

That gives Clawdia an execution spine:

- durable run identity
- structured replay
- reviewable action history

After that, add the renderer review surface before building a full policy UI. The user needs to see the machine-readable history before the rules system will feel trustworthy.
