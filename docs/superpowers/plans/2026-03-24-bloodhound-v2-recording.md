# Bloodhound v2 — Recording Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic threshold-gated recording of any completed multi-step agent run into a new `task_sequences` table, with async LLM-assisted step distillation and goal embedding as best-effort post-processing.

**Architecture:** A post-run pipeline hooks into `completeRun()` in `src/main/db/runs.ts`. When a run meets the recording threshold (≥3 tool calls, ≥2 surfaces, any swarm, or >15s duration), `maybeRecordSequence()` synchronously distills `run_events` into clean `SequenceStep[]` and inserts a `task_sequences` row. Two async fire-and-forget jobs then run: an LLM call (Anthropic Haiku → Gemini Flash) normalizes the steps; an embedding call (OpenAI → Gemini) stores a goal vector for future semantic retrieval. Failures in both are silent — the raw steps always land first.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest, existing provider clients via `getApiKey`/`createProviderClient`

**Spec:** `docs/superpowers/specs/2026-03-24-bloodhound-v2-recording-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/main/db/database.ts` | Modify | Add v28 migration for `task_sequences` table |
| `src/main/db/task-sequences.ts` | **Create** | Types + CRUD for `task_sequences` |
| `src/main/agent/bloodhound/distiller.ts` | **Create** | Pure `distillSteps()` + async `distillWithLLM()` |
| `src/main/agent/bloodhound/embedder.ts` | **Create** | Provider-aware `embedGoal()` |
| `src/main/agent/bloodhound/recorder.ts` | **Create** | `maybeRecordSequence()` — pipeline orchestrator |
| `src/main/db/runs.ts` | Modify | Call `maybeRecordSequence()` from `completeRun()` |
| `tests/db/task-sequences.test.ts` | **Create** | CRUD round-trip tests |
| `tests/agent/bloodhound/distiller.test.ts` | **Create** | `distillSteps()` unit tests |
| `tests/agent/bloodhound/embedder.test.ts` | **Create** | `embedGoal()` provider selection tests |
| `tests/agent/bloodhound/recorder.test.ts` | **Create** | `maybeRecordSequence()` integration tests |

---

## Task 1: DB migration + `task-sequences.ts` CRUD

**Files:**
- Modify: `src/main/db/database.ts`
- Create: `src/main/db/task-sequences.ts`
- Create: `tests/db/task-sequences.test.ts`

### Step 1.1 — Write failing CRUD tests

Create `tests/db/task-sequences.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock DB following the exact pattern in tests/db/run-artifacts.test.ts
const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ get: getMock, run: runMock, all: allMock }),
  }),
}));

describe('task-sequences CRUD', () => {
  beforeEach(() => {
    getMock.mockReset();
    runMock.mockReset();
    allMock.mockReset();
  });

  it('insertTaskSequence returns the new row id', async () => {
    runMock.mockReturnValue({ lastInsertRowid: 42 });
    const { insertTaskSequence } = await import('../../src/main/db/task-sequences');
    const id = insertTaskSequence({
      runId: 'run-1',
      goal: 'check github notifications',
      surfaces: ['browser'],
      steps: [],
      outcome: 'success',
      toolCallCount: 3,
      durationMs: 4200,
      createdAt: '2026-03-24T00:00:00.000Z',
    });
    expect(id).toBe(42);
    expect(runMock).toHaveBeenCalledOnce();
  });

  it('getTaskSequence returns null when not found', async () => {
    getMock.mockReturnValue(undefined);
    const { getTaskSequence } = await import('../../src/main/db/task-sequences');
    const result = getTaskSequence(999);
    expect(result).toBeNull();
  });

  it('getTaskSequence deserializes surfaces and steps JSON', async () => {
    const steps = [{ seq: 0, surface: 'browser', tool: 'browser_navigate', input: { url: 'https://github.com' }, outputSummary: 'ok', durationMs: 200, success: true }];
    getMock.mockReturnValue({
      id: 1,
      run_id: 'run-1',
      goal: 'test',
      goal_embedding: null,
      surfaces: JSON.stringify(['browser']),
      steps: JSON.stringify(steps),
      outcome: 'success',
      tool_call_count: 3,
      duration_ms: 4200,
      success_count: 0,
      fail_count: 0,
      last_used: null,
      created_at: '2026-03-24T00:00:00.000Z',
    });
    const { getTaskSequence } = await import('../../src/main/db/task-sequences');
    const result = getTaskSequence(1);
    expect(result).not.toBeNull();
    expect(result!.surfaces).toEqual(['browser']);
    expect(result!.steps).toEqual(steps);
    expect(result!.goalEmbedding).toBeNull();
  });

  it('updateTaskSequenceSteps serializes steps to JSON', async () => {
    runMock.mockReturnValue({ changes: 1 });
    const { updateTaskSequenceSteps } = await import('../../src/main/db/task-sequences');
    const steps = [{ seq: 0, surface: 'browser' as const, tool: 'browser_navigate', input: {}, outputSummary: 'ok', durationMs: 100, success: true }];
    updateTaskSequenceSteps(1, steps);
    expect(runMock).toHaveBeenCalledOnce();
    const calledWith = runMock.mock.calls[0];
    expect(calledWith[0]).toBe(JSON.stringify(steps)); // first arg is serialized steps
  });

  it('updateTaskSequenceEmbedding stores Float32Array as Buffer', async () => {
    runMock.mockReturnValue({ changes: 1 });
    const { updateTaskSequenceEmbedding } = await import('../../src/main/db/task-sequences');
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    updateTaskSequenceEmbedding(1, vec);
    expect(runMock).toHaveBeenCalledOnce();
    const calledWith = runMock.mock.calls[0];
    expect(calledWith[0]).toBeInstanceOf(Buffer); // first arg is Buffer
  });
});
```

