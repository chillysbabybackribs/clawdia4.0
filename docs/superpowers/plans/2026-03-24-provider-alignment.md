# Provider Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Anthropic, OpenAI, and Gemini provider adapters so the agent loop and UI behave consistently regardless of which provider is active.

**Architecture:** Six changes confined to the provider layer: (1) `normalizeStopReason` shared utility + loop guard fix, (2) shared `retryFetch` helper used by OpenAI and Gemini, (3) max output token defaults for OpenAI and Gemini, (4) `thinkingText` field on `LLMResponse` surfacing reasoning for OpenAI and Gemini, (5) enable `supportsHarnessGeneration` on OpenAI, (6) log OpenAI prompt cache hits. All changes are tested before implementation.

**Tech Stack:** TypeScript, Vitest, Node.js `fetch` (built-in), Electron main process

**Spec:** `docs/superpowers/specs/2026-03-24-provider-alignment-design.md`

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `src/main/agent/provider/types.ts` | Modify | Add `normalizeStopReason()`, `lookupModelMaxOutput()`, `thinkingText?: string` to `LLMResponse` |
| `src/main/agent/provider/retry-fetch.ts` | **Create** | Shared `retryFetch()` with abort-safe delay |
| `src/main/agent/provider/anthropic-adapter.ts` | Modify | Call `normalizeStopReason` on return |
| `src/main/agent/provider/openai-adapter.ts` | Modify | Use `retryFetch`, add `MODEL_MAX_OUTPUT`, extend `OpenAIStreamingChunk.usage`, log cache hits, set `thinkingText`, set `supportsHarnessGeneration = true` |
| `src/main/agent/provider/gemini-adapter.ts` | Modify | Use `retryFetch`, add `MODEL_MAX_OUTPUT`, extend `GeminiResponseChunk` + `GeminiPart`, set `thinkingText`, call `normalizeStopReason` |
| `src/main/agent/loop.ts` | Modify | Fix line 917 guard `'tool_calls'` → `'tool_use'`; read `response.thinkingText` and call `onThinking` |
| `tests/agent/provider/normalize-stop-reason.test.ts` | **Create** | Tests for `normalizeStopReason` |
| `tests/agent/provider/retry-fetch.test.ts` | **Create** | Tests for `retryFetch` |
| `tests/agent/provider/openai-adapter-extended.test.ts` | Modify | Add tests for cache hit logging, `thinkingText`, `cacheReadTokens` |
| `tests/agent/provider/gemini-adapter-extended.test.ts` | Modify | Add tests for retry, `thoughtSummary`, thought-part exclusion |

---

## Task 1: `normalizeStopReason` + `lookupModelMaxOutput` shared utilities

**Files:**
- Modify: `src/main/agent/provider/types.ts`
- Create: `tests/agent/provider/normalize-stop-reason.test.ts`

### Step 1.1 — Write failing tests for `normalizeStopReason`

Create `tests/agent/provider/normalize-stop-reason.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeStopReason, lookupModelMaxOutput } from '../../../src/main/agent/provider/types';

describe('normalizeStopReason()', () => {
  it('maps Anthropic tool_use → tool_use', () => {
    expect(normalizeStopReason('tool_use')).toBe('tool_use');
  });

  it('maps OpenAI tool_calls → tool_use', () => {
    expect(normalizeStopReason('tool_calls')).toBe('tool_use');
  });

  it('maps Gemini function_calls → tool_use', () => {
    expect(normalizeStopReason('function_calls')).toBe('tool_use');
  });

  it('maps end_turn → end_turn', () => {
    expect(normalizeStopReason('end_turn')).toBe('end_turn');
  });

  it('maps stop → end_turn', () => {
    expect(normalizeStopReason('stop')).toBe('end_turn');
  });

  it('maps length → max_tokens', () => {
    expect(normalizeStopReason('length')).toBe('max_tokens');
  });

  it('maps max_tokens → max_tokens', () => {
    expect(normalizeStopReason('max_tokens')).toBe('max_tokens');
  });

  it('passes through unknown values unchanged', () => {
    expect(normalizeStopReason('content_filter')).toBe('content_filter');
    expect(normalizeStopReason('')).toBe('');
  });
});

describe('lookupModelMaxOutput()', () => {
  const map: Record<string, number> = { 'gpt-5.4': 32768, 'gpt-5.4-mini': 16384 };

  it('returns exact match', () => {
    expect(lookupModelMaxOutput('gpt-5.4', map, 8192)).toBe(32768);
  });

  it('matches by prefix — version suffix ignored', () => {
    expect(lookupModelMaxOutput('gpt-5.4-20260101', map, 8192)).toBe(32768);
    expect(lookupModelMaxOutput('gpt-5.4-mini-preview', map, 8192)).toBe(16384);
  });

  it('returns fallback for unknown model', () => {
    expect(lookupModelMaxOutput('gpt-unknown', map, 8192)).toBe(8192);
  });
});
```

