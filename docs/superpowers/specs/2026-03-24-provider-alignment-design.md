# Provider Alignment Design

**Date:** 2026-03-24
**Status:** In Review
**Scope:** `src/main/agent/provider/` — all three adapters plus shared types, plus one loop guard fix

---

## Goal

Align the behavior of the Anthropic, OpenAI, and Gemini provider adapters so that the agent loop, tooling, and UI experience are consistent regardless of which provider is active. Six targeted changes, all confined to the provider layer or just above it, plus one loop guard fix required by the stopReason normalization.

---

## Background — Divergence Map

Raw values returned by each provider before normalization:

| Dimension | Anthropic | OpenAI | Gemini (post-lowercase) |
|---|---|---|---|
| stopReason (tool) | `"tool_use"` | `"tool_calls"` | `"function_calls"` |
| stopReason (done) | `"end_turn"` | `"stop"` | `"stop"` |
| stopReason (truncated) | `"max_tokens"` | `"length"` | `"max_tokens"` |
| Retry on 429/5xx | SDK-internal | 3-attempt backoff | None |
| Prompt caching | Full (explicit headers) | Automatic (prefix-based) — cache hits not logged | Not supported |
| Max output tokens | Per-model defaults (8K/64K/32K) | No default | No default |
| Image in tool results | Full pass-through | Degraded to placeholder | Degraded to placeholder |
| Thinking/reasoning | `onThinking` via loop | Best-effort via `usage.completion_tokens_details.reasoning_tokens` (not streamed in Chat Completions API) | `thoughtSummary` in `usageMetadata` after stream |
| `supportsHarnessGeneration` | `true` | `false` | `false` |

Note: Gemini's adapter already calls `.toLowerCase()` on `finishReason`, so the raw API value `"FUNCTION_CALLS"` becomes `"function_calls"` before normalization.

---

## Changes

### 1. Normalize `stopReason` at the adapter boundary + fix loop guard

**Problem:** Each provider returns different strings for the same semantic states. One existing loop guard in `loop.ts` explicitly checks for the raw `'tool_calls'` string (line 917), which would break silently if normalization changed that value.

**Design:**
- Add `normalizeStopReason(raw: string): string` to `types.ts`
- Canonical vocabulary:
  - `'tool_use'` — any provider signalled tool calls (`"tool_use"` / `"tool_calls"` / `"function_calls"`)
  - `'end_turn'` — clean finish (`"end_turn"` / `"stop"`)
  - `'max_tokens'` — output truncated (`"max_tokens"` / `"length"`)
  - Pass-through for unknowns — the loop's termination condition is driven by `toolUseBlocks.length`, not `stopReason`, so an unrecognized passthrough value does not cause a hang; it falls through the tool-use check, then through the narration/denial guards, and terminates normally. This is existing behaviour and is not changed by this spec.
- Each adapter calls `normalizeStopReason` before returning `LLMResponse`
- Mapping per provider:
  - Anthropic: `"tool_use"` → `"tool_use"` (already canonical), `"end_turn"` → `"end_turn"`, `"max_tokens"` → `"max_tokens"`
  - OpenAI: `"tool_calls"` → `"tool_use"`, `"stop"` → `"end_turn"`, `"length"` → `"max_tokens"`
  - Gemini: `"function_calls"` → `"tool_use"`, `"stop"` → `"end_turn"`, `"max_tokens"` → `"max_tokens"`
- Update `loop.ts` line 917: change `response.stopReason === 'tool_calls'` to `response.stopReason === 'tool_use'` so the GPT-5 streaming race condition guard continues to fire correctly after normalization

**Files:** `provider/types.ts`, `anthropic-adapter.ts`, `openai-adapter.ts`, `gemini-adapter.ts`, `loop.ts` (one-line guard fix)

---

### 2. Shared retry-fetch helper + Gemini retry logic

**Problem:** OpenAI has 3-attempt exponential backoff for 429/502/503/504. Gemini has no retry logic — a single transient error throws immediately. The retry code would otherwise be duplicated.