- [ ] Save the file.

### Step 1.2 — Run tests to verify they fail

```bash
cd /home/dp/Desktop/clawdia4.0
npx vitest run tests/db/task-sequences.test.ts
```

Expected: FAIL — `task-sequences` module not found.

- [ ] Confirm failure before proceeding.

### Step 1.3 — Create `src/main/db/task-sequences.ts`

```typescript
/**
 * task-sequences — Learned multi-surface task sequences.
 *
 * Records distilled tool sequences from any completed agent run that
 * meets the recording threshold. Used by Bloodhound v2 for retrieval
 * and replay in subsequent sub-projects.
 *
 * Lifecycle:
 *   1. Run completes → recorder.ts checks threshold
 *   2. distillSteps() converts run_events → SequenceStep[]
 *   3. insertTaskSequence() persists raw steps immediately
 *   4. distillWithLLM() improves steps async (best-effort)
 *   5. embedGoal() stores goal vector async (best-effort)
 */

import { getDb } from './database';

// ═══════════════════════════════════
// Types
// ═══════════════════════════════════

export type Surface = 'browser' | 'filesystem' | 'shell' | 'desktop' | 'swarm' | 'memory' | 'other';

export interface SequenceStep {
  seq: number;
  surface: Surface;
  tool: string;
  input: Record<string, any>;
  outputSummary: string;
  durationMs: number;
  success: boolean;
}

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

// ═══════════════════════════════════
// CRUD
// ═══════════════════════════════════

export function insertTaskSequence(row: NewTaskSequence): number {
  const result = getDb().prepare(`
    INSERT INTO task_sequences
      (run_id, goal, surfaces, steps, outcome, tool_call_count, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.runId,
    row.goal,
    JSON.stringify(row.surfaces),
    JSON.stringify(row.steps),
    row.outcome,
    row.toolCallCount,
    row.durationMs,
    row.createdAt,
  );
  return result.lastInsertRowid as number;
}

export function updateTaskSequenceSteps(id: number, steps: SequenceStep[]): void {
  getDb().prepare(`UPDATE task_sequences SET steps = ? WHERE id = ?`)
    .run(JSON.stringify(steps), id);
}

export function updateTaskSequenceEmbedding(id: number, embedding: Float32Array): void {
  getDb().prepare(`UPDATE task_sequences SET goal_embedding = ? WHERE id = ?`)
    .run(Buffer.from(embedding.buffer), id);
}

export function getTaskSequence(id: number): TaskSequence | null {
  const row = getDb().prepare(`SELECT * FROM task_sequences WHERE id = ?`).get(id) as any;
  if (!row) return null;
  return rowToTaskSequence(row);
}

export function listTaskSequences(limit = 100): TaskSequence[] {
  const rows = getDb().prepare(`
    SELECT * FROM task_sequences ORDER BY created_at DESC LIMIT ?
  `).all(limit) as any[];
  return rows.map(rowToTaskSequence);
}

// ═══════════════════════════════════
// Internal
// ═══════════════════════════════════