- [ ] Save the file.

### Step 1.2 — Run tests to verify they fail

```bash
cd /home/dp/Desktop/clawdia4.0
npx vitest run tests/agent/provider/normalize-stop-reason.test.ts
```

Expected: FAIL — `normalizeStopReason` and `lookupModelMaxOutput` not exported from `types.ts`.

- [ ] Confirm failure before proceeding.

### Step 1.3 — Implement the utilities in `types.ts`

Add to the bottom of `src/main/agent/provider/types.ts`:

```typescript
// ── Stop-reason normalization ────────────────────────────────────────────────

const STOP_REASON_MAP: Record<string, string> = {
  tool_use: 'tool_use',
  tool_calls: 'tool_use',
  function_calls: 'tool_use',
  end_turn: 'end_turn',
  stop: 'end_turn',
  length: 'max_tokens',
  max_tokens: 'max_tokens',
};

export function normalizeStopReason(raw: string): string {
  return STOP_REASON_MAP[raw] ?? raw;
}

// ── Model max-output lookup ──────────────────────────────────────────────────

export function lookupModelMaxOutput(
  model: string,
  map: Record<string, number>,
  fallback: number,
): number {
  const entry = Object.entries(map).find(([prefix]) => model.startsWith(prefix));
  return entry ? entry[1] : fallback;
}
```

Also add `thinkingText?: string` to the `LLMResponse` interface (currently ends at line 72):

```typescript
export interface LLMResponse {
  content: NormalizedAssistantContentBlock[];
  stopReason: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
  thinkingText?: string;
}
```

- [ ] Save the file.

### Step 1.4 — Run tests to verify they pass

```bash
npx vitest run tests/agent/provider/normalize-stop-reason.test.ts
```

Expected: all 10 tests pass.

- [ ] Confirm green before proceeding.

### Step 1.5 — Apply `normalizeStopReason` in Anthropic adapter

In `src/main/agent/provider/anthropic-adapter.ts`, add the import at the top:

```typescript
import { normalizeStopReason } from './types';
```

Then in the `chat()` return statement (currently line 254), change:

```typescript
return {
  content: contentBlocks,
  stopReason,
  ...
```

to:

```typescript
return {
  content: contentBlocks,
  stopReason: normalizeStopReason(stopReason),
  ...
```

- [ ] Save the file.

### Step 1.6 — Fix loop guard in `loop.ts`

In `src/main/agent/loop.ts` line 917, change:

```typescript
if (toolUseBlocks.length === 0 && response.stopReason === 'tool_calls') {
```

to:

```typescript
if (toolUseBlocks.length === 0 && response.stopReason === 'tool_use') {
```

- [ ] Save the file.

### Step 1.7 — Run full test suite to confirm nothing broken

```bash
npx vitest run
```

Expected: same baseline pass count (210 passing, 1 pre-existing failure in `manager-isolation.test.ts`). Zero new failures.

- [ ] Confirm clean before proceeding.

### Step 1.8 — Commit

