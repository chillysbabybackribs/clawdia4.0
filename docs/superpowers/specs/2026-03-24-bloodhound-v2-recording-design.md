# Bloodhound v2 — Recording Layer Design

**Date:** 2026-03-24
**Status:** In Review
**Scope:** `src/main/agent/bloodhound/` (new), `src/main/db/task-sequences.ts` (new), `src/main/db/database.ts`, `src/main/db/runs.ts`

---

## Goal

Replace Bloodhound's browser-only, manually-triggered recording with an automatic, threshold-gated system that captures any completed multi-step agent run — browser, filesystem, shell, desktop, swarm, or any combination — into a normalized `task_sequences` table ready for future retrieval and replay.

This is sub-project 1 of 3 (Recording → Retrieval → Replay). It ships standalone value: captured sequences are inspectable and form the data foundation the later sub-projects depend on.

---

## Background

The current `browser_playbooks` table records browser-only sequences and is left untouched by this work. The new `task_sequences` table is additive — a parallel store designed from the ground up for multi-surface, multi-step tasks and future semantic retrieval.

The existing Bloodhound profile, executor short-circuit, and `browser_playbooks` write paths continue operating exactly as before.

---

## Recording Threshold

A run qualifies for recording if **any one** of the following is true at completion:

| Condition | Value |
|-----------|-------|
| Total tool calls | ≥ 3 |
| Distinct surfaces used | ≥ 2 |
| Any swarm spawn | true |
| Wall-clock duration | > 15 seconds |

Single-tool "quick lookup" runs are silently skipped. The `outcome` field is determined by run status and successful tool call count:

| `RunStatus` | Successful tool calls | `outcome` | Recorded? |
|-------------|----------------------|-----------|-----------|
| `'completed'` | any | `'success'` | yes (if threshold met) |
| `'cancelled'` or `'failed'` | ≥ 1 | `'partial'` | yes (if threshold met) |
| `'cancelled'` or `'failed'` | 0 | — | no, skip |

"Successful tool call" = a `tool_completed` event (not `tool_failed`) for that run.

---

## Data Model

### `task_sequences` table

```sql
CREATE TABLE task_sequences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  goal            TEXT NOT NULL,
  goal_embedding  BLOB,                    -- float32 array, NULL until embedded
  surfaces        TEXT NOT NULL,           -- JSON string[]
  steps           TEXT NOT NULL,           -- JSON SequenceStep[]
  outcome         TEXT NOT NULL,           -- 'success' | 'partial' | 'failed'
  tool_call_count INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  success_count   INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  last_used       TEXT,
  created_at      TEXT NOT NULL
);
```

### `SequenceStep` (stored in `steps` JSON)

```typescript
interface SequenceStep {
  seq: number;           // order within the run
  surface: Surface;      // 'browser' | 'filesystem' | 'shell' | 'desktop' | 'swarm' | 'memory' | 'other'
  tool: string;          // tool name, e.g. 'browser_navigate', 'file_write'
  input: Record<string, any>;   // sanitized tool input (secrets stripped)
  outputSummary: string; // first 200 chars of tool output, or distiller summary
  durationMs: number;
  success: boolean;      // true = tool_completed, false = tool_failed
}
```

### `Surface` type

```typescript
type Surface = 'browser' | 'filesystem' | 'shell' | 'desktop' | 'swarm' | 'memory' | 'other';
```

Surface is derived from tool name at distillation time via a static prefix lookup. `shell_exec` is an exact match (not a prefix). Tools not matching any entry fall to `'other'` (e.g. `calendar_manage`, `create_document`, `recall_context`).

| Tool name prefix / exact match | Surface |
|-------------------------------|---------|
| `browser_` | `browser` |
| `file_`, `directory_`, `fs_` | `filesystem` |
| `shell_exec` (exact) | `shell` |
| `app_control`, `gui_interact`, `dbus_control` | `desktop` |
| `agent_spawn` (exact) | `swarm` |
| `memory_` | `memory` |
| everything else | `other` |

---

## Recording Pipeline

Triggered by `completeRun()` in `src/main/db/runs.ts`. Steps 1–4 execute synchronously and fast before returning. Steps 5–6 are async and best-effort — failure in either never blocks the run or the UI.