function rowToTaskSequence(row: any): TaskSequence {
  return {
    id: row.id,
    runId: row.run_id,
    goal: row.goal,
    goalEmbedding: row.goal_embedding
      ? new Float32Array(Buffer.from(row.goal_embedding).buffer)
      : null,
    surfaces: JSON.parse(row.surfaces || '[]'),
    steps: JSON.parse(row.steps || '[]'),
    outcome: row.outcome,
    toolCallCount: row.tool_call_count,
    durationMs: row.duration_ms,
    successCount: row.success_count,
    failCount: row.fail_count,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}
```

- [ ] Save the file.

### Step 1.4 — Run tests to verify they pass

```bash
npx vitest run tests/db/task-sequences.test.ts
```

Expected: all 5 tests pass.

- [ ] Confirm green before proceeding.

### Step 1.5 — Add v28 migration to `src/main/db/database.ts`

Read `src/main/db/database.ts` first to find the end of the v27 migration block and the final `console.log` line. Add the v28 block immediately before that final log line.

**Note:** v27 is already taken by `site_harnesses` annotation columns — use v28.

```typescript
  if (currentVersion < 28) {
    console.log('[DB] Running migration v28: task_sequences');
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_sequences (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          TEXT NOT NULL REFERENCES runs(id),
        goal            TEXT NOT NULL,
        goal_embedding  BLOB,
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
      INSERT INTO schema_version (version) VALUES (28);
    `);
  }
```

Also update the final console.log to reference v28:

Find:
```typescript
  console.log(`[DB] Schema at version ${Math.max(currentVersion, 27)}`);
```
Change to:
```typescript
  console.log(`[DB] Schema at version ${Math.max(currentVersion, 28)}`);
```

- [ ] Save the file.

### Step 1.6 — TypeScript check

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] Confirm clean.

### Step 1.7 — Commit

```bash
git add src/main/db/database.ts src/main/db/task-sequences.ts tests/db/task-sequences.test.ts
git commit -m "$(cat <<'EOF'
feat: add task_sequences table + CRUD layer (Bloodhound v2 recording)

Adds v28 migration creating the task_sequences table for multi-surface
task recording. Implements insertTaskSequence, getTaskSequence,
updateTaskSequenceSteps, updateTaskSequenceEmbedding, listTaskSequences.
Float32Array embeddings stored as BLOB via Buffer round-trip.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `distillSteps()` — pure event-to-steps converter

**Files:**
- Create: `src/main/agent/bloodhound/distiller.ts` (partial — pure function only)
- Create: `tests/agent/bloodhound/distiller.test.ts`

### Step 2.1 — Write failing tests

Create `tests/agent/bloodhound/distiller.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { distillSteps } from '../../../src/main/agent/bloodhound/distiller';
import type { RunEventRecord } from '../../../src/main/db/run-events';

// Helper to build minimal RunEventRecord for tests
function makeEvent(overrides: Partial<RunEventRecord> & Pick<RunEventRecord, 'kind'>): RunEventRecord {
  return {
    id: 1,
    runId: 'run-1',
    seq: 0,
    timestamp: '2026-03-24T00:00:00.000Z',
    phase: 'dispatch',
    surface: 'browser',
    toolName: 'browser_navigate',
    payload: {},
    ...overrides,
  };
}

describe('distillSteps()', () => {
  it('returns empty array for empty events', () => {
    expect(distillSteps([])).toEqual([]);
  });

  it('returns empty array when only lifecycle events present', () => {
    const events = [
      makeEvent({ kind: 'run_started' }),
      makeEvent({ kind: 'run_classified' }),
      makeEvent({ kind: 'run_detached' }),
    ];
    expect(distillSteps(events)).toEqual([]);
  });

  it('pairs tool_started + tool_completed into one SequenceStep', () => {
    const events = [
      makeEvent({
        kind: 'tool_started',
        seq: 0,
        toolName: 'browser_navigate',
        surface: 'browser',
        payload: { toolUseId: 'tid-1', input: { url: 'https://github.com' }, ordinal: 0, detail: '' },
      }),
      makeEvent({
        kind: 'tool_completed',
        seq: 1,
        toolName: 'browser_navigate',
        surface: 'browser',
        payload: { toolUseId: 'tid-1', resultPreview: 'Navigated to github.com', durationMs: 300, detail: '' },
      }),
    ];
    const steps = distillSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      seq: 0,
      surface: 'browser',
      tool: 'browser_navigate',
      input: { url: 'https://github.com' },
      outputSummary: 'Navigated to github.com',
      durationMs: 300,
      success: true,
    });
  });

  it('marks step success=false when closing event is tool_failed', () => {
    const events = [
      makeEvent({
        kind: 'tool_started',
        seq: 0,
        toolName: 'browser_click',
        payload: { toolUseId: 'tid-2', input: { selector: '#btn' }, ordinal: 1, detail: '' },
      }),
      makeEvent({
        kind: 'tool_failed',
        seq: 1,
        toolName: 'browser_click',
        payload: { toolUseId: 'tid-2', resultPreview: 'Element not found', durationMs: 50, detail: '' },
      }),
    ];
    const steps = distillSteps(events);
    expect(steps).toHaveLength(1);
    expect(steps[0].success).toBe(false);
    expect(steps[0].outputSummary).toBe('Element not found');
  });

  it('drops tool_started with no matching closing event', () => {
    const events = [
      makeEvent({
        kind: 'tool_started',
        seq: 0,
        payload: { toolUseId: 'tid-orphan', input: {}, ordinal: 0, detail: '' },
      }),
    ];
    expect(distillSteps(events)).toEqual([]);
  });

  it('assigns correct surface from tool name prefix', () => {
    const events = [
      makeEvent({ kind: 'tool_started', seq: 0, toolName: 'file_read', surface: 'filesystem', payload: { toolUseId: 'a', input: { path: '/tmp/f' }, ordinal: 0, detail: '' } }),
      makeEvent({ kind: 'tool_completed', seq: 1, toolName: 'file_read', surface: 'filesystem', payload: { toolUseId: 'a', resultPreview: 'content', durationMs: 10, detail: '' } }),
      makeEvent({ kind: 'tool_started', seq: 2, toolName: 'shell_exec', surface: 'shell', payload: { toolUseId: 'b', input: { command: 'ls' }, ordinal: 1, detail: '' } }),
      makeEvent({ kind: 'tool_completed', seq: 3, toolName: 'shell_exec', surface: 'shell', payload: { toolUseId: 'b', resultPreview: 'file.txt', durationMs: 20, detail: '' } }),
    ];
    const steps = distillSteps(events);
    expect(steps).toHaveLength(2);
    expect(steps[0].surface).toBe('filesystem');
    expect(steps[1].surface).toBe('shell');
  });

  it('strips sensitive keys from input before storing', () => {
    const events = [
      makeEvent({ kind: 'tool_started', seq: 0, toolName: 'browser_navigate', payload: { toolUseId: 'c', input: { url: 'https://x.com', token: 'secret123', password: 'hunter2' }, ordinal: 0, detail: '' } }),
      makeEvent({ kind: 'tool_completed', seq: 1, toolName: 'browser_navigate', payload: { toolUseId: 'c', resultPreview: 'ok', durationMs: 100, detail: '' } }),
    ];
    const steps = distillSteps(events);
    expect(steps[0].input.token).toBe('[redacted]');
    expect(steps[0].input.password).toBe('[redacted]');
    expect(steps[0].input.url).toBe('https://x.com');
  });

  it('truncates outputSummary to 200 chars', () => {
    const longOutput = 'x'.repeat(300);
    const events = [
      makeEvent({ kind: 'tool_started', seq: 0, toolName: 'file_read', payload: { toolUseId: 'd', input: {}, ordinal: 0, detail: '' } }),
      makeEvent({ kind: 'tool_completed', seq: 1, toolName: 'file_read', payload: { toolUseId: 'd', resultPreview: longOutput, durationMs: 5, detail: '' } }),
    ];
    const steps = distillSteps(events);
    expect(steps[0].outputSummary.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] Save the file.

### Step 2.2 — Run tests to verify they fail

```bash
npx vitest run tests/agent/bloodhound/distiller.test.ts
```

Expected: FAIL — `distiller` module not found.

- [ ] Confirm failure.

### Step 2.3 — Create `src/main/agent/bloodhound/distiller.ts` (pure function only)

First, check what `RunEventRecord` looks like by reading `src/main/db/run-events.ts`. Then create the file:

```typescript
/**
 * Bloodhound Distiller — converts raw run_events into clean SequenceStep[].
 *
 * distillSteps() is a pure function (no I/O). It pairs tool_started +
 * tool_completed/tool_failed events by payload.toolUseId and produces
 * a normalized, sanitized step array.
 *
 * distillWithLLM() is async and best-effort — it uses an LLM to further
 * clean steps and write better summaries. Callers must catch and ignore
 * errors from this function.
 */

import type { RunEventRecord } from '../../db/run-events';
import type { SequenceStep, Surface } from '../../db/task-sequences';
import { getApiKey } from '../../store';
import { createProviderClient } from '../provider/factory';

// ═══════════════════════════════════
// Surface mapping
// ═══════════════════════════════════

const SURFACE_PREFIXES: Array<[string, Surface]> = [
  ['browser_', 'browser'],
  ['file_', 'filesystem'],
  ['directory_', 'filesystem'],
  ['fs_', 'filesystem'],
  ['app_control', 'desktop'],
  ['gui_interact', 'desktop'],
  ['dbus_control', 'desktop'],
  ['memory_', 'memory'],
];
const SURFACE_EXACT: Record<string, Surface> = {
  shell_exec: 'shell',
  agent_spawn: 'swarm',
};

function toolToSurface(toolName: string): Surface {
  if (SURFACE_EXACT[toolName]) return SURFACE_EXACT[toolName];
  for (const [prefix, surface] of SURFACE_PREFIXES) {
    if (toolName.startsWith(prefix)) return surface;
  }
  return 'other';
}

// ═══════════════════════════════════
// Input sanitization
// ═══════════════════════════════════

const REDACT_KEYS = new Set(['password', 'token', 'api_key', 'secret', 'auth', 'cookie', 'credential']);
const REDACT_VALUE_RE = /^sk-[a-zA-Z0-9]{20,}/;

function sanitizeInput(input: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(input)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      result[k] = '[redacted]';
    } else if (typeof v === 'string' && REDACT_VALUE_RE.test(v)) {
      result[k] = '[redacted]';
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ═══════════════════════════════════
// distillSteps — pure, no I/O
// ═══════════════════════════════════

export function distillSteps(events: RunEventRecord[]): SequenceStep[] {
  // Index tool_started events by toolUseId
  const started = new Map<string, RunEventRecord>();
  for (const event of events) {
    if (event.kind === 'tool_started') {
      const toolUseId = event.payload?.toolUseId as string | undefined;
      if (toolUseId) started.set(toolUseId, event);
    }
  }

  const steps: SequenceStep[] = [];

  for (const event of events) {
    if (event.kind !== 'tool_completed' && event.kind !== 'tool_failed') continue;
    const toolUseId = event.payload?.toolUseId as string | undefined;
    if (!toolUseId) continue;

    const startEvent = started.get(toolUseId);
    if (!startEvent) continue;

    const rawInput = (startEvent.payload?.input as Record<string, any>) || {};
    const rawOutput = (event.payload?.resultPreview as string) || '';
    const durationMs = (event.payload?.durationMs as number) || 0;
    const toolName = startEvent.toolName || '';

    steps.push({
      seq: startEvent.seq,
      surface: toolToSurface(toolName),
      tool: toolName,
      input: sanitizeInput(rawInput),
      outputSummary: rawOutput.slice(0, 200),
      durationMs,
      success: event.kind === 'tool_completed',
    });
  }

  // Sort by original sequence order
  steps.sort((a, b) => a.seq - b.seq);
  // Re-number seq 0-based after sort
  steps.forEach((s, i) => { s.seq = i; });

  return steps;
}

// ═══════════════════════════════════
// distillWithLLM — async, best-effort
// ═══════════════════════════════════

export async function distillWithLLM(
  goal: string,
  steps: SequenceStep[],
): Promise<SequenceStep[]> {
  // Try Anthropic Haiku first, fall back to Gemini Flash
  let client;
  const anthropicKey = getApiKey('anthropic');
  const geminiKey = getApiKey('gemini');

  if (anthropicKey) {
    client = createProviderClient('anthropic', anthropicKey, 'claude-haiku-4-5-20251001');
  } else if (geminiKey) {
    client = createProviderClient('gemini', geminiKey, 'gemini-2.5-flash');
  } else {
    throw new Error('No provider available for distillation');
  }

  const prompt = `You are cleaning up a recorded task sequence for storage.

Goal: "${goal}"

Steps (JSON):
${JSON.stringify(steps, null, 2)}

Return ONLY a JSON array of the same steps with:
1. Improved outputSummary (clear, under 100 chars, describes what happened)
2. Cleaned input objects (remove noise keys like timestamps, request IDs, internal metadata)
3. Same seq, surface, tool, durationMs, success values unchanged

Return only the JSON array, no markdown, no explanation.`;

  const response = await client.chat([
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ], { maxTokens: 2048 });

  const text = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');

  // Parse and validate — must be an array of the right length
  const parsed = JSON.parse(text.trim());
  if (!Array.isArray(parsed) || parsed.length !== steps.length) {
    throw new Error('LLM returned wrong number of steps');
  }
  return parsed as SequenceStep[];
}
```

- [ ] Save the file.

### Step 2.4 — Check what `RunEventRecord` interface looks like

Before running tests, read `src/main/db/run-events.ts` to confirm the exact field names on `RunEventRecord` match what the tests assume (`id`, `runId`, `seq`, `timestamp`, `phase`, `surface`, `toolName`, `payload`). If the field names differ (e.g. `run_id` vs `runId`), update the test helper `makeEvent()` to match.

### Step 2.5 — Run tests

```bash
npx vitest run tests/agent/bloodhound/distiller.test.ts
```

Expected: all 8 tests pass.

If tests fail due to `RunEventRecord` field name mismatches, fix `makeEvent()` in the test file to match the actual interface. Do not change the implementation.

- [ ] Confirm green.

### Step 2.6 — TypeScript check

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] Confirm clean.

### Step 2.7 — Commit

```bash
git add src/main/agent/bloodhound/distiller.ts tests/agent/bloodhound/distiller.test.ts
git commit -m "$(cat <<'EOF'
feat: add distillSteps() for run_events → SequenceStep conversion

Pure function that pairs tool_started + tool_completed/tool_failed events
by payload.toolUseId, assigns surface from tool name prefix, sanitizes
sensitive input keys, and truncates outputSummary to 200 chars.
Includes distillWithLLM() async best-effort step normalizer.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `embedder.ts` — provider-aware goal embedding

**Files:**
- Create: `src/main/agent/bloodhound/embedder.ts`
- Create: `tests/agent/bloodhound/embedder.test.ts`

### Step 3.1 — Write failing tests

Create `tests/agent/bloodhound/embedder.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock store before importing embedder
vi.mock('../../../src/main/store', () => ({
  getApiKey: vi.fn(),
}));

// Mock fetch for embedding API calls
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('embedGoal()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
  });

  it('uses OpenAI when openai key is available', async () => {
    const { getApiKey } = await import('../../../src/main/store');
    vi.mocked(getApiKey).mockImplementation((p) => p === 'openai' ? 'sk-test' : '');

    const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ data: [{ embedding: fakeEmbedding }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    const { embedGoal } = await import('../../../src/main/agent/bloodhound/embedder');
    const result = await embedGoal('check github notifications');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('openai.com');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(1536);
  });

  it('falls back to Gemini when no OpenAI key', async () => {
    const { getApiKey } = await import('../../../src/main/store');
    vi.mocked(getApiKey).mockImplementation((p) => p === 'gemini' ? 'gemini-key' : '');

    const fakeEmbedding = Array.from({ length: 768 }, () => 0.2);
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ embedding: { values: fakeEmbedding } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));

    const { embedGoal } = await import('../../../src/main/agent/bloodhound/embedder');
    const result = await embedGoal('check github notifications');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('googleapis.com');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
  });

  it('throws when neither OpenAI nor Gemini key is available', async () => {
    const { getApiKey } = await import('../../../src/main/store');
    vi.mocked(getApiKey).mockReturnValue('');

    const { embedGoal } = await import('../../../src/main/agent/bloodhound/embedder');
    await expect(embedGoal('test')).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] Save the file.

### Step 3.2 — Run tests to verify they fail

```bash
npx vitest run tests/agent/bloodhound/embedder.test.ts
```

Expected: FAIL — `embedder` module not found.

- [ ] Confirm failure.

### Step 3.3 — Create `src/main/agent/bloodhound/embedder.ts`

```typescript
/**
 * Bloodhound Embedder — embeds goal text using the best available provider.
 *
 * Tries OpenAI text-embedding-3-small (1536-dim) first, falls back to
 * Gemini text-embedding-004 (768-dim). Throws if neither key is available.
 *
 * Callers must catch and ignore errors — embedding is best-effort.
 */

import { getApiKey } from '../../store';

export async function embedGoal(goal: string): Promise<Float32Array> {
  const openaiKey = getApiKey('openai');
  if (openaiKey) {
    return embedWithOpenAI(goal, openaiKey);
  }

  const geminiKey = getApiKey('gemini');
  if (geminiKey) {
    return embedWithGemini(goal, geminiKey);
  }

  throw new Error('[Bloodhound] No embedding provider available (need OpenAI or Gemini key)');
}

async function embedWithOpenAI(text: string, apiKey: string): Promise<Float32Array> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: 'text-embedding-3-small',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI embedding error ${response.status}: ${err}`);
  }

  const json = await response.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(json.data[0].embedding);
}

