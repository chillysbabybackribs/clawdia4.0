# Extractor Agent Design Spec

**Date:** 2026-03-20
**Status:** Draft
**Scope:** yt-dlp video extractor nested agent loop with browser autonomy

---

## Overview

Extractor is a specialized nested agent loop that autonomously browses to find videos and downloads them using yt-dlp. It follows the same structural pattern as the harness pipeline (`loop-harness.ts`) — a self-contained async function with its own LLM loop, tool set, abort controller, and progress callbacks that never touches `loop.ts` module state.

The agent is triggered via `/extractor` slash command or by the classifier when clear download intent is detected. When download intent is ambiguous, the main loop LLM proactively suggests Extractor once per run.

---

## Architecture

### New file: `src/main/agent/loop-ytdlp.ts`

Self-contained nested agent loop. Public surface:

```typescript
export interface YtdlpPipelineOptions {
  client: ProviderClient;          // used only to read provider id — NOT mutated
  apiKey: string;                  // raw key for constructing the fresh sonnet client
  onProgress: (text: string) => void;
  onRegisterCancel: (fn: () => void) => void;  // must be registerNestedCancel from loop-cancel.ts
}

export interface YtdlpResult {
  success: boolean;
  files: string[];      // absolute paths confirmed on disk
  reason?: string;      // failure reason if success=false
}

export async function runYtdlpPipeline(
  query: string,
  options: YtdlpPipelineOptions,
): Promise<YtdlpResult>
```

**Loop limits:** max 30 iterations, 10 minute wall time.

**Model:** At entry, create a fresh `ProviderClient` with `createProviderClient(client.provider, options.apiKey, resolveModelForProvider(client.provider, 'sonnet'))`. The shared `client` from `ProviderClient` is never mutated — its `provider` field is the only thing read from it.

**Abort:** Private `AbortController` registered via `options.onRegisterCancel`. The caller (`loop.ts`) must pass `registerNestedCancel` from `loop-cancel.ts` and wrap the call in a `try/finally { clearNestedCancel() }` block. `loop.ts` already imports `fireNestedCancel` from `loop-cancel.ts`; it must also import `registerNestedCancel` and `clearNestedCancel`.

**Tool set:** `shell_exec` + all 8 browser tools:
- `browser_search`, `browser_navigate`, `browser_read_page`
- `browser_click`, `browser_type`, `browser_extract`, `browser_scroll`, `browser_screenshot`

**Output directory:** `~/Desktop` — hardcoded in system prompt.

**Filename extraction:** The LLM reads yt-dlp stdout for the `[download] Destination: <path>` line to obtain the actual output filename. It does not construct filenames from the `%(title)s` template. After download it runs `ls "<actual_path>"` to verify the file exists before emitting a sentinel.

**Success sentinel:** `[EXTRACTOR_SUCCESS:<actual_path>]` — one per confirmed file. Multiple sentinels are allowed (playlist downloads). Each is parsed by the pipeline loop to build `result.files`.

**`files` surface:** `result.files` contains all confirmed absolute paths. The call site in `loop.ts` surfaces them in the final response text via `onStreamText`.

**Failure:** Loop exhausts iterations or wall time without a sentinel → `success: false` with reason.

### System prompt

```
You are Extractor, a video download agent inside Clawdia.

Your job: use browser tools to find the exact video URL(s) the user wants,
then download them with yt-dlp to ~/Desktop.

Download command: yt-dlp -o "~/Desktop/%(title)s.%(ext)s" <url>

After each download:
1. Read yt-dlp's stdout for the line: [download] Destination: <path>
2. Run: ls "<path>" to confirm the file exists.
3. If confirmed, output exactly: [EXTRACTOR_SUCCESS:<path>]

Rules:
- Never fabricate download results or file paths.
- If yt-dlp fails, read stderr and retry with --format best or a corrected URL.
- If the video requires login, report to the user — do not attempt to fill credentials.
- If geo-blocked, report and suggest the user configure yt-dlp cookies.
- Stop and report clearly if the video is genuinely unavailable.
- When the task is complete, output a plain summary of what was downloaded.
```

---

## Integration Points

### 1. `src/shared/types.ts`

Add `'ytdlp'` to the `AgentProfile` union. This must be done before `agent-profile-override.ts` is modified, since `applyAgentProfileOverride` receives `AgentProfile` as a parameter type:

```typescript
export type AgentProfile = 'general' | 'filesystem' | 'bloodhound' | 'ytdlp';
```

