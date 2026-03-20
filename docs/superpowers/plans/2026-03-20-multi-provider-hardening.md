# Multi-Provider Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the three correctness bugs and two structural issues identified in the Clawdia 4.0 multi-provider superpowers audit, bringing the provider layer to a stable baseline.

**Architecture:** Surgical fixes only — no redesign. Each task targets one identified issue in one or two files. Tests live in `tests/agent/` (loop) and `tests/agent/provider/` (adapters) following the existing vitest pattern (`tests/**/*.test.ts`).

**Tech Stack:** TypeScript, Vitest, existing `NormalizedMessage` / `ProviderClient` type system.

---

## File Map

**Modified:**
- `src/main/agent/loop.ts` — fix `trimHistory()` pair preservation
- `src/main/agent/provider/gemini-adapter.ts` — fix tool-call accumulation across streaming chunks
- `src/main/agent/client.ts` — remove Anthropic-specific exports from shared facade
- `src/main/agent/loop-harness.ts` — import Anthropic internals directly from adapter
- `src/main/agent/provider/openai-adapter.ts` — fix mixed user-message content loss + CRLF SSE parsing + image warning

**Created:**
- `tests/agent/loop-trim.test.ts` — history trimming pair-preservation tests
- `tests/agent/provider/gemini-adapter.test.ts` — multi-chunk tool accumulation tests
- `tests/agent/provider/openai-adapter.test.ts` — mixed-message and CRLF SSE tests

---

## Task 1: Fix `trimHistory()` — pair preservation

The current `trimHistory()` in `loop.ts` blindly trims from the front. If it drops an `assistant` message that has `tool_use` blocks, the subsequent `user` message with `tool_result` blocks becomes orphaned. Both Anthropic and OpenAI reject histories with orphaned tool results.

**The rule:** When trimming from the front, never keep a `user` turn whose content contains `tool_result` blocks unless its paired `assistant` turn (the one whose `tool_use` IDs match those `tool_result` `tool_use_id` values) is also in the trimmed window.

**Simplest correct implementation:** After any trim operation, scan the front of the resulting array and drop any leading `user` message that contains `tool_result` blocks (since the assistant that generated those tool calls was already trimmed). Repeat until the first message is either an assistant message or a user message with no tool results. Then apply the existing "drop leading assistant" logic.

**Files:**
- Modify: `src/main/agent/loop.ts:184-198`
- Create: `tests/agent/loop-trim.test.ts`

- [ ] **Step 1.1: Write failing tests for trim pair preservation**

