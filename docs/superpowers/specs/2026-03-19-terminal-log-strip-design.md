# Terminal Log Strip + Message Flow Fix Design

**Date:** 2026-03-19
**Status:** Approved

---

## Overview

Three related problems with the current chat UI during agent execution, addressed together:

1. **Commentary disappears** — LLM narration text is wiped by `__RESET__` the moment tool cards appear, then re-rendered above all cards at once. Jarring.
2. **All text above all cards** — commentary and tool calls are stored separately (one flat text blob, one flat tool list), so everything renders in the wrong order: all text → all tools instead of text → tool → text → tool in the actual sequence they occurred.
3. **"Working..." text** — a blue dot + "Working..." appears when tools run with no text. Remove it.

The terminal log strip (fixed bottom panel for live shell output) is added on top of the fixed message flow.

---

## Iteration-Paired Message Model

### Type changes (`types.ts`)

```typescript
interface MessageIteration {
  text: string;          // LLM narration for this iteration (may be '')
  toolCalls: ToolCall[]; // tool calls dispatched after this text (may be [])
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;                      // kept: final concatenated text for copy + DB
  timestamp: string;
  toolCalls?: ToolCall[];               // kept for DB-loaded historical messages
  iterations?: MessageIteration[];      // renderer-only — NOT persisted to DB
  isStreaming?: boolean;
}
```

`iterations` is **ephemeral renderer state only** — it is never written to the database. On history reload, messages come back with `content` + `toolCalls` only (no `iterations`), and fall through to the existing flat rendering path. This is correct v1 behaviour.

---

## ChatPanel: New Live State

Replace:
```tsx
const streamBufferRef = useRef('');        // flat text blob
const toolCallsRef = useRef<ToolCall[]>([]); // flat tool list
```

With:
```tsx
interface LiveIteration {
  text: string;
  toolCalls: ToolCall[];
}
const iterationsRef = useRef<LiveIteration[]>([]);  // sealed iterations
const currentTextRef = useRef('');                   // text for current (unsealed) iteration
const currentToolsRef = useRef<ToolCall[]>([]);     // tools for current iteration
const routeToSealedRef = useRef(false);              // true = next tools go into iterationsRef[last]
```

---

## Event Handlers

### `onStreamText`

```
chunk arrives:
  if chunk includes '__RESET__':
    seal: iterationsRef.current.push({ text: currentTextRef.current, toolCalls: [] })
    currentTextRef.current = ''
    currentToolsRef.current = []
    routeToSealedRef.current = true   // next tools go into the just-sealed iteration
    scheduleStreamUpdate()
    return
  currentTextRef.current += chunk
  scheduleStreamUpdate()
```

### `onToolActivity`

`__RESET__` is only emitted when `iterationText` is non-empty (loop.ts: `if (iterationText) onStreamText?.('\n\n__RESET__')`). When the LLM emits tool calls with zero text, `__RESET__` is skipped and `onToolActivity` fires with no prior seal. The handler must handle both cases:

```
onToolActivity(activity):
  if activity.status === 'running':
    new tool = { id: tool-${Date.now()}-${random}, name, status: 'running', detail }

    if iterationsRef.current.length === 0:
      // First tool, no __RESET__ fired — silent tool call start
      // Seal an empty text iteration so we have a target to append to
      iterationsRef.current.push({ text: '', toolCalls: [] })

    // Use explicit flag to decide where this tool goes.
    // routeToSealedRef is set true by __RESET__ and cleared false after the
    // first tool is placed in the sealed iteration. This ensures ALL tools in
    // one batch go to the same target — avoids splitting a batch across
    // iterationsRef[last] and currentToolsRef on the second tool.
    if routeToSealedRef.current:
      iterationsRef.current[last].toolCalls.push(new tool)
      routeToSealedRef.current = false
    else:
      currentToolsRef.current.push(new tool)

    scheduleStreamUpdate()

  if activity.status === 'success' or 'error':
    updated tool = { id: fresh-id, name, status, detail, durationMs }
    // Find and update by name match in the last sealed iteration first, then current
    found = false
    for iter of [...iterationsRef.current].reverse():
      idx = iter.toolCalls.findLastIndex(t => t.name === name && t.status === 'running')
      if idx >= 0: iter.toolCalls[idx] = updated; found = true; break
    if !found:
      idx = currentToolsRef.current.findLastIndex(t => t.name === name && t.status === 'running')
      if idx >= 0: currentToolsRef.current[idx] = updated
    scheduleStreamUpdate()
```

Note: tool ids are not stable across running→success transitions (pre-existing). `handleRateTool` uses these ids — see Ratings section below.