```
completeRun(runId, status)
  │
  ├─ [existing] mark run completed in DB
  │
  └─ maybeRecordSequence(runId, status)   ← new call, non-blocking
       │
       ├─ 1. load run record + run_events (sync DB read)
       ├─ 2. check thresholds → if not met, return immediately
       ├─ 3. distill events → SequenceStep[] via distillSteps() (sync, pure)
       ├─ 4. insert task_sequences row with raw steps (sync DB write)
       │
       ├─ 5. setImmediate: distillWithLLM() → normalize steps (best-effort)
       │     → on success: UPDATE task_sequences SET steps = normalizedSteps
       │     → on failure: log warn, leave raw steps in place
       │
       └─ 6. setImmediate: embedGoal() → embed goal text (best-effort)
             → on success: UPDATE task_sequences SET goal_embedding = vector
             → on failure: log warn, leave goal_embedding NULL
```

Steps 5 and 6 are independent — either can fail without affecting the other.

---

## New Files

### `src/main/agent/bloodhound/recorder.ts`

Single exported function:

```typescript
export async function maybeRecordSequence(
  runId: string,
  status: Exclude<RunStatus, 'running' | 'awaiting_approval' | 'needs_human'>,
): Promise<void>
```

Responsibilities:
- Load `RunRecord` and `RunEventRecord[]` for `runId`
- Apply threshold check (tool count, surfaces, swarm, duration)
- Determine `outcome` per the status → outcome table above
- Call `distillSteps()` to convert events → `SequenceStep[]`
- Determine surfaces (unique set from step surface fields)
- Insert into `task_sequences`
- Fire-and-forget via `setImmediate`: `distillWithLLM()` and `embedGoal()`

Provider access: use `getApiKey(provider)` from `src/main/store.ts` and `createProviderClient(provider, key, model)` from `src/main/agent/provider/factory.ts` — the same pattern used throughout the codebase. No `ProviderClients` aggregate type needed; each function constructs its client directly.

### `src/main/agent/bloodhound/distiller.ts`

Two exported functions:

```typescript
// Pure function — no I/O. Converts raw run events to SequenceStep[].
// Filters out lifecycle, approval, and thinking events.
// Pairs tool_started + (tool_completed | tool_failed) events by payload.toolUseId.
// A step is success=true if its closing event kind is 'tool_completed',
// success=false if 'tool_failed'.
export function distillSteps(events: RunEventRecord[]): SequenceStep[]

// LLM-assisted normalization — called async, best-effort.
// Asks Haiku/Flash to: clean up input objects (strip noise),
// write a better outputSummary, flag any steps that look fragile.
// Returns improved SequenceStep[] or throws (caller catches and ignores).
// Constructs its own ProviderClient via getApiKey/createProviderClient.
export async function distillWithLLM(
  goal: string,
  steps: SequenceStep[],
): Promise<SequenceStep[]>
```

Provider selection in `distillWithLLM`: tries Anthropic Haiku first (`getApiKey('anthropic')`), falls back to Gemini Flash (`getApiKey('gemini')`), throws if neither key is available.

**Event pairing:** `tool_started` and `tool_completed`/`tool_failed` events are matched by `event.payload.toolUseId`. Build a map keyed by `toolUseId`: populate `input` and `seq` from the `tool_started` event; populate `success`, `outputSummary`, and `durationMs` from the closing event. Events with no matching pair are dropped.

### `src/main/agent/bloodhound/embedder.ts`

Single exported function:

```typescript
// Embeds goal text using best available provider.
// Constructs its own HTTP call (no ProviderClient — embeddings use
// provider REST APIs directly, not the chat completion interface).
// Returns Float32Array or throws (caller catches and ignores).
export async function embedGoal(goal: string): Promise<Float32Array>
```

Provider selection: tries OpenAI `text-embedding-3-small` (1536-dim, `getApiKey('openai')`) → Gemini `text-embedding-004` (768-dim, `getApiKey('gemini')`) → throws if neither available.

Embedding dimensions are not stored in this sub-project — the Retrieval sub-project handles dimension normalization when querying.

### `src/main/db/task-sequences.ts`