async function embedWithGemini(text: string, apiKey: string): Promise<Float32Array> {
  const model = 'text-embedding-004';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini embedding error ${response.status}: ${err}`);
  }

  const json = await response.json() as { embedding: { values: number[] } };
  return new Float32Array(json.embedding.values);
}
```

- [ ] Save the file.

### Step 3.4 — Run tests

```bash
npx vitest run tests/agent/bloodhound/embedder.test.ts
```

Expected: all 3 tests pass.

If the Vitest module cache causes import ordering issues (mock not applied before import), add `vi.resetModules()` in `beforeEach`. See the pattern in existing retry-fetch tests for guidance.

- [ ] Confirm green.

### Step 3.5 — TypeScript check

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] Confirm clean.

### Step 3.6 — Commit

```bash
git add src/main/agent/bloodhound/embedder.ts tests/agent/bloodhound/embedder.test.ts
git commit -m "$(cat <<'EOF'
feat: add embedGoal() for provider-aware goal text embedding

Tries OpenAI text-embedding-3-small (1536-dim) first, falls back to
Gemini text-embedding-004 (768-dim). Throws when neither provider key
is available. Callers are responsible for catching and ignoring errors.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `recorder.ts` — pipeline orchestrator

**Files:**
- Create: `src/main/agent/bloodhound/recorder.ts`
- Create: `tests/agent/bloodhound/recorder.test.ts`

### Step 4.1 — Write failing tests

Create `tests/agent/bloodhound/recorder.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock all dependencies before any imports
vi.mock('../../../src/main/db/database', () => ({
  getDb: () => ({
    prepare: (_sql: string) => ({ get: getMock, run: runMock, all: allMock }),
  }),
}));