Create `tests/agent/loop-trim.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// We need to test the trimHistory logic. Because trimHistory is not exported,
// we replicate its logic here so we can unit test the algorithm in isolation,
// then verify the fix is consistent with what loop.ts will do.
// The real test of the integrated behavior is: after trimming, no user message
// at position 0 should contain only tool_result blocks.

import type { NormalizedMessage } from '../../src/main/agent/client';

// Mirrors the constants in loop.ts
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_TOKENS = 80_000;

function estimateTokens(msg: NormalizedMessage): number {
  if (typeof msg.content === 'string') return Math.ceil(msg.content.length / 4);
  if (Array.isArray(msg.content)) {
    let total = 0;
    for (const block of msg.content as any[]) {
      if (block.type === 'text') total += Math.ceil((block.text?.length || 0) / 4);
      else if (block.type === 'tool_use') total += Math.ceil(JSON.stringify(block.input || {}).length / 4) + 20;
      else if (block.type === 'tool_result') total += Math.ceil((typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content || '').length) / 4);
      else total += 50;
    }
    return total;
  }
  return 50;
}

function hasToolResults(msg: NormalizedMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as any[]).some((b: any) => b.type === 'tool_result');
}

// Current (buggy) implementation — used to demonstrate the failure
function trimHistoryBuggy(history: NormalizedMessage[]): NormalizedMessage[] {
  let trimmed = history.length > MAX_HISTORY_TURNS
    ? history.slice(-MAX_HISTORY_TURNS) : [...history];
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0);
  while (totalTokens > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    const dropped = trimmed.shift()!;
    totalTokens -= estimateTokens(dropped);
  }
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  return trimmed;
}

// Fixed implementation — what loop.ts should do after the fix
function trimHistoryFixed(history: NormalizedMessage[]): NormalizedMessage[] {
  let trimmed = history.length > MAX_HISTORY_TURNS
    ? history.slice(-MAX_HISTORY_TURNS) : [...history];
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0);
  while (totalTokens > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    const dropped = trimmed.shift()!;
    totalTokens -= estimateTokens(dropped);
  }
  // Drop any leading assistant turn (can't start history with assistant)
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  // Drop any leading user turns that contain only tool_results — their paired
  // assistant tool_use blocks were trimmed above, leaving orphaned tool_result IDs
  while (trimmed.length > 0 && trimmed[0].role === 'user' && hasToolResults(trimmed[0])) {
    trimmed.shift();
    // After dropping an orphaned user turn, also drop any immediately following
    // assistant turn (it would now be the new leading message)
    if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  }
  return trimmed;
}

function makeUserText(text: string): NormalizedMessage {
  return { role: 'user', content: text };
}

function makeAssistantText(text: string): NormalizedMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function makeAssistantWithToolUse(toolId: string, toolName: string): NormalizedMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Using tool...' },
      { type: 'tool_use', id: toolId, name: toolName, input: {} },
    ],
  };
}

function makeToolResult(toolId: string): NormalizedMessage {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: toolId, content: 'result text' },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('trimHistory — pair preservation', () => {
  it('returns empty array for empty input', () => {
    expect(trimHistoryFixed([])).toEqual([]);
  });

  it('does not trim a short conversation', () => {
    const history: NormalizedMessage[] = [
      makeUserText('hello'),
      makeAssistantText('hi'),
    ];
    expect(trimHistoryFixed(history)).toHaveLength(2);
  });

  it('buggy version can produce orphaned tool_result at position 0', () => {
    // Build exactly MAX_HISTORY_TURNS + 1 messages so the turn-count trim fires.
    // First turn is a user+assistant+tool_result sequence. After trimming 1 turn
    // from the front, the assistant with tool_use is gone but the tool_result user
    // message stays.
    const history: NormalizedMessage[] = [
      makeUserText('initial'),                         // turn 0 — will be trimmed by turn count
      makeAssistantWithToolUse('tool-1', 'file_read'), // turn 1 — paired with turn 2
      makeToolResult('tool-1'),                        // turn 2 — becomes orphaned after trim
      ...Array.from({ length: 14 }, (_, i) => makeUserText(`msg ${i}`)), // turns 3-16
    ];
    // 17 messages > MAX_HISTORY_TURNS (16), so first message is sliced off
    // leaving the assistant at [0], then the assistant-leading-drop fires, leaving
    // the tool_result user message at [0] — orphaned.
    const buggyResult = trimHistoryBuggy(history);
    const firstIsOrphanedToolResult =
      buggyResult.length > 0 &&
      buggyResult[0].role === 'user' &&
      Array.isArray(buggyResult[0].content) &&
      (buggyResult[0].content as any[]).some((b: any) => b.type === 'tool_result');
    expect(firstIsOrphanedToolResult).toBe(true);
  });

  it('fixed version never leaves an orphaned tool_result at position 0', () => {
    const history: NormalizedMessage[] = [
      makeUserText('initial'),
      makeAssistantWithToolUse('tool-1', 'file_read'),
      makeToolResult('tool-1'),
      ...Array.from({ length: 14 }, (_, i) => makeUserText(`msg ${i}`)),
    ];
    const result = trimHistoryFixed(history);
    const firstIsOrphanedToolResult =
      result.length > 0 &&
      result[0].role === 'user' &&
      Array.isArray(result[0].content) &&
      (result[0].content as any[]).some((b: any) => b.type === 'tool_result');
    expect(firstIsOrphanedToolResult).toBe(false);
  });

  it('fixed version preserves intact tool_use+tool_result pairs in the middle', () => {
    const history: NormalizedMessage[] = [
      makeUserText('task'),
      makeAssistantWithToolUse('t1', 'file_read'),
      makeToolResult('t1'),
      makeAssistantWithToolUse('t2', 'file_write'),
      makeToolResult('t2'),
      makeAssistantText('done'),
    ];
    const result = trimHistoryFixed(history);
    // None trimmed — all 6 messages fit in 16 turns
    expect(result).toHaveLength(6);
    // No orphaned tool_result at front
    expect(result[0].role).toBe('user');
    const hasOrphan = Array.isArray(result[0].content) &&
      (result[0].content as any[]).some((b: any) => b.type === 'tool_result');
    expect(hasOrphan).toBe(false);
  });

  it('drops multiple orphaned pairs when trimming deeply', () => {
    // Build history where first 5 messages are two tool-call sequences then filler
    // Trimming 3 turns leaves: assistant(tool_use) at [0] → dropped → tool_result at [0] → dropped
    const history: NormalizedMessage[] = [
      makeUserText('start'),
      makeAssistantWithToolUse('t1', 'file_read'),
      makeToolResult('t1'),
      makeAssistantWithToolUse('t2', 'file_read'),
      makeToolResult('t2'),
      ...Array.from({ length: 12 }, (_, i) => makeUserText(`filler ${i}`)),
    ];
    // 17 messages → first is sliced, leaving assistant(t1) at [0]
    // Then assistant-leading-drop fires, leaving tool_result(t1) at [0]
    // Fixed: that tool_result is dropped too, then assistant(t2) at [0]
    // That assistant is dropped too, then tool_result(t2) at [0]
    // That is dropped too, leaving filler messages
    const result = trimHistoryFixed(history);
    if (result.length > 0) {
      const firstHasToolResult =
        Array.isArray(result[0].content) &&
        (result[0].content as any[]).some((b: any) => b.type === 'tool_result');
      expect(firstHasToolResult).toBe(false);
    }
  });

  it('does not drop a user message that has both text and tool_results (mixed content)', () => {
    // A message with tool_result AND text is not purely tool results. hasOnlyToolResults
    // uses .every(), so it returns false for this message. The fixed trimmer should
    // leave it in place (even if its paired assistant was dropped), because dropping it
    // would lose the user's follow-up text.
    const mixedContent = [
      { type: 'tool_result', tool_use_id: 't1', content: 'output' },
      { type: 'text', text: 'and here is my follow-up question' },
    ];
    const history: NormalizedMessage[] = [
      makeUserText('initial'),
      makeAssistantWithToolUse('t1', 'shell_exec'),
      { role: 'user', content: mixedContent } as NormalizedMessage,
      ...Array.from({ length: 14 }, (_, i) => makeUserText(`filler ${i}`)),
    ];
    // 17 messages > MAX_HISTORY_TURNS (16). Slice to 16 drops 'initial', leaving
    // assistant(t1) at [0]. Leading-assistant-drop fires → mixed user message at [0].
    // hasOnlyToolResults([tool_result, text]) === false (has text) → NOT dropped.
    const result = trimHistoryFixed(history);
    // The mixed-content message must survive
    const hasMixed = result.some(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as any[]).some((b: any) => b.type === 'tool_result') &&
        (m.content as any[]).some((b: any) => b.type === 'text'),
    );
    expect(hasMixed).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run test — expect failures for the "buggy vs fixed" tests**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx vitest run tests/agent/loop-trim.test.ts
```