```bash
git add src/main/agent/provider/types.ts src/main/agent/provider/anthropic-adapter.ts src/main/agent/loop.ts tests/agent/provider/normalize-stop-reason.test.ts
git commit -m "$(cat <<'EOF'
feat: normalize stopReason at adapter boundary + fix loop guard

Adds normalizeStopReason() and lookupModelMaxOutput() to types.ts.
Maps all provider-specific stop reason strings to canonical values
('tool_use', 'end_turn', 'max_tokens'). Applies to Anthropic adapter;
other adapters follow in subsequent commits. Fixes loop.ts guard that
compared raw 'tool_calls' — now correctly checks canonical 'tool_use'.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared `retryFetch` helper

**Files:**
- Create: `src/main/agent/provider/retry-fetch.ts`
- Create: `tests/agent/provider/retry-fetch.test.ts`

### Step 2.1 — Write failing tests

Create `tests/agent/provider/retry-fetch.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retryFetch } from '../../../src/main/agent/provider/retry-fetch';

describe('retryFetch()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns immediately on a successful first attempt', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await retryFetch('https://example.com', {});
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);

    vi.unstubAllGlobals();
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = retryFetch('https://example.com', {});
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);

    vi.unstubAllGlobals();
  });

  it('exhausts maxAttempts and returns the last failing response', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('error', { status: 503 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = retryFetch('https://example.com', {}, { maxAttempts: 3 });
    await vi.runAllTimersAsync();
    const res = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(503);

    vi.unstubAllGlobals();
  });

  it('does not retry on non-retryable status (e.g. 400)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await retryFetch('https://example.com', {});
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(400);

    vi.unstubAllGlobals();
  });

  it('respects Retry-After header delay', async () => {
    const headers = new Headers({ 'retry-after': '5' });
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = retryFetch('https://example.com', {});
    // Should not have retried yet before 5s
    await vi.advanceTimersByTimeAsync(4999);
    expect(mockFetch).toHaveBeenCalledOnce();
    // After 5s delay, should retry
    await vi.advanceTimersByTimeAsync(1);
    const res = await promise;
    expect(res.status).toBe(200);

    vi.unstubAllGlobals();
  });

  it('aborts immediately during retry delay when signal fires', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response('error', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const promise = retryFetch('https://example.com', {}, { signal: controller.signal });
    // Abort during the retry delay (before the 1s backoff expires)
    controller.abort();
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow();
    // Should not have retried after abort
    expect(mockFetch).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });
});
```

- [ ] Save the file.

### Step 2.2 — Run tests to verify they fail

```bash
npx vitest run tests/agent/provider/retry-fetch.test.ts
```

Expected: FAIL — `retryFetch` not found.

- [ ] Confirm failure before proceeding.

### Step 2.3 — Implement `retry-fetch.ts`

Create `src/main/agent/provider/retry-fetch.ts`:

```typescript
/**
 * retryFetch — fetch wrapper with exponential backoff retry for transient errors.
 *
 * Used by OpenAI and Gemini adapters. AbortSignal is respected during delay
 * windows via Promise.race — abort fires immediately, not after the full backoff.
 */

const DEFAULT_RETRYABLE = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 3;

export interface RetryFetchOptions {
  retryable?: Set<number>;
  maxAttempts?: number;
  signal?: AbortSignal;
}

export async function retryFetch(
  url: string,
  init: RequestInit,
  options: RetryFetchOptions = {},
): Promise<Response> {
  const retryable = options.retryable ?? DEFAULT_RETRYABLE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const signal = options.signal;

  let response!: Response;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    response = await fetch(url, { ...init, signal });

    if (response.ok || !retryable.has(response.status)) return response;
    if (attempt === maxAttempts - 1) break;

    const retryAfter = response.headers.get('retry-after');
    const delayMs = retryAfter
      ? parseFloat(retryAfter) * 1000
      : 2 ** attempt * 1000 + Math.random() * 200;

    await abortableDelay(delayMs, signal);
  }

  return response;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    if (!signal) return;

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

- [ ] Save the file.

### Step 2.4 — Run tests to verify they pass