const getMock = vi.fn();
const runMock = vi.fn();
const allMock = vi.fn();

vi.mock('../../../src/main/db/runs', () => ({
  getRun: vi.fn(),
}));

vi.mock('../../../src/main/db/run-events', () => ({
  getRunEventRecords: vi.fn(),
}));

vi.mock('../../../src/main/db/task-sequences', () => ({
  insertTaskSequence: vi.fn().mockReturnValue(1),
  updateTaskSequenceSteps: vi.fn(),
  updateTaskSequenceEmbedding: vi.fn(),
}));

vi.mock('../../../src/main/agent/bloodhound/distiller', () => ({
  distillSteps: vi.fn().mockReturnValue([
    { seq: 0, surface: 'browser', tool: 'browser_navigate', input: {}, outputSummary: 'ok', durationMs: 100, success: true },
    { seq: 1, surface: 'browser', tool: 'browser_click', input: {}, outputSummary: 'clicked', durationMs: 50, success: true },
    { seq: 2, surface: 'browser', tool: 'browser_extract', input: {}, outputSummary: 'data', durationMs: 80, success: true },
  ]),
  distillWithLLM: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/main/agent/bloodhound/embedder', () => ({
  embedGoal: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2])),
}));

function makeRunRow(overrides: Record<string, any> = {}) {
  return {
    id: 'run-1',
    conversation_id: 'conv-1',
    title: 'test run',
    goal: 'check github notifications',
    status: 'completed',
    started_at: new Date(Date.now() - 20000).toISOString(), // 20s ago → > 15s threshold
    updated_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    tool_call_count: 3,
    error: null,
    was_detached: 0,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    workflow_stage: 'complete',
    ...overrides,
  };
}