```typescript
export interface SequenceStep {
  seq: number;
  surface: Surface;
  tool: string;
  input: Record<string, any>;
  outputSummary: string;
  durationMs: number;
  success: boolean;
}

export type Surface = 'browser' | 'filesystem' | 'shell' | 'desktop' | 'swarm' | 'memory' | 'other';

export interface TaskSequence {
  id: number;
  runId: string;
  goal: string;
  goalEmbedding: Float32Array | null;
  surfaces: Surface[];
  steps: SequenceStep[];
  outcome: 'success' | 'partial' | 'failed';
  toolCallCount: number;
  durationMs: number;
  successCount: number;
  failCount: number;
  lastUsed: string | null;
  createdAt: string;
}

export type NewTaskSequence = Omit<TaskSequence, 'id' | 'goalEmbedding' | 'successCount' | 'failCount' | 'lastUsed'>;

export function insertTaskSequence(row: NewTaskSequence): number        // returns id
export function updateTaskSequenceSteps(id: number, steps: SequenceStep[]): void
export function updateTaskSequenceEmbedding(id: number, embedding: Float32Array): void
export function getTaskSequence(id: number): TaskSequence | null
export function listTaskSequences(limit?: number): TaskSequence[]
```

---

## Modified Files

### `src/main/db/database.ts`

Add migration at version **28** (v27 is already taken by `site_harnesses` intervention annotations):

```typescript
if (currentVersion < 28) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_sequences (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          TEXT NOT NULL REFERENCES runs(id),
      goal            TEXT NOT NULL,
      goal_embedding  BLOB,
      embedding_dim   INTEGER,
      embedding_source TEXT,
      surfaces        TEXT NOT NULL DEFAULT '[]',
      steps           TEXT NOT NULL DEFAULT '[]',
      outcome         TEXT NOT NULL DEFAULT 'success',
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      success_count   INTEGER NOT NULL DEFAULT 0,
      fail_count      INTEGER NOT NULL DEFAULT 0,
      last_used       TEXT,
      created_at      TEXT NOT NULL
    );
  `);
  db.pragma('user_version = 28');
}
```

### `src/main/db/runs.ts`

In `completeRun()`, after the existing DB write:

```typescript
import { maybeRecordSequence } from '../agent/bloodhound/recorder';

// non-blocking — fire and forget
maybeRecordSequence(id, status).catch(err =>
  console.warn('[Bloodhound] recording failed silently:', err.message)
);
```

---

## Error Handling

- **Threshold not met** — return immediately, no logging
- **`run_events` load fails** — catch, warn, return. Never throw to caller.
- **`distillSteps` produces 0 steps** — skip insert (nothing to record)
- **DB insert fails** — catch, warn, return
- **LLM distillation fails** — catch, warn, raw steps remain in DB
- **Embedding fails** — catch, warn, `goal_embedding` stays NULL (Retrieval handles NULL gracefully with keyword fallback)

No error in the recording pipeline ever surfaces to the user or affects the run result.

---

## Input Sanitization

Before storing `SequenceStep.input`, strip fields matching these patterns:
- Keys containing: `password`, `token`, `api_key`, `secret`, `auth`, `cookie`, `credential`
- Values: strings matching `/^sk-[a-zA-Z0-9]{20,}/` (API key pattern)

Replaced with `"[redacted]"`.

---

## What This Does NOT Include

- Retrieval (semantic search, confidence scoring, tier selection) — sub-project 2
- Replay (executor tool, LLM-guided adaptation) — sub-project 3
- UI for browsing/managing recorded sequences — deferred
- Changes to `browser_playbooks` or existing Bloodhound executor — untouched
- `task_sequence_replays` tracking table — belongs in sub-project 3

---

## Testing

- `distillSteps()` — unit tests: empty events, only lifecycle events (→ 0 steps), mixed tool + lifecycle events (→ only tool steps), correct surface assignment per tool prefix, correct pairing of `tool_started` + `tool_completed`/`tool_failed` by `payload.toolUseId`, `success: false` when closing event is `tool_failed`
- Sanitization — unit tests for each redacted key pattern and the API key value regex
- `maybeRecordSequence()` — integration tests with mock DB: each threshold condition (tool count, surfaces, swarm, duration), `outcome: 'partial'` for cancelled run with successful tools, cancelled run with 0 successful tools is skipped, async steps (distill + embed) are fired after insert
- `embedder.ts` — unit tests: OpenAI path when key present, Gemini fallback when no OpenAI key, throws when neither available
- `task-sequences.ts` CRUD — insert + retrieve round-trip, NULL `goalEmbedding` round-trip, `Float32Array` serialized to BLOB and back correctly

---

## Out of Scope

- Semantic retrieval and matching (sub-project 2)
- Replay execution and confidence tiering (sub-project 3)
- Per-provider embedding dimension normalization
- Bloodhound UI / sequence browser
- Changes to `browser_playbooks`, existing Bloodhound executor, or agent profiles