### `flushStreamUpdate`

Build the live `iterations` array, filtering out empty trailing iterations:

```tsx
const inFlight: LiveIteration = { text: currentTextRef.current, toolCalls: [...currentToolsRef.current] };
const liveIterations: LiveIteration[] = [...iterationsRef.current];
// Only append in-flight if it has content
if (inFlight.text || inFlight.toolCalls.length > 0) {
  liveIterations.push(inFlight);
}

setMessages(prev => {
  const idx = prev.findIndex(m => m.id === assistantMsgIdRef.current);
  if (idx === -1) return prev;
  const updated = [...prev];
  updated[idx] = { ...updated[idx], iterations: liveIterations, isStreaming: true };
  return updated;
});
```

### `handleSend` reset

```tsx
iterationsRef.current = [];
currentTextRef.current = '';
currentToolsRef.current = [];
routeToSealedRef.current = false;
setStreamMap({});
```

### Stream-end finalization

```tsx
// content = ALL iteration texts concatenated (for copy button completeness)
const allText = [...iterationsRef.current, { text: currentTextRef.current }]
  .map(it => it.text).filter(Boolean).join('\n\n');
const finalContent = result.response || allText || '';
// finalTools = all tool calls across all iterations (for DB save compat)
const finalTools = iterationsRef.current.flatMap(it => it.toolCalls)
  .concat(currentToolsRef.current);

// Reconstruct final liveIterations (same filter logic as flushStreamUpdate)
const finalInFlight = { text: currentTextRef.current, toolCalls: [...currentToolsRef.current] };
const finalIterations = [...iterationsRef.current];
if (finalInFlight.text || finalInFlight.toolCalls.length > 0) finalIterations.push(finalInFlight);

setMessages(prev => prev.map(m =>
  m.id === assistantId
    ? { ...m, content: finalContent, toolCalls: finalTools, iterations: finalIterations, isStreaming: false }
    : m
));
```

---

## Tool Ratings

`handleRateTool` currently navigates `m.toolCalls` (the flat array). After this change, completed messages carry both:
- `m.toolCalls` — the flat final list (written at stream end, see above)
- `m.iterations[n].toolCalls` — the per-iteration copy

`handleRateTool` continues to work against `m.toolCalls` (the flat list). Ratings are stored to DB by the existing `api.chat.rateTool` call which uses `messageId` + `toolId` — this path is unchanged. The `iterations` array is renderer-only and not updated by ratings (acceptable for v1).

`AssistantMessage` reads tool ratings from the tool objects. During streaming, tools live in `iterations`. At stream end, `toolCalls` is written with the final tool objects including any ratings applied during streaming. Post-stream, ratings display correctly from `toolCalls` on the finalized message. During streaming, in-flight tools in `iterations` won't show rating UI (they have `isRunning` status — no rating affordance anyway). No regression.

---

## AssistantMessage Rendering

```tsx
function AssistantMessage({ message, streamMap }: { message: Message; streamMap?: ToolStreamMap }) {
  // Active streamMap only passed during streaming (from ChatPanel line 428 pattern)
  const activeStreamMap = message.isStreaming ? (streamMap ?? {}) : {};

  if (message.iterations && message.iterations.length > 0) {
    const iters = message.iterations;
    return (
      <div className="flex justify-start animate-slide-up group">
        <div className="max-w-[92%] px-1 py-2 text-text-primary">
          {iters.map((iter, i) => {
            const isLastIter = i === iters.length - 1;
            const hasText = !!iter.text;
            const hasTools = iter.toolCalls.length > 0;
            if (!hasText && !hasTools) return null; // skip empty in-flight iteration
            return (
              <div key={i} className={!isLastIter ? 'mb-3' : ''}>
                {hasText && (
                  <div className={hasTools ? 'mb-2' : ''}>
                    <MarkdownRenderer
                      content={iter.text}
                      isStreaming={message.isStreaming === true && isLastIter && !hasTools}
                    />
                  </div>
                )}
                {hasTools && (
                  <ToolActivity tools={iter.toolCalls} streamMap={activeStreamMap} />
                )}
              </div>
            );
          })}
          {!message.isStreaming && message.content && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] text-text-secondary/70">{message.timestamp}</span>
              <CopyButton text={message.content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Fallback: DB-loaded historical messages (no iterations field)
  const hasContent = !!message.content?.trim();
  const hasTools = !!message.toolCalls?.length;
  if (!hasContent && !hasTools) return null;
  return (
    <div className="flex justify-start animate-slide-up group">
      <div className="max-w-[92%] px-1 py-2 text-text-primary">
        {hasContent && <MarkdownRenderer content={message.content} isStreaming={false} />}
        {hasTools && <ToolActivity tools={message.toolCalls!} streamMap={{}} />}
        {hasContent && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[10px] text-text-secondary/70">{message.timestamp}</span>
            <CopyButton text={message.content} />
          </div>
        )}
      </div>
    </div>
  );
}
```