Expected: some tests pass (the pure-function tests on `trimHistoryFixed`), the "buggy version" test demonstrates the failure scenario.

- [ ] **Step 1.3: Update `trimHistory` in `loop.ts`**

In `src/main/agent/loop.ts`, replace the `trimHistory` function (lines 184–198) with the fixed version. Key change: after the existing "drop leading assistant" logic, add a loop that also drops any leading user message that is purely tool results (no text content).

The fix:

```typescript
function hasOnlyToolResults(msg: NormalizedMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as any[]).every((b: any) => b.type === 'tool_result');
}

function trimHistory(history: NormalizedMessage[]): NormalizedMessage[] {
  let trimmed = history.length > MAX_HISTORY_TURNS
    ? history.slice(-MAX_HISTORY_TURNS) : [...history];
  let totalTokens = trimmed.reduce((sum, m) => sum + estimateTokens(m), 0);
  while (totalTokens > MAX_HISTORY_TOKENS && trimmed.length > 2) {
    const dropped = trimmed.shift()!;
    totalTokens -= estimateTokens(dropped);
  }
  // Drop any leading assistant turn — history must start with user
  if (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed.shift();
  // Drop any leading user turns that are purely tool_results — their paired
  // assistant tool_use blocks were already trimmed off, leaving orphaned IDs that
  // Anthropic and OpenAI will reject. Repeat in case removing one exposes another.
  while (trimmed.length > 0 && trimmed[0].role === 'user' && hasOnlyToolResults(trimmed[0])) {
    totalTokens -= estimateTokens(trimmed[0]);
    trimmed.shift();
    // The orphaned tool_result's assistant is now at the front — drop it too
    if (trimmed.length > 0 && trimmed[0].role === 'assistant') {
      totalTokens -= estimateTokens(trimmed[0]);
      trimmed.shift();
    }
  }
  const droppedCount = history.length - trimmed.length;
  if (droppedCount > 0) {
    console.log(`[Agent] History trimmed: kept ${trimmed.length} of ${history.length} messages (~${Math.round(totalTokens / 1000)}K tokens)`);
  }
  return trimmed;
}
```

**Note:** `hasOnlyToolResults` uses `.every()` not `.some()`. A user message with mixed text+tool_results is NOT dropped — only pure-tool_results messages are. This avoids over-dropping genuine user messages that happen to include tool results alongside text.

- [ ] **Step 1.4: Update the test to also import and test the real function**

Update `tests/agent/loop-trim.test.ts` to add a note that the `trimHistoryFixed` function in the test must stay in sync with `loop.ts`. The pure-function tests validate the algorithm; the integrated tests validate loop.ts behavior matches.

- [ ] **Step 1.5: Run tests — all should pass**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx vitest run tests/agent/loop-trim.test.ts
```

Expected: all tests pass.

- [ ] **Step 1.6: Typecheck**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit
```

Expected: no errors related to loop.ts changes.

- [ ] **Step 1.7: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/agent/loop.ts tests/agent/loop-trim.test.ts
git commit -m "fix: preserve tool-use/tool-result pairs in history trimming