function makeToolEvents(count = 3) {
  const events: any[] = [];
  for (let i = 0; i < count; i++) {
    events.push({ kind: 'tool_started', seq: i * 2, toolName: 'browser_navigate', payload: { toolUseId: `tid-${i}`, input: {}, ordinal: i, detail: '' } });
    events.push({ kind: 'tool_completed', seq: i * 2 + 1, toolName: 'browser_navigate', payload: { toolUseId: `tid-${i}`, resultPreview: 'ok', durationMs: 100, detail: '' } });
  }
  return events;
}

describe('maybeRecordSequence()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMock.mockReturnValue({ lastInsertRowid: 1 });
  });

  it('skips recording when run has fewer than 3 tool calls and duration < 15s and single surface', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({
      tool_call_count: 2,
      started_at: new Date(Date.now() - 5000).toISOString(), // 5s
    }));
    vi.mocked(getRunEventRecords).mockReturnValue(makeToolEvents(2));

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'completed');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    expect(vi.mocked(insertTaskSequence)).not.toHaveBeenCalled();
  });

  it('records when tool_call_count >= 3', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({ tool_call_count: 3, started_at: new Date(Date.now() - 5000).toISOString() }));
    vi.mocked(getRunEventRecords).mockReturnValue(makeToolEvents(3));

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'completed');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    expect(vi.mocked(insertTaskSequence)).toHaveBeenCalledOnce();
  });

  it('records with outcome=partial when status is cancelled and steps exist', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({ tool_call_count: 3, started_at: new Date(Date.now() - 5000).toISOString() }));
    vi.mocked(getRunEventRecords).mockReturnValue(makeToolEvents(3));

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'cancelled');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    const callArg = vi.mocked(insertTaskSequence).mock.calls[0][0];
    expect(callArg.outcome).toBe('partial');
  });

  it('skips recording when cancelled with 0 successful tool calls', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({ tool_call_count: 0, started_at: new Date(Date.now() - 5000).toISOString() }));
    vi.mocked(getRunEventRecords).mockReturnValue([]);

    const { distillSteps } = await import('../../../src/main/agent/bloodhound/distiller');
    vi.mocked(distillSteps).mockReturnValue([]);

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'cancelled');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    expect(vi.mocked(insertTaskSequence)).not.toHaveBeenCalled();
  });

  it('records when duration > 15 seconds even if tool count < 3', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    const { getRunEventRecords } = await import('../../../src/main/db/run-events');
    vi.mocked(getRun).mockReturnValue(makeRunRow({
      tool_call_count: 1,
      started_at: new Date(Date.now() - 20000).toISOString(), // 20s ago
    }));
    vi.mocked(getRunEventRecords).mockReturnValue(makeToolEvents(1));

    const { distillSteps } = await import('../../../src/main/agent/bloodhound/distiller');
    vi.mocked(distillSteps).mockReturnValue([
      { seq: 0, surface: 'browser', tool: 'browser_navigate', input: {}, outputSummary: 'ok', durationMs: 20000, success: true },
    ]);

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await maybeRecordSequence('run-1', 'completed');

    const { insertTaskSequence } = await import('../../../src/main/db/task-sequences');
    expect(vi.mocked(insertTaskSequence)).toHaveBeenCalledOnce();
  });

  it('does not throw when getRun returns null', async () => {
    const { getRun } = await import('../../../src/main/db/runs');
    vi.mocked(getRun).mockReturnValue(null);

    const { maybeRecordSequence } = await import('../../../src/main/agent/bloodhound/recorder');
    await expect(maybeRecordSequence('missing-run', 'completed')).resolves.not.toThrow();
  });
});
```

- [ ] Save the file.

### Step 4.2 — Run tests to verify they fail

```bash
npx vitest run tests/agent/bloodhound/recorder.test.ts
```

Expected: FAIL — `recorder` module not found.

- [ ] Confirm failure.

### Step 4.3 — Create `src/main/agent/bloodhound/recorder.ts`

First, read `src/main/db/runs.ts` to confirm `getRun()` and `getRunEventRecords()` are exported (and their return types). Then create:

```typescript
/**
 * Bloodhound Recorder — post-run sequence capture pipeline.
 *
 * Called from completeRun() after a run finishes. Checks recording
 * thresholds, distills run_events into SequenceStep[], and persists
 * to task_sequences. Async LLM distillation and embedding are
 * fire-and-forget — failures are logged and ignored.
 */