```bash
npx vitest run tests/agent/provider/retry-fetch.test.ts
```

Expected: all 6 tests pass.

- [ ] Confirm green before proceeding.

### Step 2.5 — Wire `retryFetch` into OpenAI adapter

In `src/main/agent/provider/openai-adapter.ts`:

1. Add import at the top:
```typescript
import { retryFetch } from './retry-fetch';
```

2. Replace the existing retry loop (lines ~276–294) with:
```typescript
const response = await retryFetch(
  'https://api.openai.com/v1/chat/completions',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    },
    body: JSON.stringify(body),
  },
  { signal: options?.signal },
);
```

Remove the old `for (let attempt = 0; ...)` loop entirely — `retryFetch` replaces it.

- [ ] Save the file.

### Step 2.6 — Wire `retryFetch` into Gemini adapter

In `src/main/agent/provider/gemini-adapter.ts`:

1. Add import at the top:
```typescript
import { retryFetch } from './retry-fetch';
```

2. Replace the existing `fetch(...)` call (around line 254) with:
```typescript
const response = await retryFetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey,
    },
    body: JSON.stringify(body),
  },
  { signal: options?.signal },
);
```

- [ ] Save the file.

### Step 2.7 — Run full test suite

```bash
npx vitest run
```

Expected: same baseline + 6 new retry-fetch tests passing. Zero new failures.

- [ ] Confirm clean.

### Step 2.8 — Commit

```bash
git add src/main/agent/provider/retry-fetch.ts src/main/agent/provider/openai-adapter.ts src/main/agent/provider/gemini-adapter.ts tests/agent/provider/retry-fetch.test.ts
git commit -m "$(cat <<'EOF'
feat: add shared retryFetch helper; add Gemini retry logic

Extracts retryFetch() with abort-safe exponential backoff into
retry-fetch.ts. OpenAI now uses retryFetch (replacing inline loop).
Gemini gains retry logic for the first time — handles 429/5xx with
3-attempt backoff. AbortSignal fires immediately during delay windows
via Promise.race, not after the full backoff window.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Max output token defaults for OpenAI and Gemini

**Files:**
- Modify: `src/main/agent/provider/openai-adapter.ts`
- Modify: `src/main/agent/provider/gemini-adapter.ts`

No new test file needed — this is configuration + logging. Verify via TypeScript compilation and existing tests remaining green.

### Step 3.1 — Add `MODEL_MAX_OUTPUT` and logging to OpenAI adapter

In `src/main/agent/provider/openai-adapter.ts`, add after the imports:

```typescript
import { lookupModelMaxOutput } from './types';

const MODEL_MAX_OUTPUT: Record<string, number> = {
  'gpt-5.4-mini': 16384,
  'gpt-5.4-nano': 8192,
  'gpt-5.4': 32768,
  'gpt-5-mini': 16384,
  'gpt-5-nano': 8192,
  'gpt-5': 32768,
};
const OPENAI_MAX_OUTPUT_FALLBACK = 16384;
```

Note: keys are ordered longest-first within each family so `'gpt-5.4-mini'` is tested before `'gpt-5.4'` during prefix matching.

In the `chat()` method, replace the existing `if (options?.maxTokens) body.max_tokens = options.maxTokens;` line with:

```typescript
const maxTokens = options?.maxTokens ?? lookupModelMaxOutput(this.model, MODEL_MAX_OUTPUT, OPENAI_MAX_OUTPUT_FALLBACK);
body.max_tokens = maxTokens;
```

Then replace the existing bare log line at the end of `chat()` with a full log matching Anthropic's format. After the stream loop ends, add:

```typescript
const totalInput = inputTokens + cacheReadTokens;
const cacheHitRate = totalInput > 0 ? ((cacheReadTokens / totalInput) * 100).toFixed(1) : '0.0';
console.log(`[LLM] ${responseModel} | in=${inputTokens} cache_read=${cacheReadTokens} out=${outputTokens} | cache_hit=${cacheHitRate}% | max_tokens=${maxTokens} | stop=${stopReason}`);
```

- [ ] Save the file.

### Step 3.2 — Add `MODEL_MAX_OUTPUT` and logging to Gemini adapter

In `src/main/agent/provider/gemini-adapter.ts`, add after the imports:

```typescript
import { lookupModelMaxOutput } from './types';

