# Local Background Agent — Design Spec

**Date:** 2026-03-24
**Status:** In Review
**Scope:** `src/main/agent/local/` (new), `src/main/agent/memory-extractor.ts`, `src/main/agent/bloodhound/distiller.ts`, `src/main/agent/bloodhound/embedder.ts`

---

## Overview

A small local language model running on the user's machine acts as an invisible background infrastructure layer — owning mechanical, high-frequency, or privacy-sensitive inference tasks that currently consume cloud API tokens. The local model is never in the critical path of a user-initiated run. It is always async, always best-effort, and the system degrades gracefully to existing cloud fallbacks when no local model is available.

The integration ships in two phases with a clean hand-off point.

---

## Why This Is Worth Building

In 2026, the typical Clawdia user machine has an NPU, integrated neural engine, or mid-tier discrete GPU capable of running 1–7B parameter models at 20–80 tokens/second. The current codebase makes cloud API calls for several tasks that are mechanical enough to run locally:

| Location | Task | Current cost |
|----------|------|-------------|
| `memory-extractor.ts` | Structured fact extraction from conversation | ~500–1500 tokens/day (fires every 10s during active use) |
| `bloodhound/distiller.ts` | Step normalization for recorded sequences | ~100–200 tokens/run (every qualifying run) |
| `bloodhound/embedder.ts` | Goal text embedding for semantic retrieval | Cloud embedding API call per recorded sequence |
| `loop-recovery.ts` | File-fix recovery iteration | ~500–1000 tokens per verification failure |
| `graph-executor.ts` | Research result merge/synthesis | ~500–800 tokens per graph task |

None of these require frontier-model reasoning. All are fire-and-forget with silent fallback already in place or trivial to add.

---

## Phase 1 — Drop-In Replacements

**Ships after:** Bloodhound v2 sub-project 1 (Recording) completes.

**No daemon, no new process.** A `LocalModelClient` is introduced that wraps any OpenAI-compatible local HTTP endpoint. The three highest-value call sites are updated to try local inference first, falling back to the existing cloud path transparently.

### LocalModelClient

**File:** `src/main/agent/local/client.ts`

```typescript
export interface LocalModelConfig {
  baseUrl: string;       // e.g. 'http://localhost:11434/v1'
  model: string;         // e.g. 'qwen2.5:3b'
  timeoutMs?: number;    // default: 15000
}

export class LocalModelClient {
  constructor(config: LocalModelConfig) {}

  // Returns null on any error — caller falls back to cloud
  async chat(systemPrompt: string, userContent: string): Promise<string | null>

  // Returns null if model unavailable or inference fails
  async embed(text: string): Promise<Float32Array | null>

  // Probe endpoint — used by auto-detector
  async isAvailable(): Promise<boolean>
}
```

- Uses `fetch()` against the OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings` endpoints
- All errors caught internally — never throws to caller
- No tool use, no streaming — simple single-turn chat and embedding only
- `timeoutMs` defaults to 15 seconds (local inference can be slow on CPU)

### Model Auto-Detect

**File:** `src/main/agent/local/auto-detect.ts`

```typescript
export interface LocalModelStatus {
  available: boolean;
  baseUrl: string;
  model: string | null;
  source: 'ollama' | 'user-configured' | 'none';
}

export async function detectLocalModel(): Promise<LocalModelStatus>
```

Detection order:
1. Check user-configured endpoint from Electron store key `localModel.baseUrl` + `localModel.model`
2. Probe Ollama by calling `http://localhost:11434/api/tags` (the Ollama-native listing endpoint — note: **not** under `/v1`). If the response is 200, Ollama is running.
3. If Ollama found, prefer first model matching priority list: `qwen2.5:3b`, `phi4-mini`, `llama3.2:3b`, `mistral:7b`, then first available. Store `baseUrl` as `http://localhost:11434/v1` for use by `LocalModelClient` (OpenAI-compatible endpoint).
4. Return `{ available: false, source: 'none' }` if nothing found

Detection runs once at Electron app startup and result is cached in memory. Re-detection triggered if user changes settings.

### Integration Point 1 — Memory Extraction

**File:** `src/main/agent/memory-extractor.ts` (modified)

Current `doExtraction()` calls `createProviderClient(provider, apiKey, fastModel)` then `client.chat()`. Note: `memory-extractor.ts` imports via `from './client'` (the barrel re-export at `src/main/agent/client.ts`), not directly from `provider/factory.ts`. New files in `src/main/agent/local/` should use the same barrel import for consistency.

Updated flow:
```
doExtraction()
  ├─ get cached LocalModelStatus
  ├─ if available: LocalModelClient.chat(EXTRACTION_PROMPT, userContent)
  │    ├─ success: parse JSON, store facts → done
  │    └─ null returned: fall through to cloud path
  └─ cloud path: existing createProviderClient + client.chat() (unchanged)
```

The `EXTRACTION_PROMPT` is unchanged — it's already a well-structured few-shot prompt that small models handle well. JSON parsing and `remember()` storage are unchanged.