import { getRun } from '../../db/runs';
import type { RunStatus } from '../../db/runs';
import { getRunEventRecords } from '../../db/run-events';
import { insertTaskSequence, updateTaskSequenceSteps, updateTaskSequenceEmbedding } from '../../db/task-sequences';
import type { Surface } from '../../db/task-sequences';
import { distillSteps, distillWithLLM } from './distiller';
import { embedGoal } from './embedder';

// ═══════════════════════════════════
// Thresholds
// ═══════════════════════════════════

const MIN_TOOL_CALLS = 3;
const MIN_DURATION_MS = 15_000;

// ═══════════════════════════════════
// Entry point
// ═══════════════════════════════════

export async function maybeRecordSequence(
  runId: string,
  status: RunStatus,
): Promise<void> {
  try {
    const run = getRun(runId);
    if (!run) return;

    const events = getRunEventRecords(runId);
    const steps = distillSteps(events);

    // Determine outcome and whether to record
    const successfulSteps = steps.filter(s => s.success).length;
    // RunRow fields are snake_case (raw DB row)
    const durationMs = run.completed_at
      ? new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()
      : Date.now() - new Date(run.started_at).getTime();

    const surfaces = [...new Set(steps.map(s => s.surface))] as Surface[];
    const hasSwarm = events.some(e => e.kind === 'tool_started' && e.toolName === 'agent_spawn');

    // Check thresholds — run fields are snake_case (raw RunRow from DB)
    const meetsThreshold =
      run.tool_call_count >= MIN_TOOL_CALLS ||
      surfaces.length >= 2 ||
      hasSwarm ||
      durationMs > MIN_DURATION_MS;

    if (!meetsThreshold) return;

    // Determine outcome
    const isFailedOrCancelled = status === 'cancelled' || status === 'failed';
    if (isFailedOrCancelled && successfulSteps === 0) return;

    const outcome = status === 'completed'
      ? 'success'
      : 'partial';

    const goal = run.goal || run.title || '';

    // Insert raw steps synchronously
    const sequenceId = insertTaskSequence({
      runId,
      goal,
      surfaces,
      steps,
      outcome,
      toolCallCount: run.tool_call_count,
      durationMs,
      createdAt: new Date().toISOString(),
    });

    // Fire-and-forget: LLM distillation
    setImmediate(() => {
      distillWithLLM(goal, steps)
        .then(improved => updateTaskSequenceSteps(sequenceId, improved))
        .catch(err => console.warn('[Bloodhound] distillWithLLM failed:', err.message));
    });

    // Fire-and-forget: goal embedding
    setImmediate(() => {
      embedGoal(goal)
        .then(vec => updateTaskSequenceEmbedding(sequenceId, vec))
        .catch(err => console.warn('[Bloodhound] embedGoal failed:', err.message));
    });

  } catch (err: any) {
    console.warn('[Bloodhound] maybeRecordSequence failed:', err.message);
  }
}
```

- [ ] Save the file.

### Step 4.4 — Verify imports compile

`getRun` is in `src/main/db/runs.ts` and returns `RunRow` with snake_case fields (`tool_call_count`, `started_at`, `completed_at`, `goal`, `title`) — the recorder uses these correctly as written above.

`getRunEventRecords` is in `src/main/db/run-events.ts` — the recorder imports it from `../../db/run-events`. Confirm the function name by checking the exports of that file before saving.

- [ ] Read `src/main/db/run-events.ts` and confirm `getRunEventRecords` is the exact export name. If it differs, update the import in `recorder.ts` to match.

### Step 4.5 — Run tests

```bash
npx vitest run tests/agent/bloodhound/recorder.test.ts
```

Expected: all 6 tests pass.

If tests fail due to import errors on `getRunEventRecords`, verify the export name in `src/main/db/run-events.ts` and update the import in `recorder.ts` accordingly.

- [ ] Confirm green.

### Step 4.6 — TypeScript check

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] Confirm clean.

### Step 4.7 — Commit

```bash
git add src/main/agent/bloodhound/recorder.ts tests/agent/bloodhound/recorder.test.ts
git commit -m "$(cat <<'EOF'
feat: add maybeRecordSequence() — Bloodhound v2 recording pipeline