**Design:**
- Extract `retryFetch(url, init, options?)` into `provider/retry-fetch.ts`
- Signature: `retryFetch(url: string, init: RequestInit, options?: { retryable?: Set<number>; maxAttempts?: number; signal?: AbortSignal }): Promise<Response>`
- Defaults: `retryable = {429, 502, 503, 504}`, `maxAttempts = 3`
- Backoff delay: uses `Retry-After` header when present; falls back to `2^attempt * 1000ms + jitter`
- **Abort-during-delay:** the delay must use `Promise.race([timeoutPromise, abortPromise])` — not a plain `setTimeout` — so that an `AbortSignal` fires immediately during the wait rather than after the full delay. The abort listener must be registered with `{ once: true }` (or explicitly removed in a `finally` block) to prevent orphaned listeners accumulating on long-running loops.
- Replace `openai-adapter.ts` fetch loop with `retryFetch`
- Add `retryFetch` to `gemini-adapter.ts` for its single `fetch()` call

**Files:** `provider/retry-fetch.ts` (new), `openai-adapter.ts`, `gemini-adapter.ts`

---

### 3. Max output token defaults for OpenAI and Gemini

**Problem:** OpenAI and Gemini only cap output tokens when `options.maxTokens` is explicitly passed. Without defaults, requests use the provider's maximum, wasting tokens on simple tasks and risking unexpectedly large outputs.

**Design:**
- Add `MODEL_MAX_OUTPUT` maps to `openai-adapter.ts` and `gemini-adapter.ts`
- OpenAI defaults: `gpt-5.4` → 32768, `gpt-5.4-mini` → 16384, `gpt-5.4-nano` → 8192, `gpt-5` → 32768, `gpt-5-mini` → 16384, `gpt-5-nano` → 8192; unknown models → 16384
- Gemini defaults: `gemini-2.5-pro` → 65536, `gemini-2.5-flash` → 32768, `gemini-2.5-flash-lite` → 16384; unknown models → 16384
- Lookup uses prefix matching so minor version suffixes (e.g. `-preview`, `-20251001`) don't silently fall through to the unknown-model fallback. Extract `lookupModelMaxOutput(model: string, map: Record<string, number>, fallback: number): number` as a shared helper in `provider/types.ts` — both `openai-adapter.ts` and `gemini-adapter.ts` use it to avoid duplicating the same `Object.entries().find()` expression.
- Applied as: `options.maxTokens ?? lookupModelMaxOutput(this.model, MODEL_MAX_OUTPUT, fallback)`
- Log the resolved `max_tokens` in the completion log line matching Anthropic's format

**Files:** `openai-adapter.ts`, `gemini-adapter.ts`

---

### 4. Surface reasoning/thinking for OpenAI and Gemini

**Problem:** OpenAI and Gemini 2.5 both produce reasoning/thinking output that is not forwarded to the `onThinking` callback the loop and UI already handle.

**Delivery path:** The `chat()` method signature already accepts `onText` as a parameter; `onThinking` will be added to `ChatOptions` so it flows into the adapter without changing the `ProviderClient` interface shape. Alternatively, a `thinkingText` field is added to `LLMResponse` and the loop calls `onThinking` after receiving the response — this approach keeps adapters stateless. **Decision: use `LLMResponse.thinkingText?: string`** — simpler, no interface change to `ProviderClient`, and reasoning is always complete before the response returns anyway.

**OpenAI:**
- The Chat Completions streaming API does not stream reasoning content in delta chunks — `delta.type === 'reasoning'` does not exist on this endpoint
- Instead, after the stream completes, read `usage.completion_tokens_details?.reasoning_tokens` as a count signal
- If reasoning tokens > 0, set `thinkingText` to a summary string like `"[Reasoning: ~N tokens]"` (the actual text is not available via Chat Completions streaming)
- The `OpenAIStreamingChunk` interface's `usage` field must be extended in a **single edit** to add both `completion_tokens_details?: { reasoning_tokens?: number }` (Change 4) and `prompt_tokens_details?: { cached_tokens?: number }` (Change 6) — these are co-located in the same interface and must be added together to avoid partial-state TypeScript compilation errors.

**Gemini:**
- After the SSE stream completes, check `usageMetadata.thoughtSummary` (present on 2.5 Pro/Flash when thinking was used)
- If present and non-empty, set `thinkingText` to the summary string
- Also handle inline `thought: true` parts during streaming: accumulate `part.text` from parts where `part.thought === true` and set `thinkingText` to the accumulated thought text
- **Critically:** parts where `part.thought === true` must be excluded from the main `text` accumulator and `onText` callback — if not excluded, thought content will appear in both the response text and in `thinkingText`
- Extend `GeminiResponseChunk.usageMetadata` to include `thoughtSummary?: string`
- Extend `GeminiPart` to include `thought?: boolean`