### Integration Point 2 — Bloodhound Step Distillation

**File:** `src/main/agent/bloodhound/distiller.ts` (modified at creation time)

The `distillWithLLM()` function (which burns Haiku/Flash) is updated to try local first:

```
distillWithLLM(goal, steps)
  ├─ if local available: LocalModelClient.chat(distillPrompt, stepsJson)
  │    ├─ success: parse improved SequenceStep[], return
  │    └─ null: fall through
  └─ cloud path: getApiKey('anthropic') — check with `if (!key)` (returns '' not null when unset)
                 → getApiKey('gemini') — same empty-string check
                 → throw if neither available (existing spec behavior)
```

### Integration Point 3 — Bloodhound Goal Embedding

**File:** `src/main/agent/bloodhound/embedder.ts` (modified at creation time)

The `embedGoal()` function is updated to try local first:

```
embedGoal(goal)
  ├─ if local available: LocalModelClient.embed(goal)
  │    ├─ success: return Float32Array
  │    └─ null: fall through
  └─ cloud path: OpenAI text-embedding-3-small → Gemini text-embedding-004 → throw
```

Local embedding models (e.g. `nomic-embed-text` via Ollama) produce 768-dim vectors. OpenAI `text-embedding-3-small` produces 1536-dim vectors. Gemini `text-embedding-004` produces 768-dim vectors but in a different embedding space than local models.

**Data integrity constraint:** To avoid accumulating mixed-dimension blobs in `task_sequences.goal_embedding` with no recovery path, the embedding source and dimension must be stored alongside the blob. Add two columns to the `task_sequences` table (as part of Bloodhound v2 sub-project 1, not a separate migration):

```sql
embedding_dim      INTEGER,   -- e.g. 768 or 1536, NULL when goal_embedding is NULL
embedding_source   TEXT       -- 'openai' | 'gemini' | 'local', NULL when goal_embedding is NULL
```

The Retrieval sub-project uses `embedding_source` and `embedding_dim` to normalize vectors at query time. Without these columns, cosine similarity between mixed-dimension vectors will crash or produce garbage silently.

---

## Phase 2 — Background Daemon

**Ships after:** Bloodhound v2 sub-project 3 (Replay) completes.

**Dependency gate:** The hardening loop requires Replay infrastructure to be in place. Phase 1 ships and runs independently.

A `LocalAgentDaemon` runs as a Node.js child process spawned by the Electron main process. It owns a job queue and runs on idle time. Communication is over a typed IPC channel using `child_process.fork()`.

**Build requirement:** `daemon-worker.ts` must be a **separate esbuild/webpack entry point** so it compiles to its own `daemon-worker.js` output file. The fork path in `daemon.ts` must use `path.join(__dirname, 'daemon-worker.js')` — a path that resolves correctly in both development and packaged Electron builds. A relative TypeScript import will not work at runtime.

### Daemon Architecture

**File:** `src/main/agent/local/daemon.ts` (main process side — lifecycle manager)
**File:** `src/main/agent/local/daemon-worker.ts` (child process — job runner, separate build entry)

```
Main Process
  └─ LocalAgentDaemon (daemon.ts)
       ├─ spawns daemon-worker.ts via child_process.fork()
       ├─ sends jobs via IPC: { type: 'job', job: DaemonJob }
       ├─ receives results via IPC: { type: 'result', jobId, outcome }
       ├─ restarts worker on crash (max 3 restarts per hour)
       └─ stops worker on app quit

Daemon Worker (daemon-worker.ts)
  └─ JobQueue
       ├─ MemoryDistillerJob    — runs every 6 hours
       ├─ SequenceHardenerJob   — runs every 30 minutes
       └─ (future jobs added here)
```

### IPC Message Types

```typescript
// Main → Worker
type DaemonCommand =
  | { type: 'job'; job: DaemonJob }
  | { type: 'stop' }

// Worker → Main
type DaemonResult =
  | { type: 'result'; jobId: string; outcome: 'success' | 'skipped' | 'failed'; detail?: string }
  | { type: 'ready' }
  | { type: 'log'; level: 'info' | 'warn'; message: string }
```

### Job: Memory Distiller

**Cadence:** Every 6 hours (idle-time only)

Reads the last N `user_memory` rows, groups by category, and asks the local model to:
- Deduplicate entries with the same key
- Merge related facts into a single canonical entry
- Flag stale entries (e.g. "current_project: X" that conflicts with a newer entry)

Results are written back via the existing `remember()` / `pruneMemories()` functions. No new DB schema needed.

**Why local:** Pure compression/deduplication task. Small context window (memory rows are short). Failure is silent — existing memories remain untouched.

### Job: Sequence Hardener

**Cadence:** Every 30 minutes (idle-time only)

**Requires:** Bloodhound v2 sub-project 3 (Replay)

Queries `task_sequences` for entries where:
- `outcome = 'partial'` OR
- `fail_count > 0` OR
- `success_count = 0` (never successfully replayed)