Threshold-gated post-run recording: checks tool count (>=3), surfaces
(>=2), swarm spawn, or duration (>15s). Inserts raw steps synchronously;
fires distillWithLLM and embedGoal as best-effort async jobs. All errors
caught and warned, never thrown to caller.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire into `completeRun()` + final verification

**Files:**
- Modify: `src/main/db/runs.ts`

### Step 5.1 — Read `src/main/db/runs.ts`

Read the full file to confirm:
1. The exact signature of `completeRun()`
2. The import style used at the top (ESM `import` statements)
3. That there are no existing Bloodhound calls to avoid duplicating

### Step 5.2 — Add the call to `completeRun()`

In `src/main/db/runs.ts`, add the import at the top (after existing imports):

```typescript
import { maybeRecordSequence } from '../agent/bloodhound/recorder';
```

In `completeRun()`, after the existing `getDb().prepare(...).run(...)` call:

```typescript
// Non-blocking — Bloodhound records qualifying runs async
maybeRecordSequence(id, status).catch(err =>
  console.warn('[Bloodhound] recording failed silently:', err.message)
);
```

- [ ] Save the file.

### Step 5.3 — TypeScript check

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] Confirm clean.

### Step 5.4 — Run full test suite

```bash
npx vitest run
```

Expected: all new tests pass, pre-existing tests unchanged (233 passing, 1 pre-existing failure in `manager-isolation.test.ts`). Zero new failures.

- [ ] Confirm clean.

### Step 5.5 — Verify the pipeline is connected

```bash
grep -n "maybeRecordSequence" \
  src/main/db/runs.ts \
  src/main/agent/bloodhound/recorder.ts
```

Expected: at least one hit in each file.

- [ ] Confirm both files show the function.

### Step 5.6 — Commit

```bash
git add src/main/db/runs.ts
git commit -m "$(cat <<'EOF'
feat: wire Bloodhound v2 recording into completeRun()

maybeRecordSequence() is now called after every run completion.
Fire-and-forget — never throws to completeRun(), never affects
run status or UI. Threshold check inside recorder filters noise.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Checklist

- [ ] Task 1: `task_sequences` migration + CRUD
- [ ] Task 2: `distillSteps()` + `distillWithLLM()`
- [ ] Task 3: `embedGoal()`
- [ ] Task 4: `maybeRecordSequence()` pipeline
- [ ] Task 5: Wire into `completeRun()` + final verification