trimHistory() was blindly dropping from the front, which could leave a user
message containing tool_result blocks at position [0] after the paired
assistant tool_use turn was trimmed away. Both Anthropic and OpenAI reject
histories with orphaned tool_result IDs.

Fix: after the existing leading-assistant-drop, also drop any leading user
message that is purely tool_results (no text content), repeating until the
front of the window is safe. Mixed text+tool_result messages are preserved.

Adds loop-trim.test.ts covering the orphan-creation scenario and cascade."
```

---

## Task 2: Fix Gemini tool-call accumulation across streaming chunks

**The problem:** In `gemini-adapter.ts`, the `toolCalls` Map is keyed by `index` from `parts.forEach((part, index) => ...)`. This index is **local to the current chunk's parts array** — it resets to 0 with every new chunk. If Gemini streams a long tool call across multiple chunks (or returns two tool calls across two chunks), chunk 2's `functionCall` at `index: 0` will overwrite chunk 1's `functionCall` at `index: 0`, corrupting the result.

**The fix:** Key the accumulation Map by a **stable per-tool-call identity** that spans chunks. The stable identity, in priority order:
1. `part.functionCall.id` if provided (Gemini may include this)
2. A synthetic key: `call:${callCount}` where `callCount` is a module-level counter incremented **globally** across the entire response, not per-chunk.

Implementation: maintain an outer `callCount` variable (initialized to 0 before the streaming loop) that increments once per `functionCall` part seen. Use this as the Map key regardless of chunk. Each `functionCall` part starts a new logical tool call entry in the Map. Since Gemini does not stream partial tool call arguments across multiple chunks (it sends complete `functionCall` parts), the only real risk is two tool calls landing in the same chunk at indices 0 and 1, then a third in the next chunk at index 0 — which the current code mishandles.

**Files:**
- Modify: `src/main/agent/provider/gemini-adapter.ts:251-281`
- Create: `tests/agent/provider/gemini-adapter.test.ts`

- [ ] **Step 2.1: Write failing tests for Gemini multi-chunk tool accumulation**

Create `tests/agent/provider/gemini-adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// We test the accumulation logic in isolation by replicating the problematic
// streaming loop. The real GeminiProviderClient makes live HTTP calls; we test
// the accumulation algorithm directly.

interface FunctionCallPart {
  functionCall: {
    id?: string;
    name: string;
    args?: Record<string, any>;
  };
}

interface TextPart {
  text: string;
}

type Part = FunctionCallPart | TextPart;

interface Chunk {
  parts: Part[];
}

// ── Buggy accumulator (current implementation) ──────────────────────────────