**Remove "Working..." block** entirely from `AssistantMessage`:
```tsx
// DELETE:
{isLive && hasTools && !hasContent && (
  <div className="mt-2">
    <div className="flex items-center gap-2 text-[12px] text-text-secondary/50">
      <div className="w-[6px] h-[6px] rounded-full bg-[#8ab4f8] animate-pulse" />
      Working...
    </div>
  </div>
)}
```

`StatusLine` (shimmer text) is **untouched**.

---

## Terminal Log Strip

### New: `TerminalLogStrip`

**File:** `src/renderer/components/TerminalLogStrip.tsx`

```typescript
interface TerminalLogStripProps {
  lines: string[];        // Object.values(streamMap).flat()
  isStreaming: boolean;
}
```

Behaviour:
- `isStreaming=true`: 72px live strip, auto-scroll to bottom on new lines
- `isStreaming=false`, `lines.length > 0`: collapsed "terminal log ⌄" row, click to expand (max 120px)
- `isStreaming=false`, `lines.length === 0`: render nothing
- Internal `useState<boolean>` for collapsed open/closed
- Root element className includes `terminal-log-strip` for scoped scrollbar

Line classification (first match wins):
1. Dim — `/^\[(?:LLM|stderr|Harness|Router|Agent|Install|Setup|Recall|Playbook)\]/i` → `rgba(255,255,255,0.25)`
2. Command — starts with `$` or `>` → `rgba(255,255,255,0.38)`
3. Output (default) → `rgba(255,255,255,0.72)`

**Render in ChatPanel** between scroll area and `InputBar`:
```tsx
const terminalLines = Object.values(streamMap).flat();
{(isStreaming || terminalLines.length > 0) && (
  <TerminalLogStrip lines={terminalLines} isStreaming={isStreaming} />
)}
```

### Scrollbar (scoped, `index.css`):
```css
.terminal-log-strip ::-webkit-scrollbar { width: 3px; }
.terminal-log-strip ::-webkit-scrollbar-track { background: transparent; }
.terminal-log-strip ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
.terminal-log-strip ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
```

### Visual spec

**Live (72px, 4 lines):**
```
border-top: 1px solid rgba(255,255,255,0.07) | bg: #080a0f
font: monospace 10.5px lh 1.55 | padding: 5px 14px
$ kdenlive --help                        ← rgba(255,255,255,0.38)
Usage: kdenlive [options] [files]        ← rgba(255,255,255,0.72)
[Harness] shell_exec: Directories…      ← rgba(255,255,255,0.25)
$ pip install -e . 2>&1                  (auto-scrolls)
```

**Collapsed (~28px):**
```
⌨ terminal log                       ⌄   cursor:pointer | chevron rotates 180° open
rgba(255,255,255,0.32) | 10.5px monospace
```

**Expanded (max 120px scrollable):** same monochrome text, 3px scrollbar.

---

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `MessageIteration` interface; add `iterations?: MessageIteration[]` to `Message` |
| `src/renderer/components/ChatPanel.tsx` | Replace flat text/tool refs with iteration model; fix all event handlers; remove "Working..."; derive `terminalLines`; render `TerminalLogStrip` |
| `src/renderer/components/TerminalLogStrip.tsx` | **New** — live + collapsed strip |
| `src/renderer/index.css` | Add `.terminal-log-strip` scoped scrollbar rules |

**Not changed:** `ToolActivity.tsx` (no changes needed), DB layer (iterations not persisted), `handleRateTool` (continues to use flat `toolCalls`).

---

## Success Criteria

- LLM narration text persists — it does not disappear when tool cards appear
- Each LLM iteration renders as: narration text → tool cards, in sequence
- Multiple iterations render: text → cards → text → cards
- "Working..." blue dot is removed
- `StatusLine` shimmer is unchanged
- Terminal strip visible during streaming (~72px, auto-scrolls, monochrome)
- Strip collapses to "terminal log ⌄" after streaming; click to expand
- No green text; scrollbar 3px monochrome, scoped to strip only
- Historical messages (no `iterations`) render correctly via fallback
- Tool ratings continue to work (against flat `toolCalls` on completed messages)
