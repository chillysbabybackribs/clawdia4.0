# Clawdia 4.0 Next-Phase Spec

## Scope

This spec covers the next product-control layer after:

- durable runs
- durable run events
- review surfaces
- approval checkpoints
- policy profiles
- run-scoped control
- detach/background behavior
- basic reattach replay

The focus is narrow:

1. `needs_human` as a first-class run state
2. file conflict control for simultaneous agents
3. browser execution policy for attached vs detached runs

This is intentionally not a replay-fidelity spec. Reattach should stay semantically correct, not cinematic.

## Why This Phase

Clawdia now supports the foundations for simultaneous runs, but two practical product risks remain:

- a background run can block on something the user must do and fail to get attention
- two runs can converge on the same file and create silent clobber risk

There is also one behavior that should be made explicit:

- detached browser work should usually stop consuming visible browser surface unless the task is session-bound

## Product Principles

1. If a human is required, the run must say so explicitly.
2. Two runs must not silently overwrite the same file.
3. Detached work should become less intrusive by default.
4. Reattach should show the current truth, not attempt perfect historical theater.

## Current Baseline

The current implementation already has:

- `awaiting_approval`
- `run_approvals`
- `policy_profiles`
- run-scoped cancel/pause/resume/context
- `Active` and `Recently Completed`
- detached background execution
- basic buffered reattach into chat

Relevant files:

- [src/main/agent/process-manager.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/process-manager.ts)
- [src/main/agent/approval-manager.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/approval-manager.ts)
- [src/main/agent/policy-engine.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/policy-engine.ts)
- [src/main/agent/loop-dispatch.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-dispatch.ts)
- [src/main/db/database.ts](/home/dp/Desktop/clawdia4.0/src/main/db/database.ts)
- [src/shared/types.ts](/home/dp/Desktop/clawdia4.0/src/shared/types.ts)
- [src/renderer/components/Sidebar.tsx](/home/dp/Desktop/clawdia4.0/src/renderer/components/Sidebar.tsx)
- [src/renderer/components/ChatPanel.tsx](/home/dp/Desktop/clawdia4.0/src/renderer/components/ChatPanel.tsx)
- [src/renderer/components/ProcessesPanel.tsx](/home/dp/Desktop/clawdia4.0/src/renderer/components/ProcessesPanel.tsx)

## New Concepts

### `needs_human`

A run state meaning:

- the run cannot proceed
- approval is not sufficient
- the user must directly do something

Examples:

- password entry
- 2FA or OTP
- CAPTCHA
- native confirmation dialog
- browser/site choice requiring human judgment
- file conflict resolution between simultaneous runs

This is distinct from `awaiting_approval`.

### File Writer Ownership

Only one active run should own write access to a file path at a time by default.

### Browser Execution Mode

Detached browser work should have a policy-driven mode:

- `headed`
- `headless`
- `persistent_session`

## State Model

### Run Status

Expand the current status unions from:

- `running`
- `awaiting_approval`
- `completed`
- `failed`
- `cancelled`

to:

- `running`
- `awaiting_approval`
- `needs_human`
- `completed`
- `failed`
- `cancelled`

This applies to:

- SQLite `runs.status`
- `ProcessStatus`
- `RunStatus`
- any renderer status badges or filters

### Status Semantics

- `awaiting_approval`: Clawdia needs permission from the user.
- `needs_human`: Clawdia needs an action from the user.

`needs_human` should remain in `Active`, and it should be more visually prominent than `awaiting_approval`.

## Data Model

Add migration `v14`.

### Update `runs`

Extend the `status` constraint to include `needs_human`.

### Add `run_human_interventions`