No new `PromptModule` is needed — the ytdlp profile reuses the existing `'browser'` module.

### 2. `src/main/agent/agent-profile-override.ts`

**Slash command map** — add entry:

```typescript
'/extractor': 'ytdlp',
```

**Override branch** — add before the existing catch-all `'general'` fallback in `applyAgentProfileOverride`. Without this, `'ytdlp'` falls through to the catch-all and is silently reset to `'general'`:

```typescript
if (forcedAgentProfile === 'ytdlp') {
  promptModules.add('browser');
  promptModules.delete('filesystem');
  promptModules.delete('bloodhound');
  return {
    ...baseProfile,
    agentProfile: 'ytdlp',
    toolGroup: 'browser',
    promptModules,
  };
}
```

### 3. `src/main/agent/classifier.ts`

Add `YTDLP_RE` regex for clear download intent:

```typescript
const YTDLP_RE = /\b(download|grab|save|extract|rip)\b.*(video|clip|audio|youtube|youtu\.be|vimeo|twitch|reel|short)|youtu\.be\/|youtube\.com\/watch|vimeo\.com\/\d/i;
```

When matched: `agentProfile: 'ytdlp'`, `toolGroup: 'browser'`.

### 4. `src/main/agent/prompt-builder.ts`

Add a `ytdlp` branch in `buildDynamicPrompt` alongside the existing `filesystem` and `bloodhound` branches:

```typescript
} else if (opts.agentProfile === 'ytdlp') {
  lines.push('PROFILE DIRECTIVE: You are acting as Extractor, a video download agent. Use browser tools to locate the exact video URL(s) the user wants, then download with yt-dlp to ~/Desktop.');
}
```

This injects the Extractor identity into the dynamic system prompt on every ytdlp run. No new `PromptModule` is needed — the profile directive is injected via `agentProfile` branch, same as bloodhound and filesystem.

### 5. `src/main/agent/loop.ts`

**New imports** — add `registerNestedCancel` and `clearNestedCancel` to the existing `loop-cancel.ts` import (which already imports `fireNestedCancel`):

```typescript
import { fireNestedCancel, registerNestedCancel, clearNestedCancel } from './loop-cancel';
```

**Short-circuit placement** — the ytdlp check must be placed **before** the `profile.toolGroup === 'browser'` bloodhound executor check at line 336. Since `ytdlp` routes to `toolGroup: 'browser'`, it would otherwise enter the bloodhound executor block. Insert immediately after `runPreLLMSetup` returns and before the bloodhound check:

```typescript
// ── Extractor agent short-circuit ──
if (profile.agentProfile === 'ytdlp') {
  if (!client.supportsHarnessGeneration) {
    options.onStreamText?.('Extractor requires a provider that supports nested agent loops (Anthropic). Switch providers to use it.');
    options.onStreamEnd?.();
    cleanupRunControl(runKey);
    return { response: '', toolCalls: [] };
  }
  let result: YtdlpResult;
  try {
    result = await runYtdlpPipeline(userMessage, {
      client,
      apiKey: options.apiKey,
      onProgress: (text) => options.onStreamText?.(text),
      onRegisterCancel: registerNestedCancel,
    });
  } finally {
    clearNestedCancel();
  }
  const summary = result.success
    ? `Downloaded ${result.files.length} file(s):\n${result.files.join('\n')}`
    : `Extractor failed: ${result.reason}`;
  options.onStreamText?.(summary);
  options.onStreamEnd?.(); // Early return — skips main loop's onStreamEnd; this call is the only one
  cleanupRunControl(runKey);
  return { response: summary, toolCalls: [] };
}
```

**Suggestion behavior** — after the main loop's final response text is assembled (before `onStreamEnd()` is called at the loop exit), if `profile.agentProfile !== 'ytdlp'` and the final text matches a video/download hint and the suggestion flag is not yet set:

```typescript
const YTDLP_SUGGEST_RE = /\b(video|youtube|download|clip|watch|stream|vimeo|twitch)\b/i;
let ytdlpSuggested = false;  // scoped to this runAgentLoop invocation

// ... (at final text assembly, before onStreamEnd):
if (!ytdlpSuggested && YTDLP_SUGGEST_RE.test(finalText)) {
  ytdlpSuggested = true;
  const hint = '\n\nI have an Extractor agent that can find and download videos automatically — type `/extractor` or ask me to use it.';
  options.onStreamText?.(hint);
  finalText += hint;
}
```

---

## Cancel Architecture