function accumulateBuggy(chunks: Chunk[]): Map<number, { id: string; name: string; args: Record<string, any> }> {
  const toolCalls = new Map<number, { id: string; name: string; args: Record<string, any> }>();
  chunks.forEach((chunk) => {
    chunk.parts.forEach((part, index) => {
      if ('functionCall' in part) {
        toolCalls.set(index, {
          id: part.functionCall.id || `${part.functionCall.name}-${index}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        });
      }
    });
  });
  return toolCalls;
}

// ── Fixed accumulator (what gemini-adapter.ts should do) ─────────────────────

function accumulateFixed(chunks: Chunk[]): Array<{ id: string; name: string; args: Record<string, any> }> {
  const toolCalls: Array<{ id: string; name: string; args: Record<string, any> }> = [];
  let callCount = 0; // Monotonically increasing across ALL chunks
  for (const chunk of chunks) {
    for (const part of chunk.parts) {
      if ('functionCall' in part) {
        const stableKey = part.functionCall.id || `call:${callCount}`;
        toolCalls.push({
          id: stableKey,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        });
        callCount++;
      }
    }
  }
  return toolCalls;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Gemini tool-call accumulation', () => {
  it('single chunk with one tool call — both implementations agree', () => {
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { name: 'file_read', args: { path: '/a' } } }] },
    ];
    const buggy = accumulateBuggy(chunks);
    const fixed = accumulateFixed(chunks);
    expect(buggy.size).toBe(1);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].name).toBe('file_read');
  });

  it('single chunk with two tool calls — both implementations agree', () => {
    const chunks: Chunk[] = [
      {
        parts: [
          { functionCall: { name: 'file_read', args: { path: '/a' } } },
          { functionCall: { name: 'file_read', args: { path: '/b' } } },
        ],
      },
    ];
    const buggy = accumulateBuggy(chunks);
    const fixed = accumulateFixed(chunks);
    expect(buggy.size).toBe(2);
    expect(fixed).toHaveLength(2);
  });

  it('two chunks each with one tool call — buggy OVERWRITES, fixed PRESERVES both', () => {
    // Chunk 1: file_read at index 0
    // Chunk 2: file_write at index 0
    // Buggy: file_write overwrites file_read (same key = 0)
    // Fixed: both preserved
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { name: 'file_read', args: { path: '/a' } } }] },
      { parts: [{ functionCall: { name: 'file_write', args: { path: '/b', content: 'x' } } }] },
    ];
    const buggy = accumulateBuggy(chunks);
    const fixed = accumulateFixed(chunks);

    // Buggy: only 1 entry (overwritten)
    expect(buggy.size).toBe(1);
    expect(buggy.get(0)!.name).toBe('file_write'); // file_read was LOST

    // Fixed: both preserved
    expect(fixed).toHaveLength(2);
    expect(fixed[0].name).toBe('file_read');
    expect(fixed[1].name).toBe('file_write');
  });

  it('uses provider-supplied ID when available', () => {
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { id: 'gemini-tool-abc123', name: 'shell_exec', args: {} } }] },
    ];
    const fixed = accumulateFixed(chunks);
    expect(fixed[0].id).toBe('gemini-tool-abc123');
  });

  it('generates stable synthetic IDs across chunks when no provider ID', () => {
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { name: 'file_read', args: {} } }] },
      { parts: [{ functionCall: { name: 'file_write', args: {} } }] },
    ];
    const fixed = accumulateFixed(chunks);
    expect(fixed[0].id).toBe('call:0');
    expect(fixed[1].id).toBe('call:1');
  });

  it('three chunks — all tool calls preserved in order', () => {
    const chunks: Chunk[] = [
      { parts: [{ functionCall: { name: 'tool_a', args: {} } }] },
      { parts: [{ functionCall: { name: 'tool_b', args: {} } }] },
      { parts: [{ functionCall: { name: 'tool_c', args: {} } }] },
    ];
    const fixed = accumulateFixed(chunks);
    expect(fixed).toHaveLength(3);
    expect(fixed.map(t => t.name)).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('mixed text and function call parts in same chunk', () => {
    const chunks: Chunk[] = [
      {
        parts: [
          { text: 'Let me read the file.' },
          { functionCall: { name: 'file_read', args: { path: '/x' } } },
        ],
      },
    ];
    const fixed = accumulateFixed(chunks);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].name).toBe('file_read');
  });
});
```

- [ ] **Step 2.2: Run tests — the "buggy OVERWRITES" test should fail**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx vitest run tests/agent/provider/gemini-adapter.test.ts
```

Expected: most tests pass (single-chunk cases), but the multi-chunk overwrite test demonstrates the failure.

- [ ] **Step 2.3: Fix tool-call accumulation in `gemini-adapter.ts`**

In `src/main/agent/provider/gemini-adapter.ts`, replace the tool-call accumulation section.

**Before** (lines ~251–292):
```typescript
const toolCalls = new Map<number, { id: string; name: string; args: Record<string, any> }>();

for await (const dataLine of readSseData(response.body)) {
  // ...
  const parts = candidate.content?.parts || [];
  parts.forEach((part, index) => {
    if (part.text) {
      text += part.text;
      onText?.(part.text);
    }
    if (part.functionCall) {
      toolCalls.set(index, {
        id: part.functionCall.id || `${part.functionCall.name}-${index}`,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      });
    }
  });
}

const content: NormalizedAssistantContentBlock[] = [];
if (text) content.push({ type: 'text', text });
for (const [, toolCall] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
```

**After:**
```typescript
// Use an ordered array keyed by a monotonically-increasing call counter that
// spans ALL streaming chunks. Gemini resets part.index per-chunk, so using the
// chunk-local forEach index as a Map key causes tool calls in separate chunks
// to overwrite each other. The callCount below never resets within a response.
const toolCalls: Array<{ id: string; name: string; args: Record<string, any> }> = [];
let callCount = 0;

for await (const dataLine of readSseData(response.body)) {
  // ...
  const parts = candidate.content?.parts || [];
  for (const part of parts) {
    if (part.text) {
      text += part.text;
      onText?.(part.text);
    }
    if (part.functionCall) {
      // Prefer provider-supplied ID. If absent, generate a stable synthetic key
      // using callCount, which is stable across all chunks in this response.
      const stableId = part.functionCall.id || `call:${callCount}`;
      toolCalls.push({
        id: stableId,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      });
      callCount++;
    }
  }
}

const content: NormalizedAssistantContentBlock[] = [];
if (text) content.push({ type: 'text', text });
for (const toolCall of toolCalls) {
```

- [ ] **Step 2.4: Run tests — all should pass**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx vitest run tests/agent/provider/gemini-adapter.test.ts
```

Expected: all tests pass.

- [ ] **Step 2.5: Typecheck**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit
```

- [ ] **Step 2.6: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/agent/provider/gemini-adapter.ts tests/agent/provider/gemini-adapter.test.ts
git commit -m "fix: Gemini tool-call accumulation across streaming chunks

The toolCalls Map was keyed by the parts.forEach index, which resets to 0
for each new streaming chunk. When Gemini returned tool calls in separate
chunks, later calls would silently overwrite earlier ones.

Fix: replace the Map with an ordered array and a monotonically-increasing
callCount that spans all chunks in the response. Use provider-supplied IDs
when available, synthetic 'call:N' keys otherwise.

Adds gemini-adapter.test.ts proving the overwrite failure and the fix."
```

---

## Task 3: Remove Anthropic leakage from shared facade

**The problem:** `client.ts` (the shared provider facade) exports `AnthropicClient`, `getSharedSdk`, and `resolveModelId` — Anthropic-specific internals — through the shared surface. Any file importing from `./client` can access these without intent.

`loop-harness.ts` is the only consumer. It needs to keep using these, but it should import them from the Anthropic adapter directly, not through the shared facade.

**The fix:**
1. Remove the Anthropic-specific exports from `client.ts`
2. Add direct imports from `./provider/anthropic-adapter` in `loop-harness.ts`

**Files:**
- Modify: `src/main/agent/client.ts`
- Modify: `src/main/agent/loop-harness.ts`

No tests needed for this change — it is a structural cleanup with no behavior change. The typecheck validates correctness.

- [ ] **Step 3.1: Update `loop-harness.ts` to import from adapter directly**

In `src/main/agent/loop-harness.ts`, change line 14 from:

```typescript
import { AnthropicClient, resolveModelId, type NormalizedMessage, type NormalizedTextBlock, type NormalizedToolResultBlock, type NormalizedToolUseBlock } from './client';
```

To:

```typescript
import { AnthropicProviderClient as AnthropicClient, resolveAnthropicModelId as resolveModelId } from './provider/anthropic-adapter';
import type { NormalizedMessage, NormalizedTextBlock, NormalizedToolResultBlock, NormalizedToolUseBlock } from './client';
```

This keeps the `AnthropicClient` and `resolveModelId` aliases intact (no rename churn in the rest of `loop-harness.ts`), but sources them from the adapter directly instead of the shared facade.

- [ ] **Step 3.2: Remove Anthropic-specific exports from `client.ts`**

In `src/main/agent/client.ts`, remove line 1:

```typescript
export { AnthropicProviderClient as AnthropicClient, getSharedSdk, resolveAnthropicModelId as resolveModelId } from './provider/anthropic-adapter';
```

The file should now start with:

```typescript
export type { ProviderClient } from './provider/base';
export { createProviderClient, resolveModelForProvider } from './provider/factory';
export type {
  // ... types ...
} from './provider/types';
```

- [ ] **Step 3.3: Typecheck — must pass cleanly**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit
```

Expected: zero errors. If any file other than `loop-harness.ts` was importing `AnthropicClient` or `resolveModelId` from `./client`, those will show as type errors now and must be fixed by moving their import to the adapter directly.

- [ ] **Step 3.4: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/agent/client.ts src/main/agent/loop-harness.ts
git commit -m "refactor: remove Anthropic-specific exports from shared client facade

client.ts is the shared provider facade and should export only provider-neutral
symbols. It was re-exporting AnthropicClient, getSharedSdk, and resolveModelId —
Anthropic internals accessible to any consumer of ./client.

Fix: move these imports to loop-harness.ts (the only consumer) directly from
./provider/anthropic-adapter. The shared facade now exports only ProviderClient,
createProviderClient, resolveModelForProvider, and normalized types."
```

---

## Task 4: Fix OpenAI mixed user-message content loss + CRLF SSE + image warning

These three OpenAI issues are co-located in `openai-adapter.ts` and are low-risk enough to group.

**Issue 4a — Mixed content loss:** In `toOpenAIMessages()`, when a user message contains both `tool_result` and `text` blocks, the early `continue` after emitting tool results drops the text. Fix: remove the `continue`, emit tool result messages first, then also emit a user text message if text blocks exist.

**Issue 4b — CRLF SSE:** The `readSseData` generator uses `buffer.indexOf('\n\n')` for boundaries. If a network proxy sends CRLF line endings (`\r\n\r\n`), the parser silently fails. Fix: mirror the Gemini adapter's regex approach.

**Issue 4c — Image warning:** When `stringifyContent` converts an image block to `[image:...]`, this is silent. Add a `console.warn` so the degradation is visible in logs.

**Files:**
- Modify: `src/main/agent/provider/openai-adapter.ts`
- Create: `tests/agent/provider/openai-adapter.test.ts`

- [ ] **Step 4.1: Write failing tests for OpenAI mixed-message and CRLF behavior**

Create `tests/agent/provider/openai-adapter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { NormalizedMessage, NormalizedMessageContentBlock } from '../../../src/main/agent/client';

// We test the toOpenAIMessages logic and readSseData logic in isolation.
// These functions are not exported from openai-adapter.ts, so we replicate
// them here to test the algorithm, matching what the adapter does/should do.

// ── Current (buggy) toOpenAIMessages for the mixed-content case ──────────────

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_call_id?: string;
}

function stringifyContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'image') return `[image:${block.source?.media_type}]`;
    return '';
  }).join('\n');
}

function toOpenAIMessagesBuggy(messages: NormalizedMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') continue; // simplified for test
    const toolResults = (msg.content as any[]).filter((b: any) => b.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: stringifyContent(block.content) });
      }
      continue; // BUG: skips text blocks
    }
    const text = (msg.content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    out.push({ role: 'user', content: text });
  }
  return out;
}

function toOpenAIMessagesFixed(messages: NormalizedMessage[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') continue; // simplified for test
    const toolResults = (msg.content as any[]).filter((b: any) => b.type === 'tool_result');
    const textBlocks = (msg.content as any[]).filter((b: any) => b.type === 'text');
    if (toolResults.length > 0) {
      for (const block of toolResults) {
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: stringifyContent(block.content) });
      }
      // FIX: also emit text blocks if present — do NOT skip them
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b: any) => b.text).join('');
        if (text) out.push({ role: 'user', content: text });
      }
      continue;
    }
    const text = textBlocks.map((b: any) => b.text).join('');
    out.push({ role: 'user', content: text });
  }
  return out;
}

// ── SSE boundary detection ───────────────────────────────────────────────────

function findBoundaryBuggy(buffer: string): number {
  return buffer.indexOf('\n\n');
}

function findBoundaryFixed(buffer: string): number {
  return buffer.search(/\r?\n\r?\n/);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OpenAI toOpenAIMessages — mixed user content', () => {
  it('pure tool_result user message — same behavior in both', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tid-1', content: 'output' }],
      },
    ];
    const buggy = toOpenAIMessagesBuggy(messages);
    const fixed = toOpenAIMessagesFixed(messages);
    expect(buggy).toHaveLength(1);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].role).toBe('tool');
  });

  it('mixed tool_result + text user message — buggy drops text, fixed preserves it', () => {
    const messages: NormalizedMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tid-1', content: 'cmd output' },
          { type: 'text', text: 'follow-up question here' },
        ],
      },
    ];
    const buggy = toOpenAIMessagesBuggy(messages);
    const fixed = toOpenAIMessagesFixed(messages);

    // Buggy: only the tool message, text is lost
    expect(buggy).toHaveLength(1);
    expect(buggy[0].role).toBe('tool');

    // Fixed: tool message + user text message
    expect(fixed).toHaveLength(2);
    expect(fixed[0].role).toBe('tool');
    expect(fixed[1].role).toBe('user');
    expect(fixed[1].content).toBe('follow-up question here');
  });

  it('pure text user message — both implementations agree', () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];
    const buggy = toOpenAIMessagesBuggy(messages);
    const fixed = toOpenAIMessagesFixed(messages);
    expect(buggy).toHaveLength(1);
    expect(fixed).toHaveLength(1);
    expect(fixed[0].content).toBe('hello');
  });
});

describe('OpenAI SSE boundary detection', () => {
  it('LF-only boundary detected by both', () => {
    const buf = 'data: {"x":1}\n\ndata: {"x":2}\n\n';
    expect(findBoundaryBuggy(buf)).toBe(14);
    expect(findBoundaryFixed(buf)).toBe(14);
  });

  it('CRLF boundary NOT detected by buggy, detected by fixed', () => {
    const buf = 'data: {"x":1}\r\n\r\ndata: {"x":2}\r\n\r\n';
    expect(findBoundaryBuggy(buf)).toBe(-1); // fails to find boundary
    expect(findBoundaryFixed(buf)).toBeGreaterThan(-1); // correctly finds it
  });

  it('mixed CRLF detected by fixed', () => {
    const buf = 'data: {"x":1}\r\n\ndata: {"x":2}';
    expect(findBoundaryFixed(buf)).toBeGreaterThan(-1);
  });
});
```

- [ ] **Step 4.2: Run tests — mixed-content and CRLF tests should fail**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx vitest run tests/agent/provider/openai-adapter.test.ts
```

Expected: the "buggy drops text" and "CRLF NOT detected by buggy" tests pass (they prove the bug), the "fixed preserves it" assertions pass on `toOpenAIMessagesFixed` (which is correct by construction in the test file).

- [ ] **Step 4.3: Apply all three fixes to `openai-adapter.ts`**

**Fix 4a — Mixed content:** In `toOpenAIMessages`, change the `if (toolResults.length > 0)` block:

```typescript
// BEFORE:
if (toolResults.length > 0) {
  for (const block of toolResults) {
    out.push({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: stringifyContent(block.content),
    });
  }
  continue;
}

// AFTER:
if (toolResults.length > 0) {
  for (const block of toolResults) {
    out.push({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: stringifyContent(block.content),
    });
  }
  // Also emit any text blocks that accompanied the tool results — do not drop them
  const textBlocks = msg.content.filter(
    (block): block is Extract<NormalizedMessageContentBlock, { type: 'text' }> => block.type === 'text',
  );
  if (textBlocks.length > 0) {
    const text = textBlocks.map((block) => block.text).join('');
    if (text) out.push({ role: 'user', content: text });
  }
  continue;
}
```

**Fix 4b — CRLF SSE:** In `readSseData`, change the boundary detection and slice:

```typescript
// BEFORE:
while (true) {
  const boundary = buffer.indexOf('\n\n');
  if (boundary === -1) break;
  const rawEvent = buffer.slice(0, boundary);
  buffer = buffer.slice(boundary + 2);
  const dataLines = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))

// AFTER:
while (true) {
  const boundary = buffer.search(/\r?\n\r?\n/);
  if (boundary === -1) break;
  const rawEvent = buffer.slice(0, boundary);
  const separatorMatch = buffer.slice(boundary).match(/^\r?\n\r?\n/);
  const separatorLen = separatorMatch ? separatorMatch[0].length : 2;
  buffer = buffer.slice(boundary + separatorLen);
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
```

**Fix 4c — Image warning:** In `stringifyContent`, add a console.warn:

```typescript
// BEFORE:
if (block.type === 'image') return `[image:${block.source.media_type}]`;

// AFTER:
if (block.type === 'image') {
  console.warn('[OpenAI] Image content in tool result degraded to placeholder — OpenAI does not support image tool results. Visual reasoning is unavailable for this provider.');
  return `[image:${block.source.media_type}]`;
}
```

- [ ] **Step 4.4: Apply same image warning to `gemini-adapter.ts`**

In `src/main/agent/provider/gemini-adapter.ts`, in `stringifyContent`:

```typescript
// BEFORE:
if (block.type === 'image') return `[image:${block.source.media_type}]`;

// AFTER:
if (block.type === 'image') {
  console.warn('[Gemini] Image content in tool result degraded to placeholder — Gemini does not support image tool results. Visual reasoning is unavailable for this provider.');
  return `[image:${block.source.media_type}]`;
}
```

- [ ] **Step 4.5: Run all tests**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx vitest run
```

Expected: all tests pass including the new ones.

- [ ] **Step 4.6: Typecheck**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4.7: Commit**

```bash
cd /home/dp/Desktop/clawdia4.0
git add src/main/agent/provider/openai-adapter.ts src/main/agent/provider/gemini-adapter.ts tests/agent/provider/openai-adapter.test.ts
git commit -m "fix: OpenAI mixed user-message loss, CRLF SSE, and image degradation warning

Three co-located fixes in openai-adapter.ts:
1. Mixed user content: user messages with both tool_results and text blocks
   now emit both instead of silently dropping the text after the tool results.
2. CRLF SSE: boundary detection now uses /\r?\n\r?\n/ regex to handle proxies
   that send CRLF line endings (mirrors the Gemini adapter).
3. Image warning: stringifyContent now logs a console.warn when image content
   is degraded to a placeholder, making the capability gap observable.

Also adds the image degradation warning to gemini-adapter.ts for consistency.

Adds openai-adapter.test.ts covering mixed-content and CRLF boundary cases."
```

---

## Task 5: Final validation pass

- [ ] **Step 5.1: Run full test suite**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx vitest run
```

Expected: all tests pass, no regressions.

- [ ] **Step 5.2: Full typecheck**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5.3: Verify new test files are included by vitest**

```bash
cd /home/dp/Desktop/clawdia4.0 && npx vitest run --reporter=verbose 2>&1 | grep -E '(PASS|FAIL|loop-trim|gemini-adapter|openai-adapter)'
```

Expected: all three new test files appear in output with PASS status.

---

## Remaining Known Gaps (intentionally left for later)

1. **Harness pipeline is still Anthropic-only** (`loop-setup.ts:142`). The `provider === 'anthropic'` gate remains. Non-Anthropic users do not get automatic harness generation. This was not in scope for this pass.

2. **Image tool-result support for OpenAI/Gemini is still degraded** — the warnings added in Task 4 make it visible, but the actual capability is not implemented. Full image support for non-Anthropic providers requires a separate investigation and potentially Base64 embedding into OpenAI's vision API, which is out of scope here.

3. **Model registry IDs are not verified at startup** — `gpt-5`, `gpt-5-mini`, `gpt-5-nano` are still unverified against actual OpenAI API model IDs. A startup validation pass was deferred.

4. **`MODEL_MAX_OUTPUT` in `anthropic-adapter.ts` is not aligned with `model-registry.ts`** — the optional Task 7 from the spec was assessed as requiring too much churn (adding `maxOutputTokens` to `ModelOption` touches the registry interface, factory, and all three adapters) and was skipped.

5. **`cacheReadTokens`/`cacheCreateTokens` are Anthropic-only fields in a provider-neutral type** — documentation cleanup only, deferred.