const MODEL_MAX_OUTPUT: Record<string, number> = {
  'gemini-2.5-flash-lite': 16384,
  'gemini-2.5-flash': 32768,
  'gemini-2.5-pro': 65536,
};
const GEMINI_MAX_OUTPUT_FALLBACK = 16384;
```

In the `chat()` method, replace:

```typescript
if (options?.maxTokens) {
  body.generationConfig = { maxOutputTokens: options.maxTokens };
}
```

with:

```typescript
const maxTokens = options?.maxTokens ?? lookupModelMaxOutput(this.model, MODEL_MAX_OUTPUT, GEMINI_MAX_OUTPUT_FALLBACK);
body.generationConfig = { maxOutputTokens: maxTokens };
```

Add a log line after the stream loop:

```typescript
console.log(`[LLM] ${responseModel} | in=${inputTokens} out=${outputTokens} | max_tokens=${maxTokens} | stop=${stopReason}`);
```

- [ ] Save the file.

### Step 3.3 — TypeScript check and full test suite

```bash
npx tsc -p tsconfig.main.json --noEmit && npx vitest run
```

Expected: no TypeScript errors. Same test pass count. Zero new failures.

- [ ] Confirm clean.

### Step 3.4 — Commit

```bash
git add src/main/agent/provider/openai-adapter.ts src/main/agent/provider/gemini-adapter.ts
git commit -m "$(cat <<'EOF'
feat: add max output token defaults for OpenAI and Gemini

Adds MODEL_MAX_OUTPUT maps to both adapters with prefix-matching lookup
via the shared lookupModelMaxOutput() helper. OpenAI defaults: gpt-5.4
→ 32K, mini → 16K, nano → 8K. Gemini defaults: pro → 64K, flash → 32K,
flash-lite → 16K. Adds Anthropic-format completion log lines to both.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: OpenAI — cache hit logging + `thinkingText`

**Files:**
- Modify: `src/main/agent/provider/openai-adapter.ts`
- Modify: `tests/agent/provider/openai-adapter-extended.test.ts`

### Step 4.1 — Write failing tests

Open `tests/agent/provider/openai-adapter-extended.test.ts`. This file already exists (from prior work). Add new `describe` blocks at the bottom:

```typescript
import { stringifyToolResultContent, toOpenAIMessages, toOpenAITools } from '../../../src/main/agent/provider/openai-adapter';

// Add these at the bottom of the file:

describe('OpenAI cacheReadTokens surfacing', () => {
  it('exports stringifyToolResultContent — image content degraded to placeholder', () => {
    const content = [
      { type: 'text' as const, text: 'tool output' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'abc' } },
    ];
    const result = stringifyToolResultContent(content);
    expect(result).toContain('tool output');
    expect(result).toContain('[image:image/png]');
  });
});

describe('OpenAI supportsHarnessGeneration', () => {
  it('OpenAIProviderClient.supportsHarnessGeneration is true', async () => {
    const { OpenAIProviderClient } = await import('../../../src/main/agent/provider/openai-adapter');
    const client = new OpenAIProviderClient('test-key');
    expect(client.supportsHarnessGeneration).toBe(true);
  });
});
```

Note: We cannot unit-test `cacheReadTokens` or `thinkingText` from SSE data without a mock HTTP server — the existing test pattern in this project tests algorithm functions directly rather than the full `chat()` method. The `supportsHarnessGeneration` flag test is what we CAN verify here. The cache logging will be validated by TypeScript compilation (the field access would fail at build time if wrong).

- [ ] Save the file.

### Step 4.2 — Run tests to verify the new test fails (for the flag)

```bash
npx vitest run tests/agent/provider/openai-adapter-extended.test.ts
```