`loop-cancel.ts` exports three functions:
- `registerNestedCancel(fn)` — stores the abort fn (called by `loop-ytdlp.ts` via `onRegisterCancel`)
- `clearNestedCancel()` — clears it (called by `loop.ts`)
- `fireNestedCancel()` — calls and clears it (called by `cancelLoop()` in `loop.ts`, already wired)

**`loop-ytdlp.ts` calls `onRegisterCancel` to register its abort fn and does NOT call `clearNestedCancel` directly — cleanup is entirely the caller's responsibility, matching the `loop-harness.ts` pattern.**

`loop.ts` owns the full cancel lifecycle:
1. Passes `registerNestedCancel` as the `onRegisterCancel` callback into `runYtdlpPipeline`
2. Calls `clearNestedCancel()` in the short-circuit's own `finally` block (covers the ytdlp path)
3. Also adds `clearNestedCancel()` on the line immediately after `cleanupRunControl(runKey)` at line 899 (end of `runAgentLoop`) — guards against any path that bypasses the short-circuit's finally

`fireNestedCancel()` is already wired in `cancelLoop()` — no change needed there.

---

## Data Flow

```
User message / /extractor command
        │
        ▼
classifier.ts → agentProfile: 'ytdlp', toolGroup: 'browser'
        │
        ▼
loop.ts: runPreLLMSetup() → returns SetupResult (unchanged)
        │
        ▼
loop.ts: agentProfile === 'ytdlp' check → short-circuit (BEFORE bloodhound block)
        │
        ├── supportsHarnessGeneration=false → degrade + return early
        │
        ▼
runYtdlpPipeline(userMessage, { client, apiKey, onProgress, onRegisterCancel })
        │
        ├── createProviderClient(provider, apiKey, 'sonnet') — fresh client
        ├── registerNestedCancel → AbortController.abort
        ├── browser_search / browser_navigate → find video URL
        ├── browser_click / browser_extract → confirm identity
        ├── shell_exec: yt-dlp → parse "[download] Destination: <path>"
        ├── shell_exec: ls "<path>" → verify
        └── [EXTRACTOR_SUCCESS:<path>] → files[]
        │
        ▼
finally: clearNestedCancel()
        │
        ▼
loop.ts: onStreamText(summary) → onStreamEnd() → return { response, toolCalls: [] }
```

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| yt-dlp not installed | Pre-flight: `which yt-dlp`; emit install instructions, return `success: false` |
| yt-dlp fails (non-zero exit) | LLM reads stderr, retries with `--format best` or corrected URL |
| Age-gated / login required | Report via onProgress; do not attempt credential entry |
| Geo-blocked | Report; suggest user configure yt-dlp cookies |
| Iteration / wall time limit | `success: false`, reason: `"timed out"` |
| Unsupported provider | Emit clear message; `onStreamEnd()`; return early before pipeline starts |
| User cancels | `fireNestedCancel()` fires AbortController; loop exits via `abortController.signal.aborted` check |

---

## File Map

| File | Change |
|------|--------|
| `src/main/agent/loop-ytdlp.ts` | **Create** — full nested agent loop |
| `src/shared/types.ts` | **Modify** — add `'ytdlp'` to `AgentProfile` (do first) |
| `src/main/agent/agent-profile-override.ts` | **Modify** — add `/extractor` slash mapping + `ytdlp` branch before catch-all |
| `src/main/agent/classifier.ts` | **Modify** — add `YTDLP_RE`, set `agentProfile: 'ytdlp'` when matched |
| `src/main/agent/prompt-builder.ts` | **Modify** — add `agentProfile === 'ytdlp'` branch in `buildDynamicPrompt` injecting `PROFILE DIRECTIVE: You are acting as Extractor, a video download agent. Use browser tools to locate videos and yt-dlp to download them to ~/Desktop.` |
| `src/main/agent/loop.ts` | **Modify** — import `registerNestedCancel`/`clearNestedCancel`; add ytdlp short-circuit before bloodhound block; add `clearNestedCancel()` after `cleanupRunControl` at line 899; add suggestion behavior |

`loop-setup.ts` is **not modified**.

---

## Constraints and Non-Goals

- No new UI components — all output via existing `onStreamText`/`onProgress` callbacks
- No download queue or history persistence
- No format selection UI — LLM picks format autonomously
- No playlist-specific UI — multiple sentinels handle multi-file downloads naturally
- No new `PromptModule` type — reuses `'browser'`
- Does not modify tool schemas or add new tools