For each candidate (up to 5 per run to limit compute):
1. Load the `SequenceStep[]` for the sequence
2. Ask local model to identify which steps look fragile (e.g. hardcoded selectors, timing-dependent waits, steps that previously failed)
3. Propose repaired step variants
4. Run headless replay via existing Replay infrastructure
5. On success: increment `success_count`, update `steps` with repaired version
6. On failure: increment `fail_count`, log detail

The local model's role here is **step analysis and repair proposal** — the actual replay execution uses the existing Replay executor, not the local model.

**Why local:** Runs on idle time, no user waiting. Failure is completely silent. Replay infrastructure handles the actual browser/tool execution.

### Idle-Time Scheduling

The daemon worker checks a simple idle heuristic before running jobs:
- `os.loadavg()[0]` (1-minute load average) must be below `os.cpus().length * 0.4`
- If machine is busy, jobs are deferred by 5 minutes and re-checked

This prevents the daemon from competing with active runs or the user's own workload.

---

## Local Model Recommendations

For users who want guidance on what to install:

| Use case | Recommended model | Size | Notes |
|----------|------------------|------|-------|
| General (all jobs) | `qwen2.5:3b` | ~2GB | Best all-round small model, strong JSON output |
| Embedding only | `nomic-embed-text` | ~300MB | Excellent retrieval quality, fast |
| Higher quality | `phi4-mini` | ~4GB | Better reasoning, needs 8GB+ RAM |
| GPU users | `llama3.2:3b` | ~2GB | Fast on GPU, good instruction following |

The auto-detector picks the best available from this list. Users never need to configure this manually unless they prefer a different model.

---

## Settings

Two new keys in Electron store (`~/.config/Clawdia/config.json`):

```json
{
  "localModel": {
    "enabled": true,
    "baseUrl": null,       // null = use auto-detected Ollama; string = user override
    "model": null,         // null = use auto-detected model; string = user override
    "daemonEnabled": true  // Phase 2 only — controls whether daemon is started
  }
}
```

`enabled: false` disables all local model paths. All call sites fall through to cloud immediately.

---

## Error Handling

- `LocalModelClient.chat()` and `.embed()` always return `null` on error — never throw
- Auto-detect failure is silent — `available: false` is the safe default
- Daemon worker crash: main process restarts it up to 3 times per hour, then stops retrying and logs a warning
- Daemon job failure: logged as `{ type: 'result', outcome: 'failed' }`, next scheduled run proceeds normally
- All Phase 1 integration points have a cloud fallback that is identical to the pre-integration behavior

---

## Dependency Gates

| Phase | Gate | Reason |
|-------|------|--------|
| Phase 1 — memory extraction | None | `memory-extractor.ts` exists and works now |
| Phase 1 — distillWithLLM | Bloodhound v2 sub-project 1 (Recording) ships | `distiller.ts` is created as part of that work; requires migration v28 (not v27 — already taken) |
| Phase 1 — embedGoal | Bloodhound v2 sub-project 1 (Recording) ships | `embedder.ts` is created as part of that work; `task_sequences` table must include `embedding_dim` + `embedding_source` columns (added to migration v28) |
| Phase 2 — daemon + hardener | Bloodhound v2 sub-project 3 (Replay) ships | Hardener drives replay; no replay = no hardener |
| Phase 2 — memory distiller | Phase 1 ships | Builds on same LocalModelClient |

---

## Testing

**`local/client.ts`**
- `chat()` returns parsed string on 200 response
- `chat()` returns null on network error, timeout, non-200 status
- `embed()` returns Float32Array on success
- `embed()` returns null on error
- `isAvailable()` probes endpoint correctly

**`local/auto-detect.ts`**
- Returns user-configured endpoint when store key set
- Probes Ollama and picks preferred model from priority list
- Returns `available: false` when nothing found
- Caches result after first call

**`memory-extractor.ts`**
- When local available: uses local path, skips cloud call
- When local returns null: falls through to cloud path unchanged
- Cloud path behavior unchanged from pre-integration

**`daemon.ts`**
- Worker is restarted on crash (up to 3x/hour)
- Worker is stopped cleanly on app quit
- Jobs are not dispatched when `localModel.enabled = false`

**`daemon-worker.ts` (MemoryDistillerJob)**
- Skips run when machine load is high
- Deduplicates memory rows correctly
- Silent on failure — does not crash worker

**`daemon-worker.ts` (SequenceHardenerJob)**
- Queries only `partial`/`fail_count > 0`/`success_count = 0` sequences
- Limits to 5 candidates per run
- Increments `success_count` on successful replay
- Silent on failure

---

## Out of Scope

- Local model as a user-selectable LLM for the foreground agent loop
- Fine-tuning or training local models on user data
- Loop recovery integration (lower priority — rare trigger, complex to swap mid-recovery)
- Graph executor merge integration (lower priority — less frequent than memory extraction)
- UI for browsing daemon job history
- Per-user model performance benchmarking