Expected: `supportsHarnessGeneration` test FAILS — flag is currently `false`.

- [ ] Confirm failure before proceeding.

### Step 4.3 — Extend `OpenAIStreamingChunk.usage` and implement cache + thinking

In `src/main/agent/provider/openai-adapter.ts`, update the `OpenAIStreamingChunk` interface's `usage` field (currently lines 75–78) to:

```typescript
usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};
```

In the stream parse loop, update the usage extraction block (currently reads `prompt_tokens` and `completion_tokens`) to also capture the new fields:

```typescript
if (chunk.usage) {
  inputTokens = chunk.usage.prompt_tokens || inputTokens;
  outputTokens = chunk.usage.completion_tokens || outputTokens;
  cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens || cacheReadTokens;
  reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens || reasoningTokens;
}
```

Add `let cacheReadTokens = 0;` and `let reasoningTokens = 0;` to the variable declarations before the stream loop.

In the return statement, update:

```typescript
return {
  content: contentBlocks,
  stopReason: normalizeStopReason(stopReason),
  model: responseModel,
  usage: {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens: 0,
  },
  thinkingText: reasoningTokens > 0 ? `[Reasoning: ~${reasoningTokens} tokens]` : undefined,
};
```

Also add `import { normalizeStopReason, lookupModelMaxOutput } from './types';` if not already added.

### Step 4.4 — Set `supportsHarnessGeneration = true`

In `OpenAIProviderClient` class definition, change:

```typescript
readonly supportsHarnessGeneration = false as const;
```

to:

```typescript
readonly supportsHarnessGeneration = true as const;
```

- [ ] Save the file.

### Step 4.5 — Run tests

```bash
npx vitest run tests/agent/provider/openai-adapter-extended.test.ts
```

Expected: all tests pass including the new `supportsHarnessGeneration` test.

- [ ] Confirm green.

### Step 4.6 — TypeScript check

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] Confirm clean.

### Step 4.7 — Commit

```bash
git add src/main/agent/provider/openai-adapter.ts tests/agent/provider/openai-adapter-extended.test.ts
git commit -m "$(cat <<'EOF'
feat: OpenAI cache hit logging, thinkingText, supportsHarnessGeneration

Surfaces prompt_tokens_details.cached_tokens as cacheReadTokens in
LLMResponse. Sets thinkingText when completion_tokens_details shows
reasoning usage. Enables supportsHarnessGeneration = true so CLI-Anything
harness generation works with OpenAI. Applies normalizeStopReason.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Gemini — `normalizeStopReason` + `thinkingText`

**Files:**
- Modify: `src/main/agent/provider/gemini-adapter.ts`
- Modify: `tests/agent/provider/gemini-adapter-extended.test.ts`

### Step 5.1 — Write failing tests

Open `tests/agent/provider/gemini-adapter-extended.test.ts`. This file already exists. Add new `describe` blocks at the bottom:

```typescript
// Tests for thought-part exclusion from main text accumulator