Columns:

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `run_id TEXT NOT NULL`
- `status TEXT NOT NULL CHECK(status IN ('pending','resolved','dismissed'))`
- `intervention_type TEXT NOT NULL`
- `target TEXT`
- `summary TEXT NOT NULL`
- `instructions TEXT`
- `request_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `resolved_at TEXT`

Indexes:

- `idx_run_human_interventions_run_id`
- `idx_run_human_interventions_status`

Purpose:

- durable visibility into why a run needs the user
- renderer-friendly pending/resolved state
- clean replay/reattach source of truth

### Add `run_file_locks`

Columns:

- `path TEXT PRIMARY KEY`
- `run_id TEXT NOT NULL`
- `conversation_id TEXT NOT NULL`
- `acquired_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`
- `source_revision TEXT`
- `lock_mode TEXT NOT NULL DEFAULT 'write' CHECK(lock_mode IN ('write'))`

Indexes:

- `idx_run_file_locks_run_id`

Purpose:

- prevent silent multi-run file clobbering
- support stale lock cleanup
- make file conflict state durable

## Run Events

Add new event kinds:

- `human_intervention_requested`
- `human_intervention_resolved`
- `file_lock_acquired`
- `file_lock_conflict`
- `file_lock_released`
- `browser_mode_changed`

Example `human_intervention_requested` payload:

```json
{
  "type": "otp",
  "summary": "2FA code required",
  "instructions": "Enter the code in the visible browser window, then click Resume.",
  "target": "google.com",
  "requiresVisibleBrowser": true
}
```

Example `file_lock_conflict` payload:

```json
{
  "path": "/home/dp/Desktop/clawdia4.0/src/main/main.ts",
  "ownerRunId": "proc-123",
  "requestedByRunId": "proc-456",
  "policy": "single_writer"
}
```

Example `browser_mode_changed` payload:

```json
{
  "from": "headed",
  "to": "headless",
  "reason": "run_detached"
}
```

## Human Intervention Design

### Trigger Sources

Human intervention can be requested by:

- browser automation
- shell/tool execution
- desktop app control
- conflict manager
- explicit tool result classification

### New Manager

Add:

- [src/main/agent/human-intervention-manager.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/human-intervention-manager.ts)

Core responsibilities:

- create durable human intervention records
- set run/process status to `needs_human`
- emit renderer events
- resolve or dismiss interventions
- support per-run cleanup on cancel/fail/complete

Suggested interface:

```ts
requestHumanIntervention(runId, request): Promise<void>
resolveHumanIntervention(id, resolution): void
listPendingHumanInterventions(runId?): RunHumanIntervention[]
dismissHumanInterventions(runId): void
```

### Request Shape

```ts
type HumanInterventionType =
  | 'password'
  | 'otp'
  | 'captcha'
  | 'native_dialog'
  | 'site_confirmation'
  | 'conflict_resolution'
  | 'manual_takeover'
  | 'unknown';