**Loop:**
- After each `client.chat()` call, if `response.thinkingText` is present, call `onThinking?.(response.thinkingText)`
- `onThinking?.('')` is called at the end of each iteration as before (clears the thinking indicator in the UI)

**Files:** `provider/types.ts` (add `thinkingText` to `LLMResponse`), `openai-adapter.ts`, `gemini-adapter.ts`, `loop.ts` (two lines: read `thinkingText`, call `onThinking`)

---

### 5. Enable `supportsHarnessGeneration` for OpenAI

**Problem:** CLI-Anything harness generation is silently skipped for OpenAI with a provider warning. The pipeline uses `client.chat()` which is provider-agnostic.

**Design:**
- Set `supportsHarnessGeneration = true` on `OpenAIProviderClient`
- The warning branch in `loop-setup.ts` checks `!client.supportsHarnessGeneration` (a capability flag). Because we are setting the flag to `true` on OpenAI, the warning will no longer fire for OpenAI automatically — no code change to `loop-setup.ts` is needed. The flag remains the correct mechanism; do not replace it with a hardcoded provider identity check.
- Gemini remains `false` — its function call format differences make harness validation less reliable until explicitly tested

**Files:** `openai-adapter.ts` (flag change only; `loop-setup.ts` requires no change)

---

### 6. Log OpenAI prompt cache hits

**Problem:** OpenAI automatic prefix caching works silently. Cache hits are in `usage.prompt_tokens_details.cached_tokens` but not logged or surfaced in `LLMResponse.usage`.

**Design:**
- In `openai-adapter.ts`, after the stream completes, read `usage.prompt_tokens_details?.cached_tokens` from the final usage chunk
- Store as `cacheReadTokens` in the returned `LLMResponse.usage` (field already exists, currently hardcoded to 0)
- Extend `OpenAIStreamingChunk` to include `prompt_tokens_details?: { cached_tokens?: number }` within `usage`
- Add the same log line format as Anthropic: `[LLM] model | in=X cache_read=Y out=Z | cache_hit=N% | max_tokens=M | stop=reason`

**Files:** `openai-adapter.ts`

---

## Data Flow

All changes are contained within the provider adapters and `types.ts`, plus two small additions to `loop.ts` (one guard fix, two lines for `thinkingText`).

```
LLM API  →  [adapter: normalize stopReason, apply max_tokens default,
              retry on error, surface thinking in LLMResponse,
              log cache hits]
         →  LLMResponse (same shape + thinkingText field)
         →  loop.ts: read thinkingText → onThinking, fix tool_use guard
```

---

## Error Handling

- `retryFetch`: respects `AbortSignal` via `Promise.race` during delays — abort fires immediately, not after the full backoff window
- `normalizeStopReason`: unknown values pass through as-is — no throw, no silent loss
- `thinkingText`: best-effort — if the field is absent or empty, `onThinking` is not called and the response proceeds normally

---

## Testing

- `retry-fetch.ts`: unit tests for retry count, backoff delay calculation, `Retry-After` header respect, signal cancellation during delay (must fire immediately, not after delay)
- `normalizeStopReason`: unit tests for each provider's raw values → canonical values, including Gemini's post-lowercase `"function_calls"`, plus unknown passthrough
- `openai-adapter.ts`: extend existing tests to cover cache hit logging, `cacheReadTokens` in response, and `thinkingText` set when `reasoning_tokens > 0`
- `gemini-adapter.ts`: extend existing tests to cover retry logic, `thoughtSummary` forwarded as `thinkingText`, inline `thought: true` parts accumulated
- `loop.ts` guard: update existing OpenAI stop-reason tests to assert against `'tool_use'` (canonical) not `'tool_calls'`
- `loop.ts` thinking: test that when `response.thinkingText` is present, `onThinking` is called with that value after `client.chat()` returns
- All existing provider tests must continue to pass

---

## Out of Scope

- Image tool result improvements for OpenAI/Gemini (requires provider API changes)
- Gemini `supportsHarnessGeneration` (requires validation)
- Anthropic additional cache breakpoints (separate optimization)