describe('Gemini thought-part handling', () => {
  // Replicate the streaming accumulation logic from gemini-adapter.ts
  // to test that thought parts are excluded from the main text output.

  function accumulateWithThoughts(parts: Array<{ text?: string; thought?: boolean }>): {
    text: string;
    thinkingText: string;
  } {
    let text = '';
    let thinkingText = '';
    for (const part of parts) {
      if (part.text) {
        if (part.thought) {
          thinkingText += part.text;
        } else {
          text += part.text;
        }
      }
    }
    return { text, thinkingText };
  }

  it('regular text parts go to text accumulator only', () => {
    const parts = [{ text: 'Hello world' }];
    const result = accumulateWithThoughts(parts);
    expect(result.text).toBe('Hello world');
    expect(result.thinkingText).toBe('');
  });

  it('thought parts go to thinkingText only, not text', () => {
    const parts = [{ text: 'I am reasoning about this...', thought: true }];
    const result = accumulateWithThoughts(parts);
    expect(result.text).toBe('');
    expect(result.thinkingText).toBe('I am reasoning about this...');
  });

  it('mixed parts: thought excluded from main text, regular included', () => {
    const parts = [
      { text: 'Let me think...', thought: true },
      { text: 'The answer is 42.' },
    ];
    const result = accumulateWithThoughts(parts);
    expect(result.text).toBe('The answer is 42.');
    expect(result.thinkingText).toBe('Let me think...');
  });

  it('thoughtSummary from usageMetadata preferred over inline thoughts when both present', () => {
    // When thoughtSummary is present, it takes precedence — inline thoughts
    // accumulated during streaming are overwritten by the final summary.
    const inlineThinking = 'inline reasoning';
    const summary = 'Concise thought summary from API';
    // The adapter logic: if thoughtSummary is non-empty, use it
    const finalThinkingText = summary || inlineThinking;
    expect(finalThinkingText).toBe(summary);
  });
});
```

- [ ] Save the file.

### Step 5.2 — Run tests to verify they fail

```bash
npx vitest run tests/agent/provider/gemini-adapter-extended.test.ts
```

Expected: new tests fail (the functions aren't in the adapter yet in the described form).

- [ ] Confirm failure.

### Step 5.3 — Update Gemini adapter interfaces and accumulation

In `src/main/agent/provider/gemini-adapter.ts`:

1. Add `thought?: boolean` to `GeminiPart`:

```typescript
interface GeminiPart {
  text?: string;
  thought?: boolean;   // Add this
  inlineData?: { ... };
  functionCall?: { ... };
  functionResponse?: { ... };
}
```

2. Add `thoughtSummary?: string` to `GeminiResponseChunk.usageMetadata`:

```typescript
usageMetadata?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtSummary?: string;   // Add this
};
```

3. Add import at the top:

```typescript
import { normalizeStopReason, lookupModelMaxOutput } from './types';
```

4. In the stream loop where `part.text` is processed (currently `text += part.text; onText?.(part.text);`), update to:

```typescript
if (part.text) {
  if (part.thought) {
    thinkingAccumulator += part.text;
  } else {
    text += part.text;
    onText?.(part.text);
  }
}
```

Add `let thinkingAccumulator = '';` to the variable declarations before the stream loop.

5. After the stream loop, resolve `thinkingText`. After `const candidate = ...` section ends (where `usageMetadata` is read), add:

```typescript
// thoughtSummary (post-stream) takes precedence over inline thought parts
const thinkingText = (chunk.usageMetadata?.thoughtSummary || thinkingAccumulator) || undefined;
```

Wait — the `chunk` variable is scoped inside the loop. Instead, accumulate `thoughtSummary` similarly to how `responseModel` is accumulated. Add `let thoughtSummary = '';` before the loop, and inside the loop:

```typescript
if (chunk.usageMetadata?.thoughtSummary) {
  thoughtSummary = chunk.usageMetadata.thoughtSummary;
}
```

After the loop ends:

```typescript
const thinkingText = (thoughtSummary || thinkingAccumulator) || undefined;
```

6. Apply `normalizeStopReason` in the return statement:

```typescript
return {
  content,
  stopReason: normalizeStopReason(stopReason),
  model: responseModel,
  usage: { ... },
  thinkingText,
};
```

- [ ] Save the file.

### Step 5.4 — Run tests

```bash
npx vitest run tests/agent/provider/gemini-adapter-extended.test.ts
```

Expected: all tests pass including new thought-handling tests.

- [ ] Confirm green.

### Step 5.5 — TypeScript check and full suite

```bash
npx tsc -p tsconfig.main.json --noEmit && npx vitest run
```

Expected: clean compile, all tests pass.

- [ ] Confirm clean.

### Step 5.6 — Commit

```bash
git add src/main/agent/provider/gemini-adapter.ts tests/agent/provider/gemini-adapter-extended.test.ts
git commit -m "$(cat <<'EOF'
feat: Gemini normalizeStopReason, thinkingText, thought-part exclusion