```

Fields:

- `type`
- `summary`
- `instructions`
- `target`
- `requiresVisibleBrowser`
- `requiresFocusedApp`
- `metadata`

### Flow

1. Run is `running`
2. subsystem detects required human action
3. create `run_human_interventions` row
4. append `human_intervention_requested`
5. set run status to `needs_human`
6. keep run in `Active`
7. visually alert the user
8. user completes the required action
9. user clicks `Resume` or the system detects completion
10. append `human_intervention_resolved`
11. status returns to `running`

## File Conflict Control

### Default Rule

Single active writer per file path.

If Run A wants to write file `X`:

1. attempt to acquire file lock
2. if unowned, continue
3. if owned by same run, continue
4. if owned by different active run:
   - emit `file_lock_conflict`
   - default to `needs_human`

### Why Not Silent Queueing

Silent queueing can look like a hung run. The user needs to know:

- what file is blocked
- which run owns it
- what to do next

### Stale-Read Protection

Before applying a write:

1. compare the file revision originally read by the run to the current revision
2. if changed:
   - do not blindly write
   - emit `file_lock_conflict`
   - request `needs_human` or regenerate the patch

Revision strategy:

- tracked file in git repo: blob hash if available
- otherwise: content hash
- fallback: content hash + mtime

### Integration Points

Primary:

- [src/main/agent/loop-dispatch.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-dispatch.ts)

New modules:

- [src/main/agent/file-lock-manager.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/file-lock-manager.ts)
- [src/main/db/run-file-locks.ts](/home/dp/Desktop/clawdia4.0/src/main/db/run-file-locks.ts)

Applies to:

- `file_write`
- `file_edit`
- future mutation tools

## Browser Execution Policy

### Goal

Detached browser runs should default to headless unless the task is session-bound.

### Modes

- `headed`
- `headless`
- `persistent_session`

### Rules

- attached run: prefer `headed`
- detached run: prefer `headless`
- session-bound task: use `persistent_session`

### Session-Bound Criteria

A task is session-bound if it depends on:

- the user’s logged-in cookies
- extension state
- a persistent desktop browser profile
- manual takeover in the same session
- any current `needs_human` state

### Detach Behavior

When a run detaches:

1. process manager emits `run_detached`
2. browser policy evaluates detach mode
3. if safe, switch to `headless`
4. otherwise remain in `persistent_session`
5. append `browser_mode_changed`

### Reattach Behavior

When the user reattaches:

- if the task needs visible takeover, reopen in `headed`
- if the task can keep running headless, do not force a visible transition

Primary implementation points:

- new [src/main/browser/execution-policy.ts](/home/dp/Desktop/clawdia4.0/src/main/browser/execution-policy.ts)
- browser manager integration
- [src/main/agent/process-manager.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/process-manager.ts)

## Policy Additions

Extend policy profiles with:

- `fileConflictBehavior`
- `detachedBrowserMode`
- `notifyOnNeedsHuman`

Suggested values:

- `fileConflictBehavior`: `needs_human` | `deny` | `queue` | `allow_with_stale_check`
- `detachedBrowserMode`: `headless` | `persistent_session`
- `notifyOnNeedsHuman`: boolean

Suggested defaults:

- `Standard`
  - `fileConflictBehavior = needs_human`
  - `detachedBrowserMode = headless`
  - `notifyOnNeedsHuman = true`
- `Coding Review`
  - `fileConflictBehavior = needs_human`
  - `detachedBrowserMode = headless`
  - `notifyOnNeedsHuman = true`
- `Browser Review`
  - `fileConflictBehavior = needs_human`
  - `detachedBrowserMode = persistent_session`
  - `notifyOnNeedsHuman = true`
- `Locked Down`
  - `fileConflictBehavior = deny`
  - `detachedBrowserMode = persistent_session`
  - `notifyOnNeedsHuman = true`
- `Unrestricted`
  - bypass policy blocks and approval gates
  - still emit conflict events
  - still perform stale-read detection

## Shared Types And IPC

### `src/shared/types.ts`

Add:

- `needs_human` to all run/process status unions
- `RunHumanIntervention`
- `BrowserExecutionMode`

### `src/shared/ipc-channels.ts`

Add:

- `RUN_LIST_HUMAN_INTERVENTIONS`
- `RUN_RESOLVE_HUMAN_INTERVENTION`
- `BROWSER_GET_EXECUTION_MODE`
- renderer events for:
  - `run:needs-human`
  - `run:human-resolved`
  - `browser:mode-changed`

## Renderer Changes

### Sidebar

Update [src/renderer/components/Sidebar.tsx](/home/dp/Desktop/clawdia4.0/src/renderer/components/Sidebar.tsx):

- add `needs_human` card treatment
- this should be the highest-priority active-card visual state
- keep it monochrome but high-contrast
- pulse or flash is acceptable here
- clicking it should open the blocked run/chat directly

### Chat Panel

Update [src/renderer/components/ChatPanel.tsx](/home/dp/Desktop/clawdia4.0/src/renderer/components/ChatPanel.tsx):

- show an inline `Needs human intervention` banner
- render exact instructions
- support:
  - `Resume`
  - `Cancel`
  - optional `Open review`

### Processes Panel

Update [src/renderer/components/ProcessesPanel.tsx](/home/dp/Desktop/clawdia4.0/src/renderer/components/ProcessesPanel.tsx):

- add `Human Intervention` section
- show pending/resolved interventions
- show file conflict details
- show browser mode transitions

## Main Process Changes

### New Modules

- `src/main/agent/human-intervention-manager.ts`
- `src/main/agent/file-lock-manager.ts`
- `src/main/db/run-human-interventions.ts`
- `src/main/db/run-file-locks.ts`
- `src/main/browser/execution-policy.ts`

### Existing Modules To Update

- [src/main/agent/process-manager.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/process-manager.ts)
  - include `needs_human`
  - treat it as active
  - integrate detach/attach browser policy hooks
- [src/main/agent/loop-dispatch.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/loop-dispatch.ts)
  - enforce file locks
  - enforce stale-read checks
  - trigger human intervention requests
- [src/main/agent/approval-manager.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/approval-manager.ts)
  - keep approval logic separate from `needs_human`
- [src/main/agent/policy-engine.ts](/home/dp/Desktop/clawdia4.0/src/main/agent/policy-engine.ts)
  - add conflict and detached-browser policy evaluation
- [src/main/store.ts](/home/dp/Desktop/clawdia4.0/src/main/store.ts)
  - optional notification setting for `needs_human`

## Replay Scope

Do not deepen replay beyond semantic correctness in this phase.

Required on reattach:

- latest assistant state
- latest tool state
- pending approval state
- pending human intervention state
- recent changes
- recent browser mode

Not required:

- exact chunk timing
- exact historical spinner behavior
- exact token-by-token reconstruction

## Rollout Order

### Phase A: `needs_human`

Do first.

Includes:

- migration v14
- status unions
- `run_human_interventions`
- manager and IPC
- sidebar alert state
- chat banner
- optional desktop notification

### Phase B: File Conflict Control

Do second.

Includes:

- file locks
- stale-read checks
- `needs_human` on same-file conflicts

### Phase C: Browser Execution Policy

Do third.

Includes:

- attached vs detached mode policy
- session-bound exception path
- browser mode review visibility

## Acceptance Criteria

### `needs_human`

- a run can enter `needs_human`
- it remains in `Active`
- the card is visually prominent
- the chat shows exact instructions
- the run can resume cleanly

### File Conflicts

- two runs cannot silently write the same file at once
- second-writer conflict is surfaced clearly
- stale-read writes are refused
- unrestricted mode still records conflicts

### Browser Policy

- detached non-session-bound browser work becomes headless
- session-bound work keeps persistent session behavior
- browser mode is visible in run review/detail

## Recommended First Patch Set

1. add `needs_human` to statuses and DB
2. add `run_human_interventions`
3. add `human-intervention-manager.ts`
4. wire sidebar and chat UX
5. add notification hook

This is the smallest high-value slice and should land before file conflict control or browser policy.