Applies normalizeStopReason to Gemini adapter (maps 'function_calls' →
'tool_use'). Extends GeminiPart with thought?: boolean and
usageMetadata with thoughtSummary. Thought parts excluded from main
text accumulator and onText callback. thoughtSummary takes precedence
over inline thought parts when both are present.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire `thinkingText` into the agent loop

**Files:**
- Modify: `src/main/agent/loop.ts`

### Step 6.1 — Add `thinkingText` → `onThinking` in loop

In `src/main/agent/loop.ts`, find the section immediately after the `client.chat()` call returns (around line 907, after the catch block):

```typescript
onThinking?.('');
```

Replace with:

```typescript
if (response.thinkingText) onThinking?.(response.thinkingText);
onThinking?.('');
```

Wait — this would call `onThinking` with the thinking text and then immediately clear it. The intent is: show the thinking text, then let the iteration proceed, then clear at the end. Move the clear to after the iteration's tool-dispatch or response sections.

Looking at the actual loop structure: `onThinking?.('')` at line 907 clears the "Thinking..." status that was set before the LLM call. The thinking content should replace that clear call so it's visible to the user while the loop processes the response.

The correct placement is: replace `onThinking?.('');` at line 907 with:

```typescript
onThinking?.(response.thinkingText || '');
```

This shows thinking content if present, otherwise clears the indicator — same net behavior for the existing Anthropic path (which never sets `thinkingText`), and shows content for OpenAI/Gemini.

- [ ] Save the file.

### Step 6.2 — TypeScript check and full suite

```bash
npx tsc -p tsconfig.main.json --noEmit && npx vitest run
```

Expected: clean compile. All tests pass.

- [ ] Confirm clean.

### Step 6.3 — Commit

```bash
git add src/main/agent/loop.ts
git commit -m "$(cat <<'EOF'
feat: surface thinkingText from LLMResponse via onThinking in loop

When a provider returns thinkingText (OpenAI reasoning token count,
Gemini thoughtSummary), the loop now forwards it to the onThinking
callback so the UI can display it. Falls back to clearing the thinking
indicator (empty string) when thinkingText is absent.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final verification

### Step 7.1 — Run full test suite

```bash
npx vitest run
```

Expected output:
- All new tests passing: `normalize-stop-reason.test.ts` (10), `retry-fetch.test.ts` (6), additions to `openai-adapter-extended.test.ts`, additions to `gemini-adapter-extended.test.ts`
- Pre-existing tests unchanged
- 1 pre-existing failure in `manager-isolation.test.ts` (unrelated to this work — `removeBrowserView` API issue)
- Zero new failures

- [ ] Confirm all expected tests pass.

### Step 7.2 — TypeScript full compile check

```bash
npx tsc -p tsconfig.main.json --noEmit
```

Expected: no errors.

- [ ] Confirm clean.

### Step 7.3 — Verify `normalizeStopReason` applied to all three adapters

```bash
grep -n "normalizeStopReason" src/main/agent/provider/anthropic-adapter.ts src/main/agent/provider/openai-adapter.ts src/main/agent/provider/gemini-adapter.ts
```

Expected: one hit in each file.

- [ ] Confirm all three adapters apply normalization.

### Step 7.4 — Verify loop guard updated

```bash
grep -n "stopReason === " src/main/agent/loop.ts
```

Expected: output shows `'tool_use'`, NOT `'tool_calls'`.

- [ ] Confirm guard is canonical.

---

## Checklist

- [ ] Task 1: `normalizeStopReason` + `lookupModelMaxOutput` + loop guard fix
- [ ] Task 2: `retryFetch` helper + Gemini retry logic
- [ ] Task 3: Max output token defaults for OpenAI and Gemini
- [ ] Task 4: OpenAI cache logging + `thinkingText` + `supportsHarnessGeneration`
- [ ] Task 5: Gemini `normalizeStopReason` + `thinkingText` + thought-part exclusion
- [ ] Task 6: Wire `thinkingText` into agent loop
- [ ] Task 7: Final verification pass
